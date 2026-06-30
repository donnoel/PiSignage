#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
    signature: playlistSignature(rawPlaylist)
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
    if (lastLoadedPlaylistSignature !== playlist.signature) {
      assetQuarantine.clear();
      lastLoadedPlaylistSignature = playlist.signature;
      log("playlist changed; cleared VLC asset quarantine");
    }
    log(
      `loaded ${playlist.assets.length} media asset(s) from ${playlist.playlistId} version ${playlist.version}`
    );
    await writePlaybackStatus(playlist, "playing", { lastError: null });
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
