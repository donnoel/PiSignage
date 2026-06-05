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

export type PlaylistStore = {
  items: Playlist[];
  updatedAt: string;
  version: number;
};

export type PiPublishResult = {
  assetsChecked?: number;
  assetsCopied?: number;
  assetsRemoved?: number;
  assetsSkipped?: number;
  assetsVerifiedByChecksum?: number;
  assetsVerifiedBySize?: number;
  enabled: boolean;
  ok: boolean;
  message: string;
};

export type PublishStatusTarget = PiPublishResult & {
  deviceId: string | null;
  deviceName: string;
  host: string | null;
  screenId: string | null;
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

export function playlistStorePath(): string {
  return path.join(localStateDirectory(), "playlists.local.json");
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

function isoNow(): string {
  return new Date().toISOString();
}

export async function writeFileAtomic(filePath: string, value: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  try {
    await fs.writeFile(temporaryPath, value);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function normalizePlaylist(playlist: Playlist): Playlist {
  return {
    ...playlist,
    assets: Array.isArray(playlist.assets) ? playlist.assets : [],
    updatedAt: typeof playlist.updatedAt === "string" ? playlist.updatedAt : isoNow(),
    version: typeof playlist.version === "number" ? playlist.version : 1
  };
}

function normalizePlaylistStore(store: PlaylistStore): PlaylistStore {
  return {
    ...store,
    items: store.items.map(normalizePlaylist),
    updatedAt: typeof store.updatedAt === "string" ? store.updatedAt : isoNow(),
    version: typeof store.version === "number" ? store.version : 1
  };
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

export async function readPlaylistStore(): Promise<PlaylistStore> {
  const [livePlaylist, playlistStoreExists] = await Promise.all([
    readLivePlaylist(),
    fileExists(playlistStorePath())
  ]);

  if (!playlistStoreExists) {
    const seededStore = {
      items: [livePlaylist],
      updatedAt: isoNow(),
      version: 1
    };
    await writePlaylistStore(seededStore);
    return seededStore;
  }

  const store = JSON.parse(await fs.readFile(playlistStorePath(), "utf8")) as Partial<PlaylistStore>;
  if (
    typeof store.version !== "number" ||
    typeof store.updatedAt !== "string" ||
    !Array.isArray(store.items)
  ) {
    throw new Error("Playlist library is malformed.");
  }

  let nextStore = normalizePlaylistStore(store as PlaylistStore);
  if (!nextStore.items.some((playlist) => playlist.playlistId === livePlaylist.playlistId)) {
    nextStore = {
      ...nextStore,
      items: [livePlaylist, ...nextStore.items],
      updatedAt: isoNow(),
      version: nextStore.version + 1
    };
    await writePlaylistStore(nextStore);
  }

  return nextStore;
}

export async function writePlaylistStore(store: PlaylistStore): Promise<void> {
  const normalizedStore = normalizePlaylistStore(store);
  if (normalizedStore.items.length === 0) {
    throw new Error("Playlist library must contain at least one playlist.");
  }

  await writeFileAtomic(playlistStorePath(), `${JSON.stringify(normalizedStore, null, 2)}\n`);
}

export function selectPlaylist(store: PlaylistStore, playlistId?: string | null): Playlist {
  const playlist = playlistId
    ? store.items.find((candidate) => candidate.playlistId === playlistId)
    : store.items[0];

  if (!playlist) {
    throw new Error("Playlist was not found.");
  }

  return playlist;
}

export async function readStoredPlaylist(playlistId?: string | null): Promise<{
  playlist: Playlist;
  store: PlaylistStore;
}> {
  const store = await readPlaylistStore();
  return {
    playlist: selectPlaylist(store, playlistId),
    store
  };
}

export async function writeStoredPlaylist(playlist: Playlist): Promise<PlaylistStore> {
  const store = await readPlaylistStore();
  const index = store.items.findIndex((candidate) => candidate.playlistId === playlist.playlistId);
  if (index === -1) {
    throw new Error("Playlist was not found.");
  }

  const nextItems = [...store.items];
  nextItems[index] = normalizePlaylist(playlist);
  const nextStore = {
    ...store,
    items: nextItems,
    updatedAt: isoNow(),
    version: store.version + 1
  };
  await writePlaylistStore(nextStore);
  return nextStore;
}

export async function writePlaylist(playlistPath: string, playlist: Playlist): Promise<void> {
  await writeFileAtomic(playlistPath, `${JSON.stringify(playlist, null, 2)}\n`);
}

export async function writePublishStatus(
  action: string,
  playlist: Playlist,
  piPublish: PiPublishResult,
  targets: PublishStatusTarget[] = []
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
        assetsChecked: piPublish.assetsChecked,
        assetsCopied: piPublish.assetsCopied,
        assetsRemoved: piPublish.assetsRemoved,
        assetsSkipped: piPublish.assetsSkipped,
        assetsVerifiedByChecksum: piPublish.assetsVerifiedByChecksum,
        assetsVerifiedBySize: piPublish.assetsVerifiedBySize,
        playlistId: playlist.playlistId,
        playlistName: playlist.name,
        playlistVersion: playlist.version,
        targets,
        timestamp: isoNow()
      },
      null,
      2
    )}\n`
  );
}
