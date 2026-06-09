import {
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
  return {
    items: playlists,
    updatedAt: playlists.reduce((latest, playlist) => playlist.updatedAt > latest ? playlist.updatedAt : latest, ""),
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
