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
const vlcAvcodecHardware = process.env.PISIGNAGE_VLC_AVCODEC_HW ?? "none";
const vlcAudioMode = process.env.PISIGNAGE_VLC_AUDIO ?? "off";
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
  process.env.PISIGNAGE_PLAYLIST_HANDOFF_OVERLAP_MS ?? "1000",
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

let stopping = false;
const activePlayers = new Set();
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
  vlcAudioMode,
  vlcAvcodecHardware,
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

async function playlistHasChanged(playlist) {
  const playlistStats = await stat(playlistPath);
  return playlistStats.mtimeMs !== playlist.modifiedMs;
}

function vlcArgsForAsset(asset) {
  const waylandArgs = vlcVideoOutput.startsWith("wl_")
    ? ["--wl-display", vlcWaylandDisplay]
    : [];
  const audioArgs = vlcAudioMode === "off" ? ["--no-audio"] : [];

  return [
    "--avcodec-hw",
    vlcAvcodecHardware,
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
    displayOutput,
    asset.path
  ];
}

function startAssetPlayer(asset) {
  const child = spawn(vlcBinary, vlcArgsForAsset(asset), {
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
    lastError: null,
    ...extra
  });
}

async function playPlaylist(playlist) {
  log(`playing playlist with ${playlist.assets.length} media asset(s)`);
  let statusHeartbeatTimer;
  let currentIndex = 0;
  let currentAsset = playlist.assets[currentIndex];
  log(`playing asset ${currentAsset.assetId} for ${currentAsset.durationSeconds}s`);
  await writePlayingAssetStatus(playlist, currentAsset);
  let currentPlayer = startAssetPlayer(currentAsset);

  if (statusHeartbeatIntervalMs > 0) {
    statusHeartbeatTimer = setInterval(() => {
      writePlayingAssetStatus(playlist, currentAsset).catch((error) => {
        log(`status heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, statusHeartbeatIntervalMs);
  }

  try {
    while (!stopping) {
      const currentDurationMs = Math.max(Math.round(currentAsset.durationSeconds * 1000), 1_000);
      const overlapMs =
        playlist.assets.length > 1
          ? Math.min(Math.max(playlistHandoffOverlapMs, 0), Math.max(currentDurationMs - 1_000, 0))
          : 0;
      const displayMs = Math.max(currentDurationMs - overlapMs, 1_000);

      const playbackResult = await Promise.race([
        waitWithPlaylistPolling(playlist, displayMs),
        currentPlayer.exited.then((exit) => ({ exit }))
      ]);

      if (playbackResult.reloadRequested) {
        log("playlist changed; restarting VLC with the latest local playlist");
        return;
      }

      if (playbackResult.exit && !isExpectedPlayerExit(currentPlayer, playbackResult.exit)) {
        const message = `VLC exited with code ${
          playbackResult.exit.code ?? "unknown"
        } signal ${playbackResult.exit.signal ?? "none"}`;
        quarantineAsset(currentAsset, message);
        await writePlaybackStatus(playlist, "degraded", {
          currentAssetId: currentAsset.assetId,
          currentAssetPath: currentAsset.path,
          currentAssetDurationSeconds: currentAsset.durationSeconds,
          lastError: message
        });
      }

      let nextIndex = currentIndex;
      let nextAsset = currentAsset;
      for (let offset = 1; offset <= playlist.assets.length; offset += 1) {
        const candidateIndex = (currentIndex + offset) % playlist.assets.length;
        const candidateAsset = playlist.assets[candidateIndex];
        if (!activeQuarantineEntry(candidateAsset)) {
          nextIndex = candidateIndex;
          nextAsset = candidateAsset;
          break;
        }
      }

      if (activeQuarantineEntry(nextAsset)) {
        throw new Error(`No playable media assets remain in ${playlistPath}`);
      }

      if (playlist.assets.length === 1) {
        continue;
      }

      const previousPlayer = currentPlayer;
      const previousAsset = currentAsset;
      log(`starting next asset ${nextAsset.assetId} before stopping ${previousAsset.assetId}`);
      const nextPlayer = startAssetPlayer(nextAsset);
      currentIndex = nextIndex;
      currentAsset = nextAsset;
      currentPlayer = nextPlayer;
      await writePlayingAssetStatus(playlist, nextAsset);

      const overlapResult = await waitWithPlaylistPolling(playlist, overlapMs);
      if (overlapResult.reloadRequested) {
        log("playlist changed; restarting VLC with the latest local playlist");
        stopAssetPlayer(nextPlayer);
        return;
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
