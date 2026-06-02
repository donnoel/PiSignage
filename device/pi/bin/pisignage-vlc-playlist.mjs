#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = process.env.PISIGNAGE_REPO_ROOT ?? process.cwd();
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
const statusHeartbeatIntervalMs = Number.parseInt(
  process.env.PISIGNAGE_STATUS_HEARTBEAT_INTERVAL_MS ?? "15000",
  10
);
const dryRun = process.argv.includes("--dry-run");
const assetQuarantineWindowMs = Number.parseInt(
  process.env.PISIGNAGE_ASSET_QUARANTINE_WINDOW_MS ?? "300000",
  10
);

let stopping = false;
let activePlayer;
let lastLoadedPlaylistModifiedMs = null;
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
  vlcVideoOutput,
  vlcWaylandDisplay,
  playlistId: null,
  playlistVersion: null,
  assetCount: 0,
  assetIds: [],
  quarantinedAssetIds: [],
  lastError: null
};

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

async function playableAssetsFromPlaylist() {
  const rawPlaylist = await readFile(playlistPath, "utf8");
  const playlist = JSON.parse(rawPlaylist);
  const assets = Array.isArray(playlist.assets) ? playlist.assets : [];
  const playableAssets = [];

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
      type: asset.type
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
    throw new Error(`No playable media assets found in ${playlistPath}`);
  }

  return {
    playlistId: playlist.playlistId ?? "local-playlist",
    version: playlist.version ?? "unknown",
    assets: playableAssets,
    modifiedMs: (await stat(playlistPath)).mtimeMs
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

function playPlaylist(playlist) {
  return new Promise((resolve, reject) => {
    const mediaArgs = playlist.assets.map((asset) => asset.path);
    const waylandArgs = vlcVideoOutput.startsWith("wl_")
      ? ["--wl-display", vlcWaylandDisplay]
      : [];
    let playlistPollTimer;
    let statusHeartbeatTimer;
    let reloadRequested = false;
    const args = [
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
      displayOutput,
      ...mediaArgs
    ];

    log(`playing playlist with ${playlist.assets.length} media asset(s)`);
    activePlayer = spawn(vlcBinary, args, {
      stdio: "inherit"
    });

    playlistPollTimer = setInterval(async () => {
      try {
        const playlistStats = await stat(playlistPath);
        if (playlistStats.mtimeMs !== playlist.modifiedMs) {
          reloadRequested = true;
          log("playlist changed; restarting VLC with the latest local playlist");
          activePlayer?.kill("SIGTERM");
        }
      } catch (error) {
        reloadRequested = true;
        log(
          `playlist check failed; restarting VLC supervisor: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        activePlayer?.kill("SIGTERM");
      }
    }, playlistPollIntervalMs);

    if (statusHeartbeatIntervalMs > 0) {
      statusHeartbeatTimer = setInterval(() => {
        writeStatus({
          state: "playing",
          playlistId: playlist.playlistId,
          playlistVersion: playlist.version,
          assetCount: playlist.assets.length,
          assetIds: playlist.assets.map((asset) => asset.assetId),
          lastError: null
        }).catch((error) => {
          log(`status heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, statusHeartbeatIntervalMs);
    }

    function clearTimers() {
      clearInterval(playlistPollTimer);
      clearInterval(statusHeartbeatTimer);
    }

    activePlayer.on("error", (error) => {
      clearTimers();
      activePlayer = undefined;
      reject(error);
    });

    activePlayer.on("exit", (code, signal) => {
      clearTimers();
      activePlayer = undefined;
      if (stopping || reloadRequested || signal === "SIGTERM" || signal === "SIGINT") {
        resolve();
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`VLC exited with code ${code ?? "unknown"} signal ${signal ?? "none"}`));
    });
  });
}

async function run() {
  if (dryRun) {
    const playlist = await playableAssetsFromPlaylist();
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
    const playlist = await playableAssetsFromPlaylist();
    if (lastLoadedPlaylistModifiedMs !== playlist.modifiedMs) {
      assetQuarantine.clear();
      lastLoadedPlaylistModifiedMs = playlist.modifiedMs;
      log("playlist changed; cleared VLC asset quarantine");
    }
    log(
      `loaded ${playlist.assets.length} media asset(s) from ${playlist.playlistId} version ${playlist.version}`
    );
    await writePlaybackStatus(playlist, "playing", { lastError: null });
    await playPlaylist(playlist);
  }

  await writeStatus({ state: "stopped" });
}

function stop() {
  stopping = true;
  activePlayer?.kill("SIGTERM");
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
