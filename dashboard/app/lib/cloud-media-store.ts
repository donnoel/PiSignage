import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { MediaRecord, MediaStore } from "./local-data-store";
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

type CloudMediaConfig = {
  assetsTableName: string;
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

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function cloudMediaConfig(): CloudMediaConfig | null {
  if (trimmedEnv("BEAM_DASHBOARD_MODE") !== "cloud") {
    return null;
  }

  const assetsTableName = trimmedEnv("BEAM_ASSETS_TABLE_NAME");
  const sourceMediaBucketName = trimmedEnv("BEAM_SOURCE_MEDIA_BUCKET_NAME");
  if (!assetsTableName || !sourceMediaBucketName) {
    return null;
  }

  return { assetsTableName, sourceMediaBucketName };
}

function isoNow(): string {
  return new Date().toISOString();
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
    preparedAt: stringOrNull(item.preparedAt) ?? undefined,
    sizeBytes: numberOrDefault(item.sizeBytes, 0),
    sourceFileName,
    sourceObjectKey: stringOrNull(item.sourceObjectKey) ?? undefined,
    sourceSizeBytes: nullableNumber(item.sourceSizeBytes) ?? undefined,
    status: cloudMediaStatus(item.status),
    storageBucket: stringOrNull(item.storageBucket) ?? undefined,
    storageProvider: "s3",
    tags: parseTags(item.tagsJson),
    title: stringOrDefault(item.title, baseTitleFromFileName(playbackFileName)),
    updatedAt: stringOrDefault(item.updatedAt, isoNow()),
    videoCodec: stringOrNull(item.videoCodec),
    videoProfile: stringOrNull(item.videoProfile),
    width: nullableNumber(item.width)
  };
}

function cloudMediaStatus(value: AttributeValue | undefined): MediaRecord["status"] {
  const status = stringOrNull(value);
  return status === "ready" || status === "processing" || status === "failed" ? status : "processing";
}

function mediaToItem(media: MediaRecord): Record<string, AttributeValue> {
  return {
    accountId: stringAttribute("beam-dev"),
    assetId: stringAttribute(media.id),
    audioCodec: optionalStringAttribute(media.audioCodec),
    bitRate: nullableNumberAttribute(media.bitRate),
    checksumSha256: optionalStringAttribute(media.checksumSha256),
    cloudStatusDetail: optionalStringAttribute(media.cloudStatusDetail),
    createdAt: stringAttribute(media.createdAt),
    description: stringAttribute(media.description),
    durationSeconds: nullableNumberAttribute(media.durationSeconds),
    fps: nullableNumberAttribute(media.fps),
    height: nullableNumberAttribute(media.height),
    id: stringAttribute(media.id),
    mimeType: stringAttribute(media.mimeType),
    pixelFormat: optionalStringAttribute(media.pixelFormat),
    playbackFileName: stringAttribute(media.playbackFileName),
    playbackObjectKey: optionalStringAttribute(media.playbackObjectKey),
    playbackProfile: optionalStringAttribute(media.playbackProfile),
    preparedAt: optionalStringAttribute(media.preparedAt),
    sizeBytes: numberAttribute(media.sizeBytes),
    sourceFileName: stringAttribute(media.sourceFileName),
    sourceObjectKey: optionalStringAttribute(media.sourceObjectKey),
    sourceSizeBytes: nullableNumberAttribute(media.sourceSizeBytes),
    status: stringAttribute(media.status),
    storageBucket: optionalStringAttribute(media.storageBucket),
    storageProvider: stringAttribute(media.storageProvider ?? "s3"),
    tagsJson: stringAttribute(JSON.stringify(media.tags)),
    title: stringAttribute(media.title),
    updatedAt: stringAttribute(media.updatedAt),
    videoCodec: optionalStringAttribute(media.videoCodec),
    videoProfile: optionalStringAttribute(media.videoProfile),
    width: nullableNumberAttribute(media.width)
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

export async function readCloudMediaStore(config: CloudMediaConfig): Promise<MediaStore> {
  const items = (await scanAllItems(config.assetsTableName)).map(mediaFromItem);
  return {
    items,
    updatedAt: items.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, ""),
    version: 1
  };
}

export async function createCloudMediaUpload(config: CloudMediaConfig, input: CloudMediaUploadInput): Promise<MediaRecord> {
  const safeFileName = sanitizeMediaFileName(input.fileName);
  const sourceType = mediaSourceTypeFromFileName(safeFileName);
  const now = isoNow();
  const id = `asset-${randomUUID()}`;
  const sourceObjectKey = `uploads/${now.slice(0, 10)}/${id}/${safeFileName}`;
  const isVideo = sourceType === "video";
  const isPreparedVideo = isVideo && isPlaybackSafeVideoFileName(safeFileName);
  const playbackFileName = isPreparedVideo
    ? safeFileName
    : sourceType === "image"
    ? stillClipFileName(safeFileName, input.durationSeconds)
    : transcodedVideoFileName(safeFileName);
  const playbackObjectKey = isPreparedVideo ? sourceObjectKey : undefined;

  await s3.send(new PutObjectCommand({
    Body: input.uploadedBytes,
    Bucket: config.sourceMediaBucketName,
    ContentLength: input.uploadedBytes.byteLength,
    ContentType: input.mimeType,
    Key: sourceObjectKey,
    ServerSideEncryption: "AES256"
  }));

  const media: MediaRecord = {
    cloudStatusDetail: isPreparedVideo
      ? "Uploaded prepared MP4 source is ready for playlist use."
      : "Uploaded source is stored in AWS. Playback-safe MP4 processing is pending.",
    createdAt: now,
    description: input.description?.trim().slice(0, 5000) ?? "",
    durationSeconds: sourceType === "image" ? input.durationSeconds : defaultDurationSeconds,
    id,
    mimeType: input.mimeType,
    playbackFileName,
    playbackObjectKey,
    playbackProfile: isPreparedVideo ? playbackPrepProfile.id : "pending-playback-mp4-v1",
    preparedAt: isPreparedVideo ? now : undefined,
    sizeBytes: input.sizeBytes,
    sourceFileName: safeFileName,
    sourceObjectKey,
    sourceSizeBytes: input.sizeBytes,
    status: isPreparedVideo ? "ready" : "processing",
    storageBucket: config.sourceMediaBucketName,
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

async function s3BodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body || typeof body !== "object" || !("transformToByteArray" in body)) {
    throw new MediaUploadError("AWS returned an unreadable source media object.", 502);
  }

  const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes);
}

export async function prepareCloudMediaForPlayback(config: CloudMediaConfig, mediaId: string): Promise<MediaRecord | null> {
  const mediaStore = await readCloudMediaStore(config);
  const current = mediaStore.items.find((item) => item.id === mediaId);
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
      Bucket: config.sourceMediaBucketName,
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

    await s3.send(new PutObjectCommand({
      Body: await fs.readFile(playbackPath),
      Bucket: config.sourceMediaBucketName,
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
      preparedAt: now,
      sizeBytes: outputStat.size,
      status: "ready",
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
  const mediaStore = await readCloudMediaStore(config);
  const current = mediaStore.items.find((item) => item.id === mediaId);
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
  const mediaStore = await readCloudMediaStore(config);
  const requestedIds = new Set(mediaIds.filter((id) => !id.startsWith("playlist:")));
  const deletedIds: string[] = [];
  const missingIds = mediaIds.filter((id) => id.startsWith("playlist:"));
  const blocked: string[] = [];

  for (const id of requestedIds) {
    const media = mediaStore.items.find((item) => item.id === id);
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
        Bucket: config.sourceMediaBucketName,
        Key: media.sourceObjectKey
      }));
    }

    if (media.playbackObjectKey && media.playbackObjectKey !== media.sourceObjectKey) {
      await s3.send(new DeleteObjectCommand({
        Bucket: config.sourceMediaBucketName,
        Key: media.playbackObjectKey
      }));
    }

    deletedIds.push(id);
  }

  return { blockedIds: blocked, deletedIds, missingIds };
}

export async function updateCloudMediaMetadata(
  config: CloudMediaConfig,
  mediaId: string,
  input: { description?: string; tags?: string[]; title?: string }
): Promise<MediaRecord | null> {
  const mediaStore = await readCloudMediaStore(config);
  const current = mediaStore.items.find((item) => item.id === mediaId);
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
