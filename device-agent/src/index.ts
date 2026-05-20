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

const appVersion = "0.1.0";

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

async function readPlaylist(playlistPath: string): Promise<Playlist> {
  const rawPlaylist = await fs.readFile(playlistPath, "utf8");
  const parsed = JSON.parse(rawPlaylist) as Partial<Playlist>;

  if (
    typeof parsed.playlistId !== "string" ||
    typeof parsed.name !== "string" ||
    typeof parsed.version !== "number" ||
    typeof parsed.updatedAt !== "string" ||
    !Array.isArray(parsed.assets)
  ) {
    throw new Error(`Invalid playlist shape: ${playlistPath}`);
  }

  return parsed as Playlist;
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

async function main(): Promise<void> {
  const root = repoRoot();
  const playlistPath =
    process.env.PISIGNAGE_PLAYLIST_PATH ?? path.join(root, "sample-content", "playlist.local.json");
  const heartbeatPath =
    process.env.PISIGNAGE_HEARTBEAT_PATH ??
    path.join(root, "device-agent", "local-state", "heartbeat.json");
  const deviceId = process.env.PISIGNAGE_DEVICE_ID ?? "device-local-demo";
  const networkOnline = process.env.PISIGNAGE_NETWORK_ONLINE === "true";

  log("info", "playlist.read.start", { playlistPath });
  const playlist = await readPlaylist(playlistPath);
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
}

main().catch((error: unknown) => {
  log("error", "heartbeat.write.failed", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
