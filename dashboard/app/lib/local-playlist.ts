import { promises as fs } from "node:fs";
import path from "node:path";

export type PlaylistAsset = {
  assetId: string;
  type: "image" | "video";
  uri: string;
  durationSeconds?: number;
  altText?: string;
};

export type Playlist = {
  playlistId: string;
  name: string;
  version: number;
  updatedAt: string;
  assets: PlaylistAsset[];
};

export type PiPublishResult = {
  enabled: boolean;
  ok: boolean;
  message: string;
};

export function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

export function samplePlaylistPath(): string {
  return path.join(repoRoot(), "sample-content", "playlist.local.json");
}

export function localStateDirectory(): string {
  return path.join(repoRoot(), "dashboard", "local-state");
}

export function livePlaylistPath(): string {
  return path.join(localStateDirectory(), "playlist.local.json");
}

export function sampleAssetsDirectory(): string {
  return path.join(repoRoot(), "sample-content", "assets");
}

export function publishStatusPath(): string {
  return path.join(localStateDirectory(), "publish-status.json");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeFileAtomic(filePath: string, value: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;

  try {
    await fs.writeFile(temporaryPath, value);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function ensureLivePlaylistPath(): Promise<string> {
  const targetPath = livePlaylistPath();

  if (!(await fileExists(targetPath))) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(samplePlaylistPath(), targetPath);
  }

  return targetPath;
}

export async function readPlaylist(playlistPath: string): Promise<Playlist> {
  const playlist = JSON.parse(await fs.readFile(playlistPath, "utf8")) as Partial<Playlist>;

  if (
    typeof playlist.playlistId !== "string" ||
    typeof playlist.name !== "string" ||
    typeof playlist.version !== "number" ||
    typeof playlist.updatedAt !== "string" ||
    !Array.isArray(playlist.assets)
  ) {
    throw new Error("Local playlist is malformed.");
  }

  return playlist as Playlist;
}

export async function readLivePlaylist(): Promise<Playlist> {
  return readPlaylist(await ensureLivePlaylistPath());
}

export async function writePlaylist(playlistPath: string, playlist: Playlist): Promise<void> {
  await writeFileAtomic(playlistPath, `${JSON.stringify(playlist, null, 2)}\n`);
}

export async function writePublishStatus(
  action: string,
  playlist: Playlist,
  piPublish: PiPublishResult
): Promise<void> {
  await writeFileAtomic(
    publishStatusPath(),
    `${JSON.stringify(
      {
        action,
        assetCount: playlist.assets.length,
        message: piPublish.message,
        ok: piPublish.ok,
        piPublishEnabled: piPublish.enabled,
        playlistVersion: playlist.version,
        timestamp: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
}
