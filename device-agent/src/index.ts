import { promises as fs } from "node:fs";
import path from "node:path";

type PlaylistAsset = {
  assetId: string;
  type: "image";
  uri: string;
  durationSeconds: number;
  altText?: string;
};

type Playlist = {
  playlistId: string;
  name: string;
  version: number;
  updatedAt: string;
  assets: PlaylistAsset[];
};

type Heartbeat = {
  deviceId: string;
  timestamp: string;
  appVersion: string;
  currentPlaylistId: string;
  currentAssetId: string | null;
  diskFreeBytes: number | null;
  networkOnline: boolean;
};

type CloudHeartbeatConfig = {
  apiKey: string;
  baseUrl: string;
};

const appVersion = "0.1.0";
const currentPlaylistFileName = "current.json";
let stopping = false;

function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      level,
      event,
      timestamp: new Date().toISOString(),
      ...details
    })
  );
}

function parsePlaylist(rawPlaylist: string, source: string): Playlist {
  const parsed = JSON.parse(rawPlaylist) as Partial<Playlist>;

  if (
    typeof parsed.playlistId !== "string" ||
    typeof parsed.name !== "string" ||
    typeof parsed.version !== "number" ||
    typeof parsed.updatedAt !== "string" ||
    !Array.isArray(parsed.assets)
  ) {
    throw new Error(`Invalid playlist shape: ${source}`);
  }

  return parsed as Playlist;
}

async function readPlaylist(playlistPath: string): Promise<Playlist> {
  return parsePlaylist(await fs.readFile(playlistPath, "utf8"), playlistPath);
}

async function diskFreeBytes(rootPath: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(rootPath);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await fs.writeFile(temporaryPath, body, "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function playlistCachePath(cacheDirectory: string, playlistId: string): string {
  return path.join(cacheDirectory, "playlists", `${playlistId}.json`);
}

function currentPlaylistCachePath(cacheDirectory: string): string {
  return path.join(cacheDirectory, "playlists", currentPlaylistFileName);
}

async function cachePlaylist(cacheDirectory: string, playlist: Playlist): Promise<void> {
  await writeJsonAtomic(playlistCachePath(cacheDirectory, playlist.playlistId), playlist);
  await writeJsonAtomic(currentPlaylistCachePath(cacheDirectory), playlist);
}

async function loadPlaylistWithCache(
  playlistPath: string,
  cacheDirectory: string
): Promise<{ playlist: Playlist; source: "playlist" | "cache" }> {
  try {
    const playlist = await readPlaylist(playlistPath);
    await cachePlaylist(cacheDirectory, playlist);
    return { playlist, source: "playlist" };
  } catch (error) {
    log("error", "playlist.read.failed", {
      playlistPath,
      message: error instanceof Error ? error.message : String(error)
    });

    const cachedPath = currentPlaylistCachePath(cacheDirectory);
    const playlist = await readPlaylist(cachedPath);
    return { playlist, source: "cache" };
  }
}

function cloudHeartbeatConfig(): CloudHeartbeatConfig | null {
  const baseUrl = process.env.PISIGNAGE_CLOUD_API_URL?.trim().replace(/\/+$/, "");
  const apiKey = process.env.PISIGNAGE_CLOUD_API_KEY?.trim();

  if (!baseUrl || !apiKey) {
    return null;
  }

  return { apiKey, baseUrl };
}

async function postCloudHeartbeat(config: CloudHeartbeatConfig, heartbeat: Heartbeat): Promise<void> {
  const url = `${config.baseUrl}/v1/devices/${encodeURIComponent(heartbeat.deviceId)}/heartbeat`;
  const response = await fetch(url, {
    body: JSON.stringify(heartbeat),
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Cloud heartbeat returned ${response.status}.`);
  }
}

function heartbeatIntervalMs(): number {
  const seconds = Number.parseInt(process.env.PISIGNAGE_HEARTBEAT_INTERVAL_SECONDS ?? "60", 10);
  if (!Number.isFinite(seconds) || seconds < 5) {
    return 60_000;
  }

  return seconds * 1_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function loopModeEnabled(): boolean {
  return process.argv.includes("--loop") || process.env.PISIGNAGE_AGENT_LOOP === "true";
}

function installSignalHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopping = true;
      log("info", "agent.stop.requested", { signal });
    });
  }
}

async function runHeartbeatOnce(): Promise<void> {
  const root = repoRoot();
  const playlistPath =
    process.env.PISIGNAGE_PLAYLIST_PATH ?? path.join(root, "sample-content", "playlist.local.json");
  const cacheDirectory =
    process.env.PISIGNAGE_CACHE_DIR ?? path.join(root, "device-agent", "local-cache");
  const heartbeatPath =
    process.env.PISIGNAGE_HEARTBEAT_PATH ??
    path.join(root, "device-agent", "local-state", "heartbeat.json");
  const deviceId = process.env.PISIGNAGE_DEVICE_ID ?? "device-local-demo";
  const networkOnline = process.env.PISIGNAGE_NETWORK_ONLINE === "true";

  log("info", "playlist.read.start", { playlistPath });
  const { playlist, source } = await loadPlaylistWithCache(playlistPath, cacheDirectory);
  log("info", "playlist.ready", {
    playlistId: playlist.playlistId,
    source,
    cacheDirectory
  });
  const firstAsset = playlist.assets[0] ?? null;

  const heartbeat: Heartbeat = {
    deviceId,
    timestamp: new Date().toISOString(),
    appVersion,
    currentPlaylistId: playlist.playlistId,
    currentAssetId: firstAsset?.assetId ?? null,
    diskFreeBytes: await diskFreeBytes(root),
    networkOnline
  };

  await writeJsonAtomic(heartbeatPath, heartbeat);
  log("info", "heartbeat.write.complete", {
    heartbeatPath,
    deviceId,
    playlistId: playlist.playlistId,
    currentAssetId: heartbeat.currentAssetId
  });

  const cloudConfig = cloudHeartbeatConfig();
  if (!cloudConfig) {
    log("info", "cloud.heartbeat.skipped", {
      reason: "not_configured"
    });
    return;
  }

  try {
    await postCloudHeartbeat(cloudConfig, heartbeat);
    log("info", "cloud.heartbeat.complete", {
      deviceId,
      playlistId: playlist.playlistId
    });
  } catch (error) {
    log("error", "cloud.heartbeat.failed", {
      deviceId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function runHeartbeatLoop(): Promise<void> {
  const intervalMs = heartbeatIntervalMs();
  log("info", "agent.loop.start", {
    intervalSeconds: intervalMs / 1_000
  });

  while (!stopping) {
    try {
      await runHeartbeatOnce();
    } catch (error) {
      log("error", "agent.loop.cycle.failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }

    if (!stopping) {
      await sleep(intervalMs);
    }
  }

  log("info", "agent.loop.stop");
}

async function main(): Promise<void> {
  installSignalHandlers();

  if (loopModeEnabled()) {
    await runHeartbeatLoop();
    return;
  }

  await runHeartbeatOnce();
}

main().catch((error: unknown) => {
  log("error", "heartbeat.write.failed", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
