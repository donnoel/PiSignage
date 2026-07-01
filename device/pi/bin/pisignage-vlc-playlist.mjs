#!/usr/bin/env node
import { constants as fsConstants, existsSync } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function defaultRepoRoot() {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, "sample-content", "playlist.local.json"))) {
    return cwd;
  }

  const homeCheckout = path.join(process.env.HOME ?? "", "PiSignage");
  if (existsSync(path.join(homeCheckout, "sample-content", "playlist.local.json"))) {
    return homeCheckout;
  }

  return cwd;
}

const repoRoot = path.resolve(process.env.PISIGNAGE_REPO_ROOT ?? defaultRepoRoot());
const contentRoot = path.resolve(
  repoRoot,
  process.env.PISIGNAGE_CONTENT_ROOT ?? "sample-content"
);
const playlistPath = path.resolve(
  contentRoot,
  process.env.PISIGNAGE_PLAYLIST_FILE ?? "playlist.local.json"
);
const vlcBinary = process.env.PISIGNAGE_VLC_BIN ?? "/usr/bin/cvlc";
const displayOutput = process.env.PISIGNAGE_DISPLAY_OUTPUT ?? "HDMI-A-1";
const displayMode = process.env.PISIGNAGE_DISPLAY_RESOLUTION ?? "1920x1080@60.000000";
const vlcVideoOutput = process.env.PISIGNAGE_VLC_VIDEO_OUTPUT ?? "wl_shm";
const vlcAvcodecHardware = process.env.PISIGNAGE_VLC_AVCODEC_HW?.trim() ?? "";
const vlcAudioMode = process.env.PISIGNAGE_VLC_AUDIO?.trim() ?? "on";
const vlcWaylandDisplay =
  process.env.PISIGNAGE_VLC_WAYLAND_DISPLAY ?? process.env.WAYLAND_DISPLAY ?? "wayland-0";
const statusPath = path.resolve(
  process.env.PISIGNAGE_STATUS_PATH ??
    path.join(process.env.HOME ?? repoRoot, ".local/state/pisignage/player-status.json")
);
const displayReadyTimeoutMs = Number.parseInt(
  process.env.PISIGNAGE_DISPLAY_READY_TIMEOUT_MS ?? "60000",
  10
);
const startupSettleMs = Number.parseInt(process.env.PISIGNAGE_STARTUP_SETTLE_MS ?? "8000", 10);
const playlistPollIntervalMs = Number.parseInt(
  process.env.PISIGNAGE_PLAYLIST_POLL_INTERVAL_MS ?? "5000",
  10
);
const playlistHandoffOverlapMs = Number.parseInt(
  process.env.PISIGNAGE_PLAYLIST_HANDOFF_OVERLAP_MS ?? "2500",
  10
);
const playlistPlaybackMode = process.env.PISIGNAGE_VLC_PLAYBACK_MODE ?? "continuous";
const continuousRestartBackoffBaseMs = Number.parseInt(
  process.env.PISIGNAGE_VLC_RESTART_BACKOFF_MS ?? "15000",
  10
);
const continuousRestartBackoffMaxMs = Number.parseInt(
  process.env.PISIGNAGE_VLC_RESTART_BACKOFF_MAX_MS ?? "120000",
  10
);
const vlcStopSignal = process.env.PISIGNAGE_VLC_STOP_SIGNAL ?? "SIGKILL";
const statusHeartbeatIntervalMs = Number.parseInt(
  process.env.PISIGNAGE_STATUS_HEARTBEAT_INTERVAL_MS ?? "15000",
  10
);
const dryRun = process.argv.includes("--dry-run");
const assetQuarantineWindowMs = Number.parseInt(
  process.env.PISIGNAGE_ASSET_QUARANTINE_WINDOW_MS ?? "300000",
  10
);
const readyScreenPath = path.resolve(
  process.env.PISIGNAGE_READY_SCREEN_PATH ??
    path.join(process.env.HOME ?? repoRoot, ".local/state/pisignage/ready-screen.mp4")
);
const readyScreenTextPath = path.resolve(
  process.env.PISIGNAGE_READY_SCREEN_TEXT_PATH ??
    path.join(process.env.HOME ?? repoRoot, ".local/state/pisignage/ready-screen.txt")
);
const readyScreenFramePath = path.resolve(
  process.env.PISIGNAGE_READY_SCREEN_FRAME_PATH ??
    path.join(process.env.HOME ?? repoRoot, ".local/state/pisignage/ready-screen.ppm")
);
const readyScreenLogoPath = path.resolve(
  process.env.PISIGNAGE_READY_SCREEN_LOGO_PATH ??
    path.join(repoRoot, "device/pi/assets/ad-dad-logo.png")
);
const readyScreenLogoPpmPath = path.resolve(
  process.env.PISIGNAGE_READY_SCREEN_LOGO_PPM_PATH ??
    path.join(repoRoot, "device/pi/assets/ad-dad-logo.ppm")
);
const readyScreenDurationSeconds = Number.parseInt(
  process.env.PISIGNAGE_READY_SCREEN_DURATION_SECONDS ?? "10",
  10
);
const internetPingTarget = process.env.PISIGNAGE_READY_SCREEN_PING_TARGET ?? "1.1.1.1";
const renderReadyScreenOnly = process.argv.includes("--render-ready-screen");

let stopping = false;
const activePlayers = new Set();
let lastLoadedPlaylistSignature = null;
const assetQuarantine = new Map();
let activeStatus = {
  mode: "vlc",
  state: "starting",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  playlistPath,
  statusPath,
  displayOutput,
  displayMode,
  vlcAudioMode,
  vlcAvcodecHardware,
  playlistPlaybackMode,
  vlcVideoOutput,
  vlcWaylandDisplay,
  playlistId: null,
  playlistVersion: null,
  assetCount: 0,
  assetIds: [],
  quarantinedAssetIds: [],
  lastError: null
};

class StandbyPlaylistError extends Error {
  constructor(message, metadata = {}) {
    super(message);
    this.name = "StandbyPlaylistError";
    this.metadata = metadata;
  }
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function fail(message) {
  console.error(`${new Date().toISOString()} ${message}`);
  process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function captureCommand(command, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code, signal });
    });
  });
}

async function waitWithPlaylistPolling(playlist, ms) {
  const deadline = Date.now() + Math.max(ms, 0);
  while (!stopping) {
    if (await playlistHasChanged(playlist)) {
      return { reloadRequested: true };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { reloadRequested: false };
    }

    await sleep(Math.min(remainingMs, Math.max(Math.min(playlistPollIntervalMs, 1_000), 250)));
  }
  return { reloadRequested: false };
}

async function waitPlaybackWindow(playlist, ms, pendingPlaylistReload) {
  if (pendingPlaylistReload) {
    await sleep(Math.max(ms, 0));
    return { reloadRequested: false };
  }

  return waitWithPlaylistPolling(playlist, ms);
}

function playlistSignature(rawPlaylist) {
  return createHash("sha256").update(rawPlaylist).digest("hex");
}

function playlistDurationMs(playlist) {
  return playlist.assets.reduce((total, asset) => {
    const durationSeconds = Number.isFinite(asset.durationSeconds) && asset.durationSeconds > 0
      ? asset.durationSeconds
      : 30;
    return total + Math.max(Math.round(durationSeconds * 1000), 1_000);
  }, 0);
}

function millisecondsUntilPlaylistBoundary(playlist, loopStartedAtMs) {
  const durationMs = playlistDurationMs(playlist);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 1_000;
  }

  const elapsedMs = Math.max(Date.now() - loopStartedAtMs, 0);
  const remainingMs = durationMs - (elapsedMs % durationMs);
  const minimumLeadMs = Math.max(Math.min(playlistHandoffOverlapMs, durationMs), 1_000);
  return remainingMs < minimumLeadMs ? remainingMs + durationMs : remainingMs;
}

function continuousRestartBackoffMs(attempt) {
  const baseMs = Number.isFinite(continuousRestartBackoffBaseMs)
    ? Math.max(continuousRestartBackoffBaseMs, 1_000)
    : 15_000;
  const maxMs = Number.isFinite(continuousRestartBackoffMaxMs)
    ? Math.max(continuousRestartBackoffMaxMs, baseMs)
    : 120_000;
  const exponent = Math.min(Math.max(attempt - 1, 0), 6);
  return Math.min(baseMs * (2 ** exponent), maxMs);
}

async function writeStatus(update) {
  activeStatus = {
    ...activeStatus,
    ...update,
    updatedAt: new Date().toISOString()
  };

  const statusDirectory = path.dirname(statusPath);
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  await mkdir(statusDirectory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(activeStatus, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statusPath);
}

function playlistAssetPath(asset) {
  const uri = asset?.uri;
  if (typeof uri !== "string" || uri.trim() === "") {
    return null;
  }

  const normalizedPath = path.posix.normalize(`/${uri}`).replace(/^\/+/, "");
  const resolvedPath = path.resolve(contentRoot, normalizedPath);
  if (resolvedPath !== contentRoot && !resolvedPath.startsWith(`${contentRoot}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

function quarantineKey(asset) {
  return `${asset.assetId}|${asset.path}`;
}

function activeQuarantineEntry(asset) {
  const entry = assetQuarantine.get(quarantineKey(asset));
  if (!entry) {
    return null;
  }
  if (Date.now() >= entry.untilMs) {
    assetQuarantine.delete(quarantineKey(asset));
    return null;
  }
  return entry;
}

function quarantineAsset(asset, reason) {
  const now = Date.now();
  const entry = {
    assetId: asset.assetId,
    path: asset.path,
    reason,
    quarantinedAt: new Date(now).toISOString(),
    untilMs: now + Math.max(assetQuarantineWindowMs, 1_000)
  };
  assetQuarantine.set(quarantineKey(asset), entry);
  log(`quarantining asset ${asset.assetId}: ${reason}`);
}

function quarantinedAssetStatusList() {
  const now = Date.now();
  const items = [];
  for (const entry of assetQuarantine.values()) {
    if (entry.untilMs <= now) {
      continue;
    }
    items.push({
      assetId: entry.assetId,
      path: entry.path,
      reason: entry.reason,
      quarantinedAt: entry.quarantinedAt,
      quarantineEndsAt: new Date(entry.untilMs).toISOString()
    });
  }
  return items;
}

async function writePlaybackStatus(playlist, state, extra = {}) {
  const quarantinedAssets = quarantinedAssetStatusList();
  await writeStatus({
    state,
    playlistId: playlist.playlistId,
    playlistVersion: playlist.version,
    assetCount: playlist.assets.length,
    assetIds: playlist.assets.map((asset) => asset.assetId),
    quarantinedAssets,
    quarantinedAssetIds: quarantinedAssets.map((entry) => entry.assetId),
    ...extra
  });
}

function isFirstRunFallbackPlaylist(playlist) {
  const assets = Array.isArray(playlist?.assets) ? playlist.assets : [];
  return (
    playlist?.playlistId === "playlist-first-run-fallback" ||
    assets.some((asset) => asset?.assetId === "asset-beam-ready-fallback")
  );
}

function localIpAddressFallback() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return "Not assigned";
}

async function defaultRouteDetails() {
  const route = await captureCommand("ip", ["route", "get", internetPingTarget], 2500);
  const routeText = route.stdout.trim();
  const sourceMatch = routeText.match(/\bsrc\s+(\S+)/);
  const gatewayMatch = routeText.match(/\bvia\s+(\S+)/);
  if (route.ok && (sourceMatch || gatewayMatch)) {
    return {
      ipAddress: sourceMatch?.[1] ?? localIpAddressFallback(),
      gateway: gatewayMatch?.[1] ?? "Direct route"
    };
  }

  const defaultRoute = await captureCommand("ip", ["route", "show", "default"], 2500);
  const defaultText = defaultRoute.stdout.trim();
  const defaultGatewayMatch = defaultText.match(/\bvia\s+(\S+)/);
  return {
    ipAddress: localIpAddressFallback(),
    gateway: defaultGatewayMatch?.[1] ?? "Not detected"
  };
}

async function readDeviceConfig() {
  const configPath = path.join(process.env.HOME ?? "", ".config/pisignage/device.json");
  if (!configPath.startsWith(path.sep)) {
    return {};
  }

  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

async function internetStatus() {
  const ping = await captureCommand("ping", ["-c", "1", "-W", "2", internetPingTarget], 3500);
  return ping.ok ? "connected" : "not connected";
}

async function collectReadyScreenDetails(reason) {
  const [route, config, internet] = await Promise.all([
    defaultRouteDetails(),
    readDeviceConfig(),
    internetStatus()
  ]);
  const hostname = os.hostname();
  const deviceId =
    process.env.PISIGNAGE_DEVICE_ID ??
    (typeof config.deviceId === "string" && config.deviceId.trim() ? config.deviceId.trim() : null);
  const deviceName = process.env.PISIGNAGE_DEVICE_NAME ?? hostname;

  return {
    generatedAt: new Date().toISOString(),
    deviceName,
    deviceId,
    hostname,
    ipAddress: route.ipAddress,
    gateway: route.gateway,
    internet,
    readyForPublishing: true,
    reason
  };
}

function readyScreenNetworkScore(details) {
  let score = 0;
  if (details.ipAddress !== "Not assigned") {
    score += 1;
  }
  if (details.gateway !== "Not detected") {
    score += 1;
  }
  if (details.internet === "connected") {
    score += 1;
  }
  return score;
}

function shouldRefreshReadyScreenDetails(currentDetails, nextDetails) {
  const currentScore = readyScreenNetworkScore(currentDetails);
  const nextScore = readyScreenNetworkScore(nextDetails);
  return (
    nextScore > currentScore ||
    (nextDetails.ipAddress !== "Not assigned" && nextDetails.ipAddress !== currentDetails.ipAddress) ||
    (nextDetails.gateway !== "Not detected" && nextDetails.gateway !== currentDetails.gateway)
  );
}

function firstExistingPath(paths) {
  return paths.find((candidate) => {
    try {
      return candidate && existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function ffmpegBinaryCandidates() {
  if (process.env.PISIGNAGE_FFMPEG_BIN) {
    return [process.env.PISIGNAGE_FFMPEG_BIN];
  }
  return ["/usr/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "ffmpeg"];
}

function safeReadyText(value) {
  return String(value ?? "Not detected").replace(/[\r\n]+/g, " ").trim();
}

const bitmapGlyphs = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  "J": ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"]
};

function readyScreenDuration() {
  return Number.isFinite(readyScreenDurationSeconds)
    ? Math.max(readyScreenDurationSeconds, 5)
    : 30;
}

function fitReadyLine(value, maxLength = 35) {
  const upper = safeReadyText(value).toUpperCase();
  return upper.length > maxLength ? `${upper.slice(0, maxLength - 3)}...` : upper;
}

function blendPixel(buffer, width, height, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }
  const offset = (y * width + x) * 3;
  const inverse = 1 - alpha;
  buffer[offset] = Math.round(buffer[offset] * inverse + color[0] * alpha);
  buffer[offset + 1] = Math.round(buffer[offset + 1] * inverse + color[1] * alpha);
  buffer[offset + 2] = Math.round(buffer[offset + 2] * inverse + color[2] * alpha);
}

function fillRect(buffer, width, height, x, y, rectWidth, rectHeight, color, alpha = 1) {
  for (let row = 0; row < rectHeight; row += 1) {
    for (let col = 0; col < rectWidth; col += 1) {
      blendPixel(buffer, width, height, x + col, y + row, color, alpha);
    }
  }
}

function strokeRect(buffer, width, height, x, y, rectWidth, rectHeight, color, thickness = 4) {
  fillRect(buffer, width, height, x, y, rectWidth, thickness, color);
  fillRect(buffer, width, height, x, y + rectHeight - thickness, rectWidth, thickness, color);
  fillRect(buffer, width, height, x, y, thickness, rectHeight, color);
  fillRect(buffer, width, height, x + rectWidth - thickness, y, thickness, rectHeight, color);
}

function drawText(buffer, width, height, text, x, y, scale, color, spacing = scale) {
  let cursorX = x;
  for (const character of fitReadyLine(text, 80).toUpperCase()) {
    const glyph = bitmapGlyphs[character] ?? bitmapGlyphs[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] !== "1") {
          continue;
        }
        fillRect(buffer, width, height, cursorX + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cursorX += glyph[0].length * scale + spacing;
  }
}

function parsePpm(buffer) {
  let offset = 0;
  const tokens = [];
  while (tokens.length < 4 && offset < buffer.length) {
    while (/\s/.test(String.fromCharCode(buffer[offset] ?? 32))) {
      offset += 1;
    }
    if (buffer[offset] === 35) {
      while (offset < buffer.length && buffer[offset] !== 10) {
        offset += 1;
      }
      continue;
    }
    const start = offset;
    while (offset < buffer.length && !/\s/.test(String.fromCharCode(buffer[offset]))) {
      offset += 1;
    }
    tokens.push(buffer.subarray(start, offset).toString("ascii"));
  }
  while (/\s/.test(String.fromCharCode(buffer[offset] ?? 32))) {
    offset += 1;
  }
  if (tokens[0] !== "P6") {
    throw new Error(`Unsupported logo PPM format: ${tokens[0] ?? "unknown"}`);
  }
  const width = Number.parseInt(tokens[1], 10);
  const height = Number.parseInt(tokens[2], 10);
  const max = Number.parseInt(tokens[3], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || max !== 255) {
    throw new Error("Unsupported logo PPM dimensions or color depth.");
  }
  return {
    width,
    height,
    pixels: buffer.subarray(offset, offset + width * height * 3)
  };
}

function overlayPpm(target, width, height, logo, x, y) {
  for (let row = 0; row < logo.height; row += 1) {
    for (let col = 0; col < logo.width; col += 1) {
      const sourceOffset = (row * logo.width + col) * 3;
      blendPixel(target, width, height, x + col, y + row, [
        logo.pixels[sourceOffset],
        logo.pixels[sourceOffset + 1],
        logo.pixels[sourceOffset + 2]
      ]);
    }
  }
}

async function renderReadyScreenFrame(details) {
  const width = 1920;
  const height = 1080;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const xRatio = x / width;
      const yRatio = y / height;
      pixels[offset] = Math.round(9 + 22 * xRatio + 9 * yRatio);
      pixels[offset + 1] = Math.round(28 + 18 * yRatio + 5 * xRatio);
      pixels[offset + 2] = Math.round(56 + 42 * xRatio + 18 * yRatio);
    }
  }

  const logo = parsePpm(await readFile(readyScreenLogoPpmPath));
  overlayPpm(pixels, width, height, logo, 68, 58);
  fillRect(pixels, width, height, 500, 285, 920, 530, [6, 24, 45], 0.68);
  strokeRect(pixels, width, height, 500, 285, 920, 530, [255, 138, 0], 4);
  drawText(pixels, width, height, "BEAM DEVICE READY", 585, 348, 8, [255, 255, 255], 8);

  const lines = [
    `HOSTNAME: ${details.hostname}`,
    `IP ADDRESS: ${details.ipAddress}`,
    `GATEWAY: ${details.gateway}`,
    `INTERNET: ${details.internet}`,
    "STATUS: READY FOR PUBLISHING"
  ];
  lines.forEach((line, index) => {
    const color = index === lines.length - 1 ? [255, 179, 90] : [255, 255, 255];
    drawText(pixels, width, height, fitReadyLine(line), 585, 430 + index * 58, 4, color, 4);
  });

  await mkdir(path.dirname(readyScreenFramePath), { recursive: true });
  await writeFile(readyScreenFramePath, Buffer.concat([
    Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii"),
    pixels
  ]));
  return readyScreenFramePath;
}

async function writeReadyScreenText(details) {
  const lines = [
    `Device name: ${safeReadyText(details.deviceName)}`,
    `Device ID: ${safeReadyText(details.deviceId ?? "Not paired yet")}`,
    `Hostname: ${safeReadyText(details.hostname)}`,
    `IP address: ${safeReadyText(details.ipAddress)}`,
    `Gateway: ${safeReadyText(details.gateway)}`,
    `Internet: ${safeReadyText(details.internet)}`,
    "Status: ready for publishing"
  ];
  await mkdir(path.dirname(readyScreenTextPath), { recursive: true });
  await writeFile(readyScreenTextPath, `${lines.join("\n")}\n`, "utf8");
}

async function generateReadyScreenVideo(details) {
  await access(readyScreenLogoPath, fsConstants.R_OK);
  await access(readyScreenLogoPpmPath, fsConstants.R_OK);
  await writeReadyScreenText(details);
  const ffmpegBinary = firstExistingPath(ffmpegBinaryCandidates()) ?? "ffmpeg";
  const framePath = await renderReadyScreenFrame(details);
  const duration = readyScreenDuration();
  const temporaryPath = `${readyScreenPath}.${process.pid}.tmp.mp4`;
  await mkdir(path.dirname(readyScreenPath), { recursive: true });

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-i",
    framePath,
    "-t",
    String(duration),
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "stillimage",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    temporaryPath
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg ready-screen render failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });

  await rename(temporaryPath, readyScreenPath);
  return readyScreenPath;
}

async function standbyVideoAsset(details) {
  try {
    const generatedPath = await generateReadyScreenVideo(details);
    return {
      assetId: "asset-beam-ready-for-publishing",
      path: generatedPath,
      type: "video",
      durationSeconds: readyScreenDuration(),
      generated: true,
      renderError: null
    };
  } catch (error) {
    const fallbackPath = path.join(contentRoot, "assets/beam-ready.signage-1080p.mp4");
    await access(fallbackPath, fsConstants.R_OK);
    return {
      assetId: "asset-beam-ready-fallback",
      path: fallbackPath,
      type: "video",
      durationSeconds: 10,
      generated: false,
      renderError: error instanceof Error ? error.message : String(error)
    };
  }
}

async function waitForPublishedPlaylist(timeoutMs) {
  const deadline = Date.now() + Math.max(timeoutMs, 1_000);
  let lastError = null;
  while (!stopping && Date.now() < deadline) {
    try {
      const playlist = await playableAssetsFromPlaylist();
      return { state: "ready", playlist };
    } catch (error) {
      lastError = error;
      if (!(error instanceof StandbyPlaylistError)) {
        log(`published playlist check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await sleep(Math.min(Math.max(playlistPollIntervalMs, 1_000), Math.max(deadline - Date.now(), 250)));
  }
  return { state: "waiting", lastError };
}

async function playableAssetsFromPlaylist() {
  let rawPlaylist;
  try {
    rawPlaylist = await readFile(playlistPath, "utf8");
  } catch (error) {
    throw new StandbyPlaylistError(`Playlist file is not ready: ${playlistPath}`, {
      playlistPath,
      lastError: error instanceof Error ? error.message : String(error)
    });
  }

  const playlist = JSON.parse(rawPlaylist);
  const assets = Array.isArray(playlist.assets) ? playlist.assets : [];
  const playableAssets = [];
  const signature = playlistSignature(rawPlaylist);

  if (isFirstRunFallbackPlaylist(playlist)) {
    throw new StandbyPlaylistError("First-run fallback playlist is waiting for a publish.", {
      playlistId: playlist.playlistId ?? "playlist-first-run-fallback",
      playlistVersion: playlist.version ?? "unknown",
      assetCount: assets.length,
      signature
    });
  }

  for (const asset of assets) {
    if (asset?.type !== "video") {
      if (asset?.type === "image") {
        log(`skipping raw image asset ${asset?.assetId ?? "unknown asset"}; dashboard should publish still clips as MP4`);
      }
      continue;
    }

    const assetPath = playlistAssetPath(asset);
    if (!assetPath) {
      const assetId = asset?.assetId ?? "unknown asset";
      quarantineAsset(
        { assetId, path: String(asset?.uri ?? "") },
        `invalid ${asset?.type ?? "media"} asset path`
      );
      continue;
    }

    const playableAsset = {
      assetId: asset.assetId ?? path.basename(assetPath),
      path: assetPath,
      type: asset.type,
      durationSeconds:
        Number.isFinite(asset.durationSeconds) && asset.durationSeconds > 0
          ? asset.durationSeconds
          : 30
    };
    if (activeQuarantineEntry(playableAsset)) {
      log(`skipping quarantined asset ${playableAsset.assetId}`);
      continue;
    }

    try {
      await access(assetPath, fsConstants.R_OK);
    } catch (error) {
      quarantineAsset(
        playableAsset,
        `media file is unreadable: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    playableAssets.push(playableAsset);
  }

  if (playableAssets.length === 0) {
    throw new StandbyPlaylistError(`No playable media assets found in ${playlistPath}`, {
      playlistId: playlist.playlistId ?? "local-playlist",
      playlistVersion: playlist.version ?? "unknown",
      assetCount: assets.length,
      signature
    });
  }

  return {
    playlistId: playlist.playlistId ?? "local-playlist",
    version: playlist.version ?? "unknown",
    assets: playableAssets,
    signature
  };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"} signal ${signal ?? "none"}`));
    });
  });
}

async function configureDisplay() {
  try {
    await access("/usr/bin/wlr-randr", fsConstants.X_OK);
  } catch {
    log("wlr-randr unavailable; skipping display mode check");
    return true;
  }

  try {
    await runCommand("/usr/bin/wlr-randr", ["--output", displayOutput, "--mode", displayMode]);
    log(`display set to ${displayOutput} ${displayMode}`);
    return true;
  } catch (error) {
    log(`display mode check failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function waitForDisplay() {
  const deadline = Date.now() + displayReadyTimeoutMs;

  while (!stopping) {
    if (await configureDisplay()) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Display ${displayOutput} was not ready within ${displayReadyTimeoutMs}ms`);
    }

    await sleep(2_000);
  }
}

async function playlistHasChanged(playlist) {
  const rawPlaylist = await readFile(playlistPath, "utf8");
  return playlistSignature(rawPlaylist) !== playlist.signature;
}

function vlcBaseArgs() {
  const waylandArgs = vlcVideoOutput.startsWith("wl_")
    ? ["--wl-display", vlcWaylandDisplay]
    : [];
  const hardwareArgs = vlcAvcodecHardware ? ["--avcodec-hw", vlcAvcodecHardware] : [];
  const audioArgs = vlcAudioMode === "off" ? ["--no-audio"] : [];

  return [
    ...hardwareArgs,
    ...audioArgs,
    "-V",
    vlcVideoOutput,
    ...waylandArgs,
    "--fullscreen",
    "--video-on-top",
    "--no-video-deco",
    "--loop",
    "--no-video-title-show",
    "--quiet",
    "--drm-vout-display",
    displayOutput
  ];
}

function vlcArgsForAsset(asset) {
  return [...vlcBaseArgs(), asset.path];
}

function vlcArgsForPlaylist(playlist) {
  return [...vlcBaseArgs(), ...playlist.assets.map((asset) => asset.path)];
}

function startPlayer(args, asset = null) {
  const child = spawn(vlcBinary, args, {
    stdio: "inherit"
  });

  const handle = {
    asset,
    child,
    stoppedBySupervisor: false,
    exited: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        activePlayers.delete(handle);
        resolve({ code, signal });
      });
    })
  };

  activePlayers.add(handle);
  return handle;
}

function startAssetPlayer(asset) {
  return startPlayer(vlcArgsForAsset(asset), asset);
}

function startPlaylistPlayer(playlist) {
  return startPlayer(vlcArgsForPlaylist(playlist));
}

function stopAssetPlayer(handle) {
  if (!handle || handle.child.killed) {
    return;
  }
  handle.stoppedBySupervisor = true;
  handle.child.kill(vlcStopSignal);
}

function stopAllPlayers() {
  for (const handle of activePlayers) {
    stopAssetPlayer(handle);
  }
}

function isExpectedPlayerExit(handle, exit) {
  return (
    stopping ||
    handle.stoppedBySupervisor ||
    exit.code === 0 ||
    exit.signal === vlcStopSignal ||
    exit.signal === "SIGTERM" ||
    exit.signal === "SIGINT"
  );
}

async function writePlayingAssetStatus(playlist, asset, extra = {}) {
  await writePlaybackStatus(playlist, "playing", {
    currentAssetId: asset.assetId,
    currentAssetPath: asset.path,
    currentAssetDurationSeconds: asset.durationSeconds,
    readyScreen: null,
    lastError: null,
    ...extra
  });
}

async function loadPendingPlaylist(currentPlaylist) {
  try {
    const pendingPlaylist = await playableAssetsFromPlaylist();
    if (pendingPlaylist.signature === currentPlaylist.signature) {
      return { state: "unchanged" };
    }

    return { state: "ready", playlist: pendingPlaylist };
  } catch (error) {
    const message = `pending playlist is not ready: ${error instanceof Error ? error.message : String(error)}`;
    log(message);
    await writePlaybackStatus(currentPlaylist, "degraded", {
      lastError: message,
      pendingPlaylistReload: true
    });
    return { state: "failed" };
  }
}

async function writeContinuousPlaybackStatus(playlist, extra = {}) {
  await writePlaybackStatus(playlist, "playing", {
    currentAssetId: null,
    currentAssetPath: null,
    currentAssetDurationSeconds: null,
    readyScreen: null,
    lastError: null,
    ...extra
  });
}

async function playPlaylist(playlist) {
  log(`playing playlist with ${playlist.assets.length} media asset(s)`);
  let statusHeartbeatTimer;
  let activePlaylist = playlist;
  let currentIndex = 0;
  let currentAsset = activePlaylist.assets[currentIndex];
  let pendingPlaylistReload = false;
  log(`playing asset ${currentAsset.assetId} for ${currentAsset.durationSeconds}s`);
  await writePlayingAssetStatus(activePlaylist, currentAsset, { pendingPlaylistReload });
  let currentPlayer = startAssetPlayer(currentAsset);

  if (statusHeartbeatIntervalMs > 0) {
    statusHeartbeatTimer = setInterval(() => {
      writePlayingAssetStatus(activePlaylist, currentAsset, { pendingPlaylistReload }).catch((error) => {
        log(`status heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, statusHeartbeatIntervalMs);
  }

  try {
    while (!stopping) {
      const currentDurationMs = Math.max(Math.round(currentAsset.durationSeconds * 1000), 1_000);
      const overlapMs =
        activePlaylist.assets.length > 1
          ? Math.min(Math.max(playlistHandoffOverlapMs, 0), Math.max(currentDurationMs - 1_000, 0))
          : 0;
      const displayMs = Math.max(currentDurationMs - overlapMs, 1_000);

      const playbackResult = await Promise.race([
        waitPlaybackWindow(activePlaylist, displayMs, pendingPlaylistReload),
        currentPlayer.exited.then((exit) => ({ exit }))
      ]);

      if (playbackResult.reloadRequested) {
        pendingPlaylistReload = true;
        log("playlist changed; staging reload for the next playlist boundary");
        await writePlayingAssetStatus(activePlaylist, currentAsset, { pendingPlaylistReload });
      }

      if (playbackResult.exit && !isExpectedPlayerExit(currentPlayer, playbackResult.exit)) {
        const message = `VLC exited with code ${
          playbackResult.exit.code ?? "unknown"
        } signal ${playbackResult.exit.signal ?? "none"}`;
        quarantineAsset(currentAsset, message);
        await writePlaybackStatus(activePlaylist, "degraded", {
          currentAssetId: currentAsset.assetId,
          currentAssetPath: currentAsset.path,
          currentAssetDurationSeconds: currentAsset.durationSeconds,
          lastError: message,
          pendingPlaylistReload
        });
      }

      let nextIndex = currentIndex;
      let nextAsset = currentAsset;
      for (let offset = 1; offset <= activePlaylist.assets.length; offset += 1) {
        const candidateIndex = (currentIndex + offset) % activePlaylist.assets.length;
        const candidateAsset = activePlaylist.assets[candidateIndex];
        if (!activeQuarantineEntry(candidateAsset)) {
          nextIndex = candidateIndex;
          nextAsset = candidateAsset;
          break;
        }
      }

      if (activeQuarantineEntry(nextAsset)) {
        throw new Error(`No playable media assets remain in ${playlistPath}`);
      }

      const reachedPlaylistBoundary = nextIndex <= currentIndex;
      if (pendingPlaylistReload && reachedPlaylistBoundary) {
        const pending = await loadPendingPlaylist(activePlaylist);
        if (pending.state === "ready") {
          const previousPlayer = currentPlayer;
          const previousAsset = currentAsset;
          activePlaylist = pending.playlist;
          assetQuarantine.clear();
          lastLoadedPlaylistSignature = activePlaylist.signature;
          currentIndex = 0;
          currentAsset = activePlaylist.assets[currentIndex];
          pendingPlaylistReload = false;
          log(
            `handoff at playlist boundary from ${previousAsset.assetId} to ${currentAsset.assetId} in ${activePlaylist.playlistId} version ${activePlaylist.version}`
          );
          currentPlayer = startAssetPlayer(currentAsset);
          await writePlayingAssetStatus(activePlaylist, currentAsset, { pendingPlaylistReload });
          stopAssetPlayer(previousPlayer);
          previousPlayer.exited.catch((error) => {
            log(`previous VLC exit check failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          continue;
        }

        if (pending.state === "unchanged") {
          pendingPlaylistReload = false;
          await writePlayingAssetStatus(activePlaylist, currentAsset, { pendingPlaylistReload });
        }
      }

      if (activePlaylist.assets.length === 1) {
        continue;
      }

      const previousPlayer = currentPlayer;
      const previousAsset = currentAsset;
      log(`starting next asset ${nextAsset.assetId} before stopping ${previousAsset.assetId}`);
      const nextPlayer = startAssetPlayer(nextAsset);
      currentIndex = nextIndex;
      currentAsset = nextAsset;
      currentPlayer = nextPlayer;
      await writePlayingAssetStatus(activePlaylist, nextAsset, { pendingPlaylistReload });

      const overlapResult = await waitPlaybackWindow(activePlaylist, overlapMs, pendingPlaylistReload);
      if (overlapResult.reloadRequested) {
        pendingPlaylistReload = true;
        log("playlist changed during handoff overlap; staging reload for the next playlist boundary");
        await writePlayingAssetStatus(activePlaylist, currentAsset, { pendingPlaylistReload });
      }

      stopAssetPlayer(previousPlayer);
      previousPlayer.exited.catch((error) => {
        log(`previous VLC exit check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } finally {
    clearInterval(statusHeartbeatTimer);
    stopAllPlayers();
  }
}

async function playPlaylistContinuously(playlist) {
  log(`playing playlist continuously with ${playlist.assets.length} media asset(s)`);
  let statusHeartbeatTimer;
  let activePlaylist = playlist;
  let loopStartedAtMs = Date.now();
  let pendingPlaylistReload = false;
  let continuousRestartAttempt = 0;
  let continuousRetryStatus = null;
  await writeContinuousPlaybackStatus(activePlaylist, { pendingPlaylistReload });
  let player = startPlaylistPlayer(activePlaylist);

  if (statusHeartbeatIntervalMs > 0) {
    statusHeartbeatTimer = setInterval(() => {
      const statusWrite = continuousRetryStatus
        ? writePlaybackStatus(activePlaylist, "degraded", {
            ...continuousRetryStatus,
            pendingPlaylistReload
          })
        : writeContinuousPlaybackStatus(activePlaylist, { pendingPlaylistReload });
      statusWrite.catch((error) => {
        log(`status heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, statusHeartbeatIntervalMs);
  }

  try {
    while (!stopping) {
      const waitMs = pendingPlaylistReload
        ? millisecondsUntilPlaylistBoundary(activePlaylist, loopStartedAtMs)
        : playlistPollIntervalMs;
      const playbackResult = await Promise.race([
        pendingPlaylistReload
          ? sleep(waitMs).then(() => ({ applyPendingReload: true }))
          : waitWithPlaylistPolling(activePlaylist, waitMs),
        player.exited.then((exit) => ({ exit }))
      ]);

      if (playbackResult.reloadRequested) {
        pendingPlaylistReload = true;
        log("playlist changed; staging continuous VLC handoff for playlist boundary");
        await writeContinuousPlaybackStatus(activePlaylist, {
          nextPlaylistReloadAt: new Date(Date.now() + millisecondsUntilPlaylistBoundary(activePlaylist, loopStartedAtMs)).toISOString(),
          pendingPlaylistReload
        });
        continue;
      }

      if (playbackResult.applyPendingReload) {
        const pending = await loadPendingPlaylist(activePlaylist);
        if (pending.state === "ready") {
          const previousPlayer = player;
          activePlaylist = pending.playlist;
          assetQuarantine.clear();
          lastLoadedPlaylistSignature = activePlaylist.signature;
          pendingPlaylistReload = false;
          continuousRestartAttempt = 0;
          continuousRetryStatus = null;
          loopStartedAtMs = Date.now();
          log(
            `handoff at playlist boundary to ${activePlaylist.playlistId} version ${activePlaylist.version}`
          );
          player = startPlaylistPlayer(activePlaylist);
          await writeContinuousPlaybackStatus(activePlaylist, {
            handoffCompletedAt: new Date().toISOString(),
            pendingPlaylistReload
          });
          await sleep(Math.max(playlistHandoffOverlapMs, 0));
          stopAssetPlayer(previousPlayer);
          previousPlayer.exited.catch((error) => {
            log(`previous VLC exit check failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          continue;
        }

        if (pending.state === "unchanged") {
          pendingPlaylistReload = false;
          await writeContinuousPlaybackStatus(activePlaylist, { pendingPlaylistReload });
        }

        continue;
      }

      if (playbackResult.exit) {
        if (isExpectedPlayerExit(player, playbackResult.exit)) {
          return;
        }

        const message = `VLC exited with code ${
          playbackResult.exit.code ?? "unknown"
        } signal ${playbackResult.exit.signal ?? "none"}`;
        continuousRestartAttempt += 1;
        const backoffMs = continuousRestartBackoffMs(continuousRestartAttempt);
        const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
        continuousRetryStatus = {
          continuousRestartAttempt,
          lastError: message,
          nextRetryAt,
          restartBackoffMs: backoffMs
        };
        log(
          `VLC exited unexpectedly; retrying continuous playlist in ${backoffMs}ms ` +
          `(attempt ${continuousRestartAttempt}): ${message}`
        );
        await writePlaybackStatus(activePlaylist, "degraded", {
          ...continuousRetryStatus,
          pendingPlaylistReload
        });

        const backoffResult = await waitWithPlaylistPolling(activePlaylist, backoffMs);
        if (backoffResult.reloadRequested) {
          const pending = await loadPendingPlaylist(activePlaylist);
          if (pending.state === "ready") {
            activePlaylist = pending.playlist;
            assetQuarantine.clear();
            lastLoadedPlaylistSignature = activePlaylist.signature;
            pendingPlaylistReload = false;
            continuousRestartAttempt = 0;
            log(
              `using updated playlist after VLC exit: ${activePlaylist.playlistId} ` +
              `version ${activePlaylist.version}`
            );
          } else if (pending.state === "unchanged") {
            pendingPlaylistReload = false;
          } else {
            pendingPlaylistReload = true;
          }
        }

        if (stopping) {
          continue;
        }

        loopStartedAtMs = Date.now();
        player = startPlaylistPlayer(activePlaylist);
        continuousRetryStatus = null;
        await writeContinuousPlaybackStatus(activePlaylist, {
          continuousRestartAttempt,
          recoveredFromUnexpectedExitAt: new Date().toISOString(),
          pendingPlaylistReload
        });
      }
    }
  } finally {
    clearInterval(statusHeartbeatTimer);
    stopAssetPlayer(player);
  }
}

async function writeReadyScreenStatus(playlist, details, asset, extra = {}) {
  await writePlaybackStatus(playlist, "ready-for-publishing", {
    currentAssetId: asset.assetId,
    currentAssetPath: asset.path,
    currentAssetDurationSeconds: asset.durationSeconds,
    lastError: asset.renderError,
    readyScreen: {
      generated: asset.generated,
      generatedAt: details.generatedAt,
      deviceName: details.deviceName,
      deviceId: details.deviceId,
      hostname: details.hostname,
      ipAddress: details.ipAddress,
      gateway: details.gateway,
      internet: details.internet,
      readyForPublishing: details.readyForPublishing,
      reason: details.reason
    },
    ...extra
  });
}

async function playReadyScreen(standbyError) {
  const standbyMetadata = standbyError instanceof StandbyPlaylistError ? standbyError.metadata : {};
  const reason = standbyError instanceof Error ? standbyError.message : String(standbyError);

  while (!stopping) {
    const details = await collectReadyScreenDetails(reason);
    const asset = await standbyVideoAsset(details);
    const playlist = {
      playlistId: "playlist-ready-for-publishing",
      version: 0,
      assets: [asset],
      signature: standbyMetadata.signature ?? `standby-${details.generatedAt}`
    };

    log(
      `showing Beam ready screen for ${details.deviceName} ` +
      `(ip ${details.ipAddress}, gateway ${details.gateway}, internet ${details.internet})`
    );
    await writeReadyScreenStatus(playlist, details, asset, {
      pendingPlaylistReload: false
    });

    let statusHeartbeatTimer;
    const player = startAssetPlayer(asset);
    if (statusHeartbeatIntervalMs > 0) {
      statusHeartbeatTimer = setInterval(() => {
        writeReadyScreenStatus(playlist, details, asset, {
          pendingPlaylistReload: false
        }).catch((error) => {
          log(`ready-screen status heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, statusHeartbeatIntervalMs);
    }

    try {
      while (!stopping) {
        const waitResult = await Promise.race([
          waitForPublishedPlaylist(Math.max(playlistPollIntervalMs, 1_000)),
          player.exited.then((exit) => ({ state: "player-exited", exit }))
        ]);

        if (waitResult.state === "ready") {
          stopAssetPlayer(player);
          await player.exited.catch((error) => {
            log(`ready-screen VLC exit check failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          return waitResult.playlist;
        }

        if (waitResult.state === "waiting") {
          const latestDetails = await collectReadyScreenDetails(reason);
          if (shouldRefreshReadyScreenDetails(details, latestDetails)) {
            log(
              `ready-screen network details changed; refreshing ` +
              `(ip ${latestDetails.ipAddress}, gateway ${latestDetails.gateway}, internet ${latestDetails.internet})`
            );
            break;
          }
        }

        if (waitResult.state === "player-exited") {
          if (!isExpectedPlayerExit(player, waitResult.exit)) {
            log(
              `ready-screen VLC exited with code ${waitResult.exit.code ?? "unknown"} ` +
              `signal ${waitResult.exit.signal ?? "none"}`
            );
          }
          break;
        }
      }
    } finally {
      clearInterval(statusHeartbeatTimer);
      stopAssetPlayer(player);
    }
  }

  return null;
}

async function run() {
  if (renderReadyScreenOnly) {
    const details = await collectReadyScreenDetails("Manual ready-screen render.");
    const asset = await standbyVideoAsset(details);
    log(`rendered ready screen asset ${asset.path}`);
    if (asset.renderError) {
      log(`ready screen used fallback video: ${asset.renderError}`);
    }
    return;
  }

  if (dryRun) {
    let playlist;
    try {
      playlist = await playableAssetsFromPlaylist();
    } catch (error) {
      if (error instanceof StandbyPlaylistError) {
        log(`playlist is in standby state: ${error.message}`);
        return;
      }
      throw error;
    }
    log(
      `loaded ${playlist.assets.length} media asset(s) from ${playlist.playlistId} version ${playlist.version}`
    );
    for (const asset of playlist.assets) {
      log(`validated ${asset.assetId} (${asset.type}, ${asset.path})`);
    }
    return;
  }

  await writeStatus({ state: "starting" });
  await access(vlcBinary, fsConstants.X_OK);
  if (startupSettleMs > 0) {
    log(`waiting ${startupSettleMs}ms for the display session to settle`);
    await writeStatus({ state: "waiting-for-display" });
    await sleep(startupSettleMs);
  }
  await waitForDisplay();

  while (!stopping) {
    let playlist;
    try {
      playlist = await playableAssetsFromPlaylist();
    } catch (error) {
      if (error instanceof StandbyPlaylistError) {
        const publishedPlaylist = await playReadyScreen(error);
        if (!publishedPlaylist) {
          continue;
        }
        playlist = publishedPlaylist;
      } else {
        throw error;
      }
    }
    if (lastLoadedPlaylistSignature !== playlist.signature) {
      assetQuarantine.clear();
      lastLoadedPlaylistSignature = playlist.signature;
      log("playlist changed; cleared VLC asset quarantine");
    }
    log(
      `loaded ${playlist.assets.length} media asset(s) from ${playlist.playlistId} version ${playlist.version}`
    );
    await writePlaybackStatus(playlist, "playing", { lastError: null, readyScreen: null });
    if (playlistPlaybackMode === "per-asset") {
      await playPlaylist(playlist);
    } else {
      await playPlaylistContinuously(playlist);
    }
  }

  await writeStatus({ state: "stopped" });
}

function stop() {
  stopping = true;
  stopAllPlayers();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeStatus({ state: "failed", lastError: message })
    .catch((statusError) => {
      log(`status write failed: ${statusError instanceof Error ? statusError.message : String(statusError)}`);
    })
    .finally(() => {
      fail(message);
    });
});
