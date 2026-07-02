import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  DynamoDBClient
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { InventoryPublishTarget } from "./inventory-store";
import { localStateDirectory, writeFileAtomic } from "./local-playlist";
import type { Playlist, PlaylistAsset } from "./local-playlist";
import {
  activeWorkspaceId,
  requireActiveWorkspacePermission,
  workspaceIdOrDefault,
  workspaceMatches
} from "./workspace";

export type CloudReleaseAsset = {
  assetId: string;
  altText?: string;
  checksumSha256?: string;
  durationSeconds?: number;
  fileName: string;
  playbackObjectKey?: string;
  playbackStorageBucket?: string;
  sizeBytes: number;
  sourceObjectKey?: string;
  sourceStorageBucket?: string;
  storageBucket?: string;
  storageProvider?: "local" | "s3";
  type: "image" | "video";
  uri: string;
};

export type CloudReleaseManifest = {
  assetCount: number;
  assets: CloudReleaseAsset[];
  createdAt: string;
  manifestChecksum: string;
  plannedBytes: number;
  playlistId: string;
  playlistName: string;
  playlistVersion: number;
  releaseId: string;
  targetDeviceIds: string[];
  targetScreenIds: string[];
  workspaceId: string;
};

export type CloudReleaseRecord = CloudReleaseManifest & {
  publishedAt: string;
};

export type CloudSyncResult = {
  assetCount: number;
  completedAt: string;
  deviceId: string;
  downloadedBytes: number;
  failedAssetIds: string[];
  message: string;
  releaseId: string;
  result: "error" | "success" | "warning";
  skippedBytes: number;
  workspaceId: string;
};

export type CloudTransferSummary = {
  downloadedBytesToday: number;
  latestRelease: CloudReleaseRecord | null;
  plannedBytesToday: number;
  releasesToday: number;
  syncResultsToday: number;
  unexpectedBytesToday: number;
};

const dynamoDb = new DynamoDBClient({});
const releaseRecordType = "release";
const syncRecordType = "sync-result";
const accountId = "beam-dev";

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function cloudReleaseConfig(): { releasesTableName: string } | null {
  if (trimmedEnv("BEAM_DASHBOARD_MODE") !== "cloud") {
    return null;
  }

  const releasesTableName = trimmedEnv("BEAM_RELEASES_TABLE_NAME");
  return releasesTableName ? { releasesTableName } : null;
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

function numberOrDefault(value: AttributeValue | undefined, fallback: number): number {
  const parsed = value?.N ? Number(value.N) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson<TValue>(value: AttributeValue | undefined, fallback: TValue): TValue {
  const raw = stringOrNull(value);
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as TValue;
  } catch {
    return fallback;
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function releaseFileName(asset: PlaylistAsset): string {
  const candidate = asset.playbackObjectKey ?? asset.sourceObjectKey ?? asset.uri;
  return path.basename(candidate);
}

function releaseAssetFromPlaylistAsset(asset: PlaylistAsset): CloudReleaseAsset {
  return {
    assetId: asset.assetId,
    altText: asset.altText,
    checksumSha256: asset.checksumSha256,
    durationSeconds: asset.durationSeconds,
    fileName: releaseFileName(asset),
    playbackObjectKey: asset.playbackObjectKey,
    playbackStorageBucket: asset.playbackStorageBucket,
    sizeBytes: typeof asset.sizeBytes === "number" && Number.isFinite(asset.sizeBytes) ? asset.sizeBytes : 0,
    sourceObjectKey: asset.sourceObjectKey,
    sourceStorageBucket: asset.sourceStorageBucket,
    storageBucket: asset.playbackStorageBucket ?? asset.storageBucket,
    storageProvider: asset.storageProvider,
    type: asset.type,
    uri: asset.uri
  };
}

function releaseRecordToItem(release: CloudReleaseRecord): Record<string, AttributeValue> {
  return {
    accountId: stringAttribute(accountId),
    assetCount: numberAttribute(release.assetCount),
    createdAt: stringAttribute(release.createdAt),
    manifestChecksum: stringAttribute(release.manifestChecksum),
    manifestJson: stringAttribute(JSON.stringify(release)),
    plannedBytes: numberAttribute(release.plannedBytes),
    playlistId: stringAttribute(release.playlistId),
    playlistName: stringAttribute(release.playlistName),
    playlistVersion: numberAttribute(release.playlistVersion),
    publishedAt: stringAttribute(release.publishedAt),
    recordType: stringAttribute(releaseRecordType),
    releaseId: stringAttribute(release.releaseId),
    targetDeviceIdsJson: stringAttribute(JSON.stringify(release.targetDeviceIds)),
    targetScreenIdsJson: stringAttribute(JSON.stringify(release.targetScreenIds)),
    workspaceId: stringAttribute(release.workspaceId)
  };
}

function releaseRecordFromItem(item: Record<string, AttributeValue>): CloudReleaseRecord | null {
  if (stringOrNull(item.recordType) !== releaseRecordType) {
    return null;
  }

  const manifest = parseJson<CloudReleaseRecord | null>(item.manifestJson, null);
  if (!manifest?.releaseId) {
    return null;
  }

  return {
    ...manifest,
    workspaceId: workspaceIdOrDefault(manifest.workspaceId)
  };
}

function syncResultToItem(sync: CloudSyncResult): Record<string, AttributeValue> {
  const syncId = `sync-${sync.releaseId}-${sync.deviceId}-${sync.completedAt}-${randomUUID()}`;
  return {
    accountId: stringAttribute(accountId),
    assetCount: numberAttribute(sync.assetCount),
    completedAt: stringAttribute(sync.completedAt),
    deviceId: stringAttribute(sync.deviceId),
    downloadedBytes: numberAttribute(sync.downloadedBytes),
    failedAssetIdsJson: stringAttribute(JSON.stringify(sync.failedAssetIds)),
    message: stringAttribute(sync.message.slice(0, 1000)),
    recordType: stringAttribute(syncRecordType),
    releaseId: stringAttribute(syncId),
    releaseParentId: stringAttribute(sync.releaseId),
    result: stringAttribute(sync.result),
    skippedBytes: numberAttribute(sync.skippedBytes),
    workspaceId: stringAttribute(sync.workspaceId)
  };
}

function syncResultFromItem(item: Record<string, AttributeValue>): CloudSyncResult | null {
  if (stringOrNull(item.recordType) !== syncRecordType) {
    return null;
  }

  const releaseId = stringOrNull(item.releaseParentId);
  const deviceId = stringOrNull(item.deviceId);
  const completedAt = stringOrNull(item.completedAt);
  const result = stringOrNull(item.result);
  if (!releaseId || !deviceId || !completedAt || (result !== "success" && result !== "warning" && result !== "error")) {
    return null;
  }

  return {
    assetCount: numberOrDefault(item.assetCount, 0),
    completedAt,
    deviceId,
    downloadedBytes: numberOrDefault(item.downloadedBytes, 0),
    failedAssetIds: parseJson<string[]>(item.failedAssetIdsJson, []),
    message: stringOrNull(item.message) ?? "",
    releaseId,
    result,
    skippedBytes: numberOrDefault(item.skippedBytes, 0),
    workspaceId: workspaceIdOrDefault(stringOrNull(item.workspaceId))
  };
}

function localReleaseStorePath(): string {
  return path.join(localStateDirectory(), "cloud-releases.local.json");
}

async function appendLocalRecord(record: CloudReleaseRecord | CloudSyncResult): Promise<void> {
  const filePath = localReleaseStorePath();
  let current: { releases: CloudReleaseRecord[]; syncResults: CloudSyncResult[] };
  try {
    current = JSON.parse(await fs.readFile(filePath, "utf8")) as typeof current;
  } catch {
    current = { releases: [], syncResults: [] };
  }

  if ("publishedAt" in record) {
    current.releases = [record, ...current.releases.filter((item) => item.releaseId !== record.releaseId)].slice(0, 200);
  } else {
    current.syncResults = [record, ...current.syncResults].slice(0, 500);
  }

  await writeFileAtomic(filePath, `${JSON.stringify(current, null, 2)}\n`);
}

export async function deleteLocalCloudReleaseRecordsForPlaylists(playlistIds: Set<string>): Promise<void> {
  if (playlistIds.size === 0) {
    return;
  }

  const filePath = localReleaseStorePath();
  let current: { releases: CloudReleaseRecord[]; syncResults: CloudSyncResult[] };
  try {
    current = JSON.parse(await fs.readFile(filePath, "utf8")) as typeof current;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  const removedReleaseIds = new Set(
    current.releases
      .filter((release) => playlistIds.has(release.playlistId))
      .map((release) => release.releaseId)
  );
  if (removedReleaseIds.size === 0) {
    return;
  }

  const next = {
    releases: current.releases.filter((release) => !removedReleaseIds.has(release.releaseId)),
    syncResults: current.syncResults.filter((sync) => !removedReleaseIds.has(sync.releaseId))
  };

  await writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

export function buildCloudReleaseManifest(
  playlist: Playlist,
  targets: InventoryPublishTarget[],
  publishedAt: string = isoNow()
): CloudReleaseRecord {
  const workspaceId = workspaceIdOrDefault(playlist.workspaceId);
  const targetDeviceIds = Array.from(
    new Set(targets.map((target) => target.device?.id).filter((id): id is string => Boolean(id)))
  ).sort();
  const targetScreenIds = Array.from(
    new Set(targets.map((target) => target.screen?.id).filter((id): id is string => Boolean(id)))
  ).sort();
  const assets = playlist.assets.map(releaseAssetFromPlaylistAsset);
  const plannedBytes = assets.reduce((total, asset) => total + asset.sizeBytes, 0) * Math.max(targetDeviceIds.length, 1);
  const manifestSeed = {
    assets,
    playlistId: playlist.playlistId,
    playlistVersion: playlist.version,
    targetDeviceIds,
    targetScreenIds,
    workspaceId
  };
  const manifestChecksum = hashJson(manifestSeed);
  const releaseId = `release-${playlist.playlistId}-v${playlist.version}-${manifestChecksum.slice(0, 16)}`;

  return {
    assetCount: assets.length,
    assets,
    createdAt: publishedAt,
    manifestChecksum,
    plannedBytes,
    playlistId: playlist.playlistId,
    playlistName: playlist.name,
    playlistVersion: playlist.version,
    publishedAt,
    releaseId,
    targetDeviceIds,
    targetScreenIds,
    workspaceId
  };
}

export async function writeCloudRelease(release: CloudReleaseRecord): Promise<CloudReleaseRecord> {
  requireActiveWorkspacePermission("publish");
  const config = cloudReleaseConfig();
  if (!config) {
    await appendLocalRecord(release);
    return release;
  }

  await dynamoDb.send(new PutItemCommand({
    Item: releaseRecordToItem(release),
    TableName: config.releasesTableName
  }));
  return release;
}

export async function readCloudRelease(releaseId: string): Promise<CloudReleaseRecord | null> {
  const config = cloudReleaseConfig();
  if (!config) {
    return null;
  }

  const result = await dynamoDb.send(new GetItemCommand({
    ConsistentRead: true,
    Key: {
      releaseId: stringAttribute(releaseId)
    },
    TableName: config.releasesTableName
  }));

  return result.Item ? releaseRecordFromItem(result.Item) : null;
}

export async function readLatestCloudReleaseForPlaylist(playlistId: string): Promise<CloudReleaseRecord | null> {
  const config = cloudReleaseConfig();

  if (!config) {
    const filePath = localReleaseStorePath();
    try {
      const current = JSON.parse(await fs.readFile(filePath, "utf8")) as { releases?: unknown };
      const releases = Array.isArray(current.releases)
        ? current.releases.filter((release): release is CloudReleaseRecord =>
            Boolean(
              release &&
              typeof release === "object" &&
              "playlistId" in release &&
              release.playlistId === playlistId &&
              workspaceMatches(release)
            )
          )
        : [];
      return releases.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0] ?? null;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  const items: Record<string, AttributeValue>[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamoDb.send(new QueryCommand({
      ExclusiveStartKey: exclusiveStartKey,
      ExpressionAttributeValues: {
        ":workspaceId": stringAttribute(activeWorkspaceId())
      },
      IndexName: "byWorkspace",
      KeyConditionExpression: "workspaceId = :workspaceId",
      TableName: config.releasesTableName
    }));
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items
    .map(releaseRecordFromItem)
    .filter((release): release is CloudReleaseRecord =>
      release !== null &&
      release.playlistId === playlistId &&
      workspaceMatches(release)
    )
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0] ?? null;
}

export function releaseTargetsDevice(release: CloudReleaseRecord, deviceId: string): boolean {
  return release.targetDeviceIds.includes(deviceId);
}

export function releaseAsset(release: CloudReleaseRecord, assetId: string): CloudReleaseAsset | null {
  return release.assets.find((asset) => asset.assetId === assetId) ?? null;
}

export async function writeCloudSyncResult(input: Omit<CloudSyncResult, "completedAt" | "workspaceId">): Promise<CloudSyncResult> {
  const sync: CloudSyncResult = {
    ...input,
    completedAt: isoNow(),
    workspaceId: activeWorkspaceId()
  };
  const config = cloudReleaseConfig();
  if (!config) {
    await appendLocalRecord(sync);
    return sync;
  }

  await dynamoDb.send(new PutItemCommand({
    Item: syncResultToItem(sync),
    TableName: config.releasesTableName
  }));
  return sync;
}

export async function readCloudTransferSummary(): Promise<CloudTransferSummary> {
  const config = cloudReleaseConfig();
  if (!config) {
    return {
      downloadedBytesToday: 0,
      latestRelease: null,
      plannedBytesToday: 0,
      releasesToday: 0,
      syncResultsToday: 0,
      unexpectedBytesToday: 0
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const items: Record<string, AttributeValue>[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamoDb.send(new QueryCommand({
      ExclusiveStartKey: exclusiveStartKey,
      ExpressionAttributeValues: {
        ":workspaceId": stringAttribute(activeWorkspaceId())
      },
      IndexName: "byWorkspace",
      KeyConditionExpression: "workspaceId = :workspaceId",
      TableName: config.releasesTableName
    }));
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const releases = items
    .map(releaseRecordFromItem)
    .filter((release): release is CloudReleaseRecord => release !== null && workspaceMatches(release))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const syncResults = items
    .map(syncResultFromItem)
    .filter((sync): sync is CloudSyncResult => sync !== null && workspaceMatches(sync));
  const releasesToday = releases.filter((release) => release.publishedAt.startsWith(today));
  const syncResultsToday = syncResults.filter((sync) => sync.completedAt.startsWith(today));
  const plannedBytesToday = releasesToday.reduce((total, release) => total + release.plannedBytes, 0);
  const downloadedBytesToday = syncResultsToday.reduce((total, sync) => total + sync.downloadedBytes, 0);

  return {
    downloadedBytesToday,
    latestRelease: releases[0] ?? null,
    plannedBytesToday,
    releasesToday: releasesToday.length,
    syncResultsToday: syncResultsToday.length,
    unexpectedBytesToday: Math.max(0, downloadedBytesToday - plannedBytesToday)
  };
}
