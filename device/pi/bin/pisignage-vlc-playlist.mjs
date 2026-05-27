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
const dryRun = process.argv.includes("--dry-run");

let stopping = false;
let activePlayer;
let activeStatus = {
  mode: "vlc",
  state: "starting",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  playlistPath,
  statusPath,
  displayOutput,
  displayMode,
  playlistId: null,
  playlistVersion: null,
  assetCount: 0,
  assetIds: [],
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

async function videoAssetsFromPlaylist() {
  const rawPlaylist = await readFile(playlistPath, "utf8");
  const playlist = JSON.parse(rawPlaylist);
  const assets = Array.isArray(playlist.assets) ? playlist.assets : [];
  const videos = [];

  for (const asset of assets) {
    if (asset?.type !== "video") {
      continue;
    }

    const assetPath = playlistAssetPath(asset);
    if (!assetPath) {
      throw new Error(`Invalid video asset path for ${asset?.assetId ?? "unknown asset"}`);
    }

    await access(assetPath, fsConstants.R_OK);
    videos.push({
      assetId: asset.assetId ?? path.basename(assetPath),
      path: assetPath
    });
  }

  if (videos.length === 0) {
    throw new Error(`No playable video assets found in ${playlistPath}`);
  }

  return {
    playlistId: playlist.playlistId ?? "local-playlist",
    version: playlist.version ?? "unknown",
    videos,
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
    const videoPaths = playlist.videos.map((video) => video.path);
    let playlistPollTimer;
    let reloadRequested = false;
    const args = [
      "--fullscreen",
      "--loop",
      "--no-video-title-show",
      "--quiet",
      "--drm-vout-display",
      displayOutput,
      ...videoPaths
    ];

    log(`playing playlist with ${playlist.videos.length} video asset(s)`);
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

    activePlayer.on("error", (error) => {
      clearInterval(playlistPollTimer);
      activePlayer = undefined;
      reject(error);
    });

    activePlayer.on("exit", (code, signal) => {
      clearInterval(playlistPollTimer);
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
    const playlist = await videoAssetsFromPlaylist();
    log(
      `loaded ${playlist.videos.length} video asset(s) from ${playlist.playlistId} version ${playlist.version}`
    );
    for (const video of playlist.videos) {
      log(`validated ${video.assetId} (${video.path})`);
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
    const playlist = await videoAssetsFromPlaylist();
    log(
      `loaded ${playlist.videos.length} video asset(s) from ${playlist.playlistId} version ${playlist.version}`
    );
    await writeStatus({
      state: "playing",
      playlistId: playlist.playlistId,
      playlistVersion: playlist.version,
      assetCount: playlist.videos.length,
      assetIds: playlist.videos.map((video) => video.assetId),
      lastError: null
    });
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
