import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { MediaFolderRecord, MediaFolderStore, MediaRecord, MediaStore } from "./local-data-store";
import {
  assertPlaybackSafeVideoFile,
  createPlaybackSafeVideoClip,
  createStillVideoClip,
  defaultDurationSeconds,
  imageDurationFromForm,
  MediaUploadError,
  mediaSourceTypeFromFileName,
  playbackPrepProfile,
  probeMediaFile,
  sanitizeMediaFileName,
  sha256ForFile,
  stillClipFileName,
  transcodedVideoFileName
} from "./media-processing";
import { isPlaybackSafeVideoFileName } from "./playback-safety";
import {
  activeWorkspaceId,
  requireActiveWorkspacePermission,
  withDefaultWorkspace,
  workspaceIdOrDefault
} from "./workspace";

export type CloudMediaConfig = {
  assetsTableName: string;
  playbackMediaBucketName?: string;
  sourceMediaBucketName: string;
};

type CloudMediaUploadInput = {
  description?: string;
  durationSeconds: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  tags: string[];
  title?: string;
  uploadedBytes: Buffer;
};

type CloudMediaDeleteResult = {
  blockedIds: string[];
  deletedIds: string[];
  missingIds: string[];
};

const dynamoDb = new DynamoDBClient({});
const s3 = new S3Client({});
const mediaRecordType = "media";
const mediaFolderRecordType = "media-folder";
const mediaFolderAssignmentRecordType = "media-folder-assignment";

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function cloudMediaConfig(): CloudMediaConfig | null {
  if (trimmedEnv("BEAM_DASHBOARD_MODE") !== "cloud") {
    return null;
  }

  const assetsTableName = trimmedEnv("BEAM_ASSETS_TABLE_NAME");
  const playbackMediaBucketName = trimmedEnv("BEAM_PLAYBACK_MEDIA_BUCKET_NAME") ?? undefined;
  const sourceMediaBucketName = trimmedEnv("BEAM_SOURCE_MEDIA_BUCKET_NAME");
  if (!assetsTableName || !sourceMediaBucketName) {
    return null;
  }

  return { assetsTableName, playbackMediaBucketName, sourceMediaBucketName };
}

function isoNow(): string {
  return new Date().toISOString();
}

async function sha256ForBuffer(value: Buffer): Promise<string> {
  return createHash("sha256").update(value).digest("hex");
}

function baseTitleFromFileName(fileName: string): string {
  const title = path.basename(fileName, path.extname(fileName)).replace(/[-_]+/g, " ").trim();
  return title || "Untitled media";
}

function stringAttribute(value: string): AttributeValue {
  return { S: value };
}

function optionalStringAttribute(value: string | undefined | null): AttributeValue {
  return value && value.trim() ? { S: value } : { NULL: true };
}

function numberAttribute(value: number): AttributeValue {
  return { N: String(value) };
}

function nullableNumberAttribute(value: number | null | undefined): AttributeValue {
  return typeof value === "number" && Number.isFinite(value) ? { N: String(value) } : { NULL: true };
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

function nullableNumber(value: AttributeValue | undefined): number | null {
  if (!value || value.NULL) {
    return null;
  }

  const parsed = value.N ? Number(value.N) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTags(value: AttributeValue | undefined): string[] {
  const tagsJson = stringOrNull(value);
  if (!tagsJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function mediaFromItem(item: Record<string, AttributeValue>): MediaRecord {
  const id = stringOrDefault(item.id ?? item.assetId, "asset-unknown");
  const sourceFileName = stringOrDefault(item.sourceFileName, "media");
  const playbackFileName = stringOrDefault(item.playbackFileName, sourceFileName);

  return {
    audioCodec: stringOrNull(item.audioCodec),
    bitRate: nullableNumber(item.bitRate),
    checksumSha256: stringOrNull(item.checksumSha256) ?? undefined,
    cloudStatusDetail: stringOrNull(item.cloudStatusDetail) ?? undefined,
    createdAt: stringOrDefault(item.createdAt, isoNow()),
    description: stringOrDefault(item.description, ""),
    durationSeconds: nullableNumber(item.durationSeconds),
    fps: nullableNumber(item.fps),
    height: nullableNumber(item.height),
    id,
    mimeType: stringOrDefault(item.mimeType, "application/octet-stream"),
    pixelFormat: stringOrNull(item.pixelFormat),
    playbackFileName,
    playbackObjectKey: stringOrNull(item.playbackObjectKey) ?? undefined,
    playbackProfile: stringOrNull(item.playbackProfile) ?? undefined,
    playbackStorageBucket: stringOrNull(item.playbackStorageBucket) ?? undefined,
    preparedAt: stringOrNull(item.preparedAt) ?? undefined,
    sizeBytes: numberOrDefault(item.sizeBytes, 0),
    sourceFileName,
    sourceObjectKey: stringOrNull(item.sourceObjectKey) ?? undefined,
    sourceSizeBytes: nullableNumber(item.sourceSizeBytes) ?? undefined,
    sourceStorageBucket: stringOrNull(item.sourceStorageBucket) ?? undefined,
    status: cloudMediaStatus(item.status),
    storageBucket: stringOrNull(item.storageBucket) ?? undefined,
    storageProvider: "s3",
    tags: parseTags(item.tagsJson),
    title: stringOrDefault(item.title, baseTitleFromFileName(playbackFileName)),
    updatedAt: stringOrDefault(item.updatedAt, isoNow()),
    videoCodec: stringOrNull(item.videoCodec),
    videoProfile: stringOrNull(item.videoProfile),
    width: nullableNumber(item.width),
    workspaceId: workspaceIdOrDefault(stringOrNull(item.workspaceId))
  };
}

function itemRecordType(item: Record<string, AttributeValue>): string {
  return stringOrNull(item.recordType) ?? mediaRecordType;
}

function itemInActiveWorkspace(item: Record<string, AttributeValue>): boolean {
  return workspaceIdOrDefault(stringOrNull(item.workspaceId)) === activeWorkspaceId();
}

function folderAssignmentRecordId(mediaId: string): string {
  return `folder-assignment-${Buffer.from(mediaId).toString("base64url")}`;
}

function mediaFolderFromItem(item: Record<string, AttributeValue>): MediaFolderRecord | null {
  const id = stringOrNull(item.folderId) ?? stringOrNull(item.id) ?? stringOrNull(item.assetId);
  const name = stringOrNull(item.name);
  if (!id || !name) {
    return null;
  }

  const createdAt = stringOrDefault(item.createdAt, isoNow());
  return {
    createdAt,
    id,
    name,
    updatedAt: stringOrDefault(item.updatedAt, createdAt),
    workspaceId: workspaceIdOrDefault(stringOrNull(item.workspaceId))
  };
}

function folderAssignmentFromItem(item: Record<string, AttributeValue>): [string, string] | null {
  const mediaId = stringOrNull(item.mediaId);
  const folderId = stringOrNull(item.folderId);
  return mediaId && folderId ? [mediaId, folderId] : null;
}

function cloudMediaStatus(value: AttributeValue | undefined): MediaRecord["status"] {
  const status = stringOrNull(value);
  return status === "ready" || status === "processing" || status === "failed" ? status : "processing";
}

function mediaToItem(media: MediaRecord): Record<string, AttributeValue> {
  const normalizedMedia = withDefaultWorkspace(media);
  return {
    accountId: stringAttribute("beam-dev"),
    assetId: stringAttribute(normalizedMedia.id),
    audioCodec: optionalStringAttribute(normalizedMedia.audioCodec),
    bitRate: nullableNumberAttribute(normalizedMedia.bitRate),
    checksumSha256: optionalStringAttribute(normalizedMedia.checksumSha256),
    cloudStatusDetail: optionalStringAttribute(normalizedMedia.cloudStatusDetail),
    createdAt: stringAttribute(normalizedMedia.createdAt),
    description: stringAttribute(normalizedMedia.description),
    durationSeconds: nullableNumberAttribute(normalizedMedia.durationSeconds),
    fps: nullableNumberAttribute(normalizedMedia.fps),
    height: nullableNumberAttribute(normalizedMedia.height),
    id: stringAttribute(normalizedMedia.id),
    mimeType: stringAttribute(normalizedMedia.mimeType),
    pixelFormat: optionalStringAttribute(normalizedMedia.pixelFormat),
    playbackFileName: stringAttribute(normalizedMedia.playbackFileName),
    playbackObjectKey: optionalStringAttribute(normalizedMedia.playbackObjectKey),
    playbackProfile: optionalStringAttribute(normalizedMedia.playbackProfile),
    playbackStorageBucket: optionalStringAttribute(normalizedMedia.playbackStorageBucket),
    preparedAt: optionalStringAttribute(normalizedMedia.preparedAt),
    recordType: stringAttribute(mediaRecordType),
    sizeBytes: numberAttribute(normalizedMedia.sizeBytes),
    sourceFileName: stringAttribute(normalizedMedia.sourceFileName),
    sourceObjectKey: optionalStringAttribute(normalizedMedia.sourceObjectKey),
    sourceSizeBytes: nullableNumberAttribute(normalizedMedia.sourceSizeBytes),
    sourceStorageBucket: optionalStringAttribute(normalizedMedia.sourceStorageBucket),
    status: stringAttribute(normalizedMedia.status),
    storageBucket: optionalStringAttribute(normalizedMedia.storageBucket),
    storageProvider: stringAttribute(normalizedMedia.storageProvider ?? "s3"),
    tagsJson: stringAttribute(JSON.stringify(normalizedMedia.tags)),
    title: stringAttribute(normalizedMedia.title),
    updatedAt: stringAttribute(normalizedMedia.updatedAt),
    videoCodec: optionalStringAttribute(normalizedMedia.videoCodec),
    videoProfile: optionalStringAttribute(normalizedMedia.videoProfile),
    width: nullableNumberAttribute(normalizedMedia.width),
    workspaceId: stringAttribute(normalizedMedia.workspaceId)
  };
}

function mediaFolderToItem(folder: MediaFolderRecord): Record<string, AttributeValue> {
  const normalizedFolder = withDefaultWorkspace(folder);
  return {
    accountId: stringAttribute("beam-dev"),
    assetId: stringAttribute(normalizedFolder.id),
    createdAt: stringAttribute(normalizedFolder.createdAt),
    folderId: stringAttribute(normalizedFolder.id),
    id: stringAttribute(normalizedFolder.id),
    name: stringAttribute(normalizedFolder.name),
    recordType: stringAttribute(mediaFolderRecordType),
    updatedAt: stringAttribute(normalizedFolder.updatedAt),
    workspaceId: stringAttribute(normalizedFolder.workspaceId)
  };
}

function mediaFolderAssignmentToItem(mediaId: string, folderId: string, updatedAt: string): Record<string, AttributeValue> {
  const id = folderAssignmentRecordId(mediaId);
  return {
    accountId: stringAttribute("beam-dev"),
    assetId: stringAttribute(id),
    folderId: stringAttribute(folderId),
    id: stringAttribute(id),
    mediaId: stringAttribute(mediaId),
    recordType: stringAttribute(mediaFolderAssignmentRecordType),
    updatedAt: stringAttribute(updatedAt),
    workspaceId: stringAttribute(workspaceIdOrDefault(null))
  };
}

async function queryWorkspaceItems(tableName: string): Promise<Record<string, AttributeValue>[]> {
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
      TableName: tableName
    }));
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

export async function readCloudMediaStore(config: CloudMediaConfig): Promise<MediaStore> {
  const items = (await queryWorkspaceItems(config.assetsTableName))
    .filter((item) => itemRecordType(item) === mediaRecordType)
    .map(mediaFromItem);
  return {
    items,
    updatedAt: items.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, ""),
    version: 1
  };
}

export async function readCloudMediaFolderStore(config: CloudMediaConfig): Promise<MediaFolderStore> {
  const scannedItems = await queryWorkspaceItems(config.assetsTableName);
  const folders = scannedItems
    .filter((item) => itemRecordType(item) === mediaFolderRecordType)
    .filter(itemInActiveWorkspace)
    .map(mediaFolderFromItem)
    .filter((folder): folder is MediaFolderRecord => folder !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const assignments = Object.fromEntries(
    scannedItems
      .filter((item) => itemRecordType(item) === mediaFolderAssignmentRecordType)
      .filter(itemInActiveWorkspace)
      .map(folderAssignmentFromItem)
      .filter((assignment): assignment is [string, string] => assignment !== null)
  );
  const updatedAt = [...folders.map((folder) => folder.updatedAt), ...scannedItems
    .filter((item) => itemRecordType(item) === mediaFolderAssignmentRecordType)
    .filter(itemInActiveWorkspace)
    .map((item) => stringOrDefault(item.updatedAt, ""))]
    .reduce((latest, value) => value > latest ? value : latest, "");

  return {
    assignments,
    items: folders,
    updatedAt,
    version: 1
  };
}

export async function writeCloudMediaFolderStore(config: CloudMediaConfig, store: MediaFolderStore): Promise<void> {
  requireActiveWorkspacePermission("write");
  const managedItems = (await queryWorkspaceItems(config.assetsTableName)).filter((item) =>
    itemRecordType(item) === mediaFolderRecordType || itemRecordType(item) === mediaFolderAssignmentRecordType
  ).filter(itemInActiveWorkspace);
  const folderItems = store.items.map(mediaFolderToItem);
  const assignmentItems = Object.entries(store.assignments)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([mediaId, folderId]) => mediaFolderAssignmentToItem(mediaId, folderId, store.updatedAt));
  const nextIds = new Set(
    [...folderItems, ...assignmentItems]
      .map((item) => stringOrNull(item.assetId))
      .filter((assetId): assetId is string => assetId !== null)
  );
  const deleteManagedItems = managedItems.flatMap((item) => {
    const assetId = stringOrNull(item.assetId);
    if (!assetId || nextIds.has(assetId)) {
      return [];
    }

    return [
      dynamoDb.send(new DeleteItemCommand({
        Key: { assetId: stringAttribute(assetId) },
        TableName: config.assetsTableName
      }))
    ];
  });

  await Promise.all([
    ...deleteManagedItems,
    ...folderItems.map((item) =>
      dynamoDb.send(new PutItemCommand({
        Item: item,
        TableName: config.assetsTableName
      }))
    ),
    ...assignmentItems.map((item) =>
      dynamoDb.send(new PutItemCommand({
        Item: item,
        TableName: config.assetsTableName
      }))
    )
  ]);
}

export async function createCloudMediaUpload(config: CloudMediaConfig, input: CloudMediaUploadInput): Promise<MediaRecord> {
  requireActiveWorkspacePermission("write");
  const safeFileName = sanitizeMediaFileName(input.fileName);
  const sourceType = mediaSourceTypeFromFileName(safeFileName);
  const now = isoNow();
  const id = `asset-${randomUUID()}`;
  const sourceObjectKey = `uploads/${now.slice(0, 10)}/${id}/${safeFileName}`;
  const isVideo = sourceType === "video";
  const isPreparedVideo = isVideo && isPlaybackSafeVideoFileName(safeFileName);
  const playbackStorageBucket = config.playbackMediaBucketName ?? config.sourceMediaBucketName;
  const playbackFileName = isPreparedVideo
    ? safeFileName
    : sourceType === "image"
    ? stillClipFileName(safeFileName, input.durationSeconds)
    : transcodedVideoFileName(safeFileName);
  const playbackObjectKey = isPreparedVideo ? `playback/${now.slice(0, 10)}/${id}/${safeFileName}` : undefined;
  const checksumSha256 = isPreparedVideo
    ? await sha256ForBuffer(input.uploadedBytes)
    : undefined;

  await s3.send(new PutObjectCommand({
    Body: input.uploadedBytes,
    Bucket: config.sourceMediaBucketName,
    ContentLength: input.uploadedBytes.byteLength,
    ContentType: input.mimeType,
    Key: sourceObjectKey,
    ServerSideEncryption: "AES256"
  }));
  if (isPreparedVideo && playbackObjectKey) {
    await s3.send(new PutObjectCommand({
      Body: input.uploadedBytes,
      Bucket: playbackStorageBucket,
      ContentLength: input.uploadedBytes.byteLength,
      ContentType: "video/mp4",
      Key: playbackObjectKey,
      ServerSideEncryption: "AES256"
    }));
  }

  const media: MediaRecord = {
    cloudStatusDetail: isPreparedVideo
      ? "Uploaded prepared MP4 source is ready for playlist use."
      : "Uploaded source is stored in AWS. Playback-safe MP4 processing is pending.",
    checksumSha256,
    createdAt: now,
    description: input.description?.trim().slice(0, 5000) ?? "",
    durationSeconds: sourceType === "image" ? input.durationSeconds : defaultDurationSeconds,
    id,
    mimeType: input.mimeType,
    playbackFileName,
    playbackObjectKey,
    playbackStorageBucket: isPreparedVideo ? playbackStorageBucket : undefined,
    playbackProfile: isPreparedVideo ? playbackPrepProfile.id : "pending-playback-mp4-v1",
    preparedAt: isPreparedVideo ? now : undefined,
    sizeBytes: input.sizeBytes,
    sourceFileName: safeFileName,
    sourceObjectKey,
    sourceSizeBytes: input.sizeBytes,
    sourceStorageBucket: config.sourceMediaBucketName,
    status: isPreparedVideo ? "ready" : "processing",
    storageBucket: isPreparedVideo ? playbackStorageBucket : config.sourceMediaBucketName,
    storageProvider: "s3",
    tags: input.tags,
    title: input.title?.trim().slice(0, 120) || baseTitleFromFileName(safeFileName),
    updatedAt: now
  };

  await dynamoDb.send(new PutItemCommand({
    Item: mediaToItem(media),
    TableName: config.assetsTableName
  }));

  return media;
}

async function readCloudMediaRecord(config: CloudMediaConfig, mediaId: string): Promise<MediaRecord | null> {
  const result = await dynamoDb.send(new GetItemCommand({
    Key: { assetId: stringAttribute(mediaId) },
    TableName: config.assetsTableName
  }));
  if (!result.Item || itemRecordType(result.Item) !== mediaRecordType || !itemInActiveWorkspace(result.Item)) {
    return null;
  }

  return mediaFromItem(result.Item);
}

async function s3BodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body || typeof body !== "object" || !("transformToByteArray" in body)) {
    throw new MediaUploadError("AWS returned an unreadable source media object.", 502);
  }

  const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes);
}

export async function prepareCloudMediaForPlayback(config: CloudMediaConfig, mediaId: string): Promise<MediaRecord | null> {
  requireActiveWorkspacePermission("write");
  const current = await readCloudMediaRecord(config, mediaId);
  if (!current) {
    return null;
  }

  if (current.status === "ready" && current.playbackObjectKey) {
    return current;
  }

  if (!current.sourceObjectKey) {
    throw new MediaUploadError("This media item does not have a source object in AWS.", 409);
  }

  const sourceType = mediaSourceTypeFromFileName(current.sourceFileName);
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "beam-media-"));
  const sourcePath = path.join(tempDirectory, current.sourceFileName);
  const playbackPath = path.join(tempDirectory, current.playbackFileName);

  try {
    const sourceObject = await s3.send(new GetObjectCommand({
      Bucket: current.sourceStorageBucket ?? config.sourceMediaBucketName,
      Key: current.sourceObjectKey
    }));
    await fs.writeFile(sourcePath, await s3BodyToBuffer(sourceObject.Body));

    if (sourceType === "image") {
      await createStillVideoClip(sourcePath, playbackPath, current.durationSeconds ?? defaultDurationSeconds);
    } else if (isPlaybackSafeVideoFileName(current.sourceFileName)) {
      await fs.copyFile(sourcePath, playbackPath);
      await assertPlaybackSafeVideoFile(playbackPath);
    } else {
      await createPlaybackSafeVideoClip(sourcePath, playbackPath);
    }

    const [probe, checksumSha256, outputStat] = await Promise.all([
      probeMediaFile(playbackPath),
      sha256ForFile(playbackPath),
      fs.stat(playbackPath)
    ]);
    const now = isoNow();
    const playbackObjectKey = `playback/${now.slice(0, 10)}/${current.id}/${current.playbackFileName}`;
    const playbackStorageBucket = config.playbackMediaBucketName ?? config.sourceMediaBucketName;

    await s3.send(new PutObjectCommand({
      Body: await fs.readFile(playbackPath),
      Bucket: playbackStorageBucket,
      ContentLength: outputStat.size,
      ContentType: "video/mp4",
      Key: playbackObjectKey,
      ServerSideEncryption: "AES256"
    }));

    const updated: MediaRecord = {
      ...current,
      audioCodec: probe.audioCodec,
      bitRate: probe.bitRate,
      checksumSha256,
      cloudStatusDetail: `Prepared ${playbackPrepProfile.width}x${playbackPrepProfile.height} H.264 playback copy for Pi/VLC.`,
      durationSeconds: probe.durationSeconds ?? current.durationSeconds ?? defaultDurationSeconds,
      fps: probe.averageFps ?? probe.fps,
      height: probe.height,
      mimeType: "video/mp4",
      pixelFormat: probe.pixelFormat,
      playbackObjectKey,
      playbackProfile: playbackPrepProfile.id,
      playbackStorageBucket,
      preparedAt: now,
      sizeBytes: outputStat.size,
      status: "ready",
      storageBucket: playbackStorageBucket,
      updatedAt: now,
      videoCodec: probe.videoCodec,
      videoProfile: probe.videoProfile,
      width: probe.width
    };

    await dynamoDb.send(new PutItemCommand({
      Item: mediaToItem(updated),
      TableName: config.assetsTableName
    }));

    return updated;
  } finally {
    await fs.rm(tempDirectory, { force: true, recursive: true });
  }
}

export async function updateCloudMediaPreparationStatus(
  config: CloudMediaConfig,
  mediaId: string,
  input: {
    cloudStatusDetail: string;
    playbackProfile?: string;
    status: MediaRecord["status"];
  }
): Promise<MediaRecord | null> {
  requireActiveWorkspacePermission("write");
  const current = await readCloudMediaRecord(config, mediaId);
  if (!current) {
    return null;
  }

  const updated: MediaRecord = {
    ...current,
    cloudStatusDetail: input.cloudStatusDetail,
    playbackProfile: input.playbackProfile ?? current.playbackProfile,
    status: input.status,
    updatedAt: isoNow()
  };

  await dynamoDb.send(new PutItemCommand({
    Item: mediaToItem(updated),
    TableName: config.assetsTableName
  }));

  return updated;
}

export async function deleteCloudMediaRecords(
  config: CloudMediaConfig,
  mediaIds: string[],
  blockedIds: Set<string> = new Set()
): Promise<CloudMediaDeleteResult> {
  requireActiveWorkspacePermission("write");
  const requestedIds = new Set(mediaIds.filter((id) => !id.startsWith("playlist:")));
  const deletedIds: string[] = [];
  const missingIds = mediaIds.filter((id) => id.startsWith("playlist:"));
  const blocked: string[] = [];

  for (const id of requestedIds) {
    const media = await readCloudMediaRecord(config, id);
    if (!media) {
      missingIds.push(id);
      continue;
    }

    if (blockedIds.has(id)) {
      blocked.push(id);
      continue;
    }

    await dynamoDb.send(new DeleteItemCommand({
      Key: { assetId: stringAttribute(id) },
      TableName: config.assetsTableName
    }));

    if (media.sourceObjectKey) {
      await s3.send(new DeleteObjectCommand({
        Bucket: media.sourceStorageBucket ?? config.sourceMediaBucketName,
        Key: media.sourceObjectKey
      }));
    }

    if (media.playbackObjectKey && media.playbackObjectKey !== media.sourceObjectKey) {
      await s3.send(new DeleteObjectCommand({
        Bucket: media.playbackStorageBucket ?? media.storageBucket ?? config.playbackMediaBucketName ?? config.sourceMediaBucketName,
        Key: media.playbackObjectKey
      }));
    }

    deletedIds.push(id);
  }

  if (deletedIds.length > 0) {
    const folderStore = await readCloudMediaFolderStore(config);
    const assignments = { ...folderStore.assignments };
    for (const id of deletedIds) {
      delete assignments[id];
    }

    await writeCloudMediaFolderStore(config, {
      ...folderStore,
      assignments,
      updatedAt: isoNow(),
      version: folderStore.version + 1
    });
  }

  return { blockedIds: blocked, deletedIds, missingIds };
}

export async function updateCloudMediaMetadata(
  config: CloudMediaConfig,
  mediaId: string,
  input: { description?: string; tags?: string[]; title?: string }
): Promise<MediaRecord | null> {
  requireActiveWorkspacePermission("write");
  const current = await readCloudMediaRecord(config, mediaId);
  if (!current) {
    return null;
  }

  const now = isoNow();
  const title = input.title === undefined ? current.title : input.title.trim().slice(0, 120);
  if (!title) {
    throw new Error("Title is required.");
  }

  const updated: MediaRecord = {
    ...current,
    description: input.description === undefined ? current.description : input.description.trim().slice(0, 5000),
    tags: input.tags ?? current.tags,
    title,
    updatedAt: now
  };

  await dynamoDb.send(new PutItemCommand({
    Item: mediaToItem(updated),
    TableName: config.assetsTableName
  }));

  return updated;
}

export function cloudUploadInputFromForm(file: File, formData: FormData, tags: string[]): Promise<CloudMediaUploadInput> {
  const safeFileName = sanitizeMediaFileName(file.name);
  const durationSeconds = imageDurationFromForm(formData.get("durationSeconds"));
  const titleEntry = formData.get("title");
  const descriptionEntry = formData.get("description");

  return file.arrayBuffer().then((arrayBuffer) => ({
    description: typeof descriptionEntry === "string" ? descriptionEntry : "",
    durationSeconds,
    fileName: safeFileName,
    mimeType: file.type || mimeTypeFromFileName(safeFileName),
    sizeBytes: file.size,
    tags,
    title: typeof titleEntry === "string" ? titleEntry : "",
    uploadedBytes: Buffer.from(arrayBuffer)
  }));
}

function mimeTypeFromFileName(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".mp4") {
    return "video/mp4";
  }
  if (extension === ".mov") {
    return "video/quicktime";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".png") {
    return "image/png";
  }
  return "application/octet-stream";
}
