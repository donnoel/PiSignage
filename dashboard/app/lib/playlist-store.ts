import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  readPlaylistStore as readLocalPlaylistStore,
  selectPlaylist as selectLocalPlaylist
} from "./local-playlist";
import type { Playlist, PlaylistAsset, PlaylistStore } from "./local-playlist";

const dynamoDb = new DynamoDBClient({});
const seedPlaylistId = "playlist-main-playlist";

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function cloudPlaylistConfig(): { playlistsTableName: string } | null {
  if (trimmedEnv("BEAM_DASHBOARD_MODE") !== "cloud") {
    return null;
  }

  const playlistsTableName = trimmedEnv("BEAM_PLAYLISTS_TABLE_NAME");
  return playlistsTableName ? { playlistsTableName } : null;
}

function isoNow(): string {
  return new Date().toISOString();
}

function stringAttribute(value: string): AttributeValue {
  return { S: value };
}

function numberAttribute(value: number): AttributeValue {
  return { N: String(value) };
}

function stringOrNull(value: AttributeValue | undefined): string | null {
  if (!value || value.NULL) {
    return null;
  }

  return value.S ?? null;
}

function stringOrDefault(value: AttributeValue | undefined, fallback: string): string {
  const candidate = stringOrNull(value);
  return candidate && candidate.trim() ? candidate : fallback;
}

function numberOrDefault(value: AttributeValue | undefined, fallback: number): number {
  const parsed = value?.N ? Number(value.N) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAssets(value: AttributeValue | undefined): PlaylistAsset[] {
  const assetsJson = stringOrNull(value);
  if (!assetsJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(assetsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPlaylistAsset) : [];
  } catch {
    return [];
  }
}

function isPlaylistAsset(value: unknown): value is PlaylistAsset {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<PlaylistAsset>;
  return (
    typeof candidate.assetId === "string" &&
    (candidate.type === "image" || candidate.type === "video") &&
    typeof candidate.uri === "string"
  );
}

function playlistFromItem(item: Record<string, AttributeValue>): Playlist {
  const playlistId = stringOrDefault(item.playlistId, seedPlaylistId);
  return {
    assets: parseAssets(item.assetsJson),
    name: stringOrDefault(item.name, playlistId === seedPlaylistId ? "Main Playlist" : "Untitled Playlist"),
    playlistId,
    updatedAt: stringOrDefault(item.updatedAt, isoNow()),
    version: numberOrDefault(item.version, 1)
  };
}

function playlistToItem(playlist: Playlist): Record<string, AttributeValue> {
  return {
    accountId: stringAttribute("beam-dev"),
    assetsJson: stringAttribute(JSON.stringify(playlist.assets)),
    name: stringAttribute(playlist.name),
    playlistId: stringAttribute(playlist.playlistId),
    updatedAt: stringAttribute(playlist.updatedAt),
    version: numberAttribute(playlist.version)
  };
}

async function scanAllItems(tableName: string): Promise<Record<string, AttributeValue>[]> {
  const items: Record<string, AttributeValue>[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamoDb.send(new ScanCommand({
      ConsistentRead: true,
      ExclusiveStartKey: exclusiveStartKey,
      TableName: tableName
    }));
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

async function ensureSeedPlaylist(tableName: string, playlists: Playlist[]): Promise<Playlist[]> {
  if (playlists.some((playlist) => playlist.playlistId === seedPlaylistId)) {
    return playlists;
  }

  const playlist: Playlist = {
    assets: [],
    name: "Main Playlist",
    playlistId: seedPlaylistId,
    updatedAt: isoNow(),
    version: 1
  };

  await dynamoDb.send(new PutItemCommand({
    Item: playlistToItem(playlist),
    TableName: tableName
  }));

  return [playlist, ...playlists];
}

function storeFromPlaylists(playlists: Playlist[]): PlaylistStore {
  const sortedPlaylists = playlists.slice().sort((a, b) => {
    if (a.playlistId === seedPlaylistId) {
      return -1;
    }
    if (b.playlistId === seedPlaylistId) {
      return 1;
    }

    return a.name.localeCompare(b.name);
  });
  return {
    items: sortedPlaylists,
    updatedAt: sortedPlaylists.reduce((latest, playlist) => playlist.updatedAt > latest ? playlist.updatedAt : latest, ""),
    version: 1
  };
}

async function readCloudPlaylistStore(config: { playlistsTableName: string }): Promise<PlaylistStore> {
  const items = await scanAllItems(config.playlistsTableName);
  const playlists = await ensureSeedPlaylist(config.playlistsTableName, items.map(playlistFromItem));
  return storeFromPlaylists(playlists);
}

export async function readPlaylistStore(): Promise<PlaylistStore> {
  const config = cloudPlaylistConfig();
  if (config) {
    return readCloudPlaylistStore(config);
  }

  return readLocalPlaylistStore();
}

export function isCloudPlaylistStoreConfigured(): boolean {
  return cloudPlaylistConfig() !== null;
}

export function selectPlaylist(store: PlaylistStore, playlistId?: string | null): Playlist {
  if (cloudPlaylistConfig()) {
    const requested = playlistId
      ? store.items.find((candidate) => candidate.playlistId === playlistId)
      : null;
    const seeded = store.items.find((candidate) => candidate.playlistId === seedPlaylistId);
    const fallback = store.items[0];

    if (requested ?? seeded ?? fallback) {
      return requested ?? seeded ?? fallback;
    }
  }

  return selectLocalPlaylist(store, playlistId);
}

export async function writePlaylistStore(store: PlaylistStore): Promise<void> {
  const config = cloudPlaylistConfig();
  if (!config) {
    const { writePlaylistStore: writeLocalPlaylistStore } = await import("./local-playlist");
    await writeLocalPlaylistStore(store);
    return;
  }

  const nextIds = new Set(store.items.map((playlist) => playlist.playlistId));
  const existingItems = await scanAllItems(config.playlistsTableName);
  await Promise.all([
    ...existingItems
      .map(playlistFromItem)
      .filter((playlist) => !nextIds.has(playlist.playlistId))
      .map((playlist) =>
        dynamoDb.send(new DeleteItemCommand({
          Key: { playlistId: stringAttribute(playlist.playlistId) },
          TableName: config.playlistsTableName
        }))
      ),
    ...store.items.map((playlist) =>
      dynamoDb.send(new PutItemCommand({
        Item: playlistToItem(playlist),
        TableName: config.playlistsTableName
      }))
    )
  ]);
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

  const items = [...store.items];
  items[index] = playlist;
  const nextStore = {
    ...store,
    items,
    updatedAt: new Date().toISOString(),
    version: store.version + 1
  };
  await writePlaylistStore(nextStore);
  return nextStore;
}
