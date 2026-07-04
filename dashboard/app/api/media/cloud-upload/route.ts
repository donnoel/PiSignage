import { NextResponse } from "next/server";
import { apiErrorResponse } from "../../../lib/api-error-response";
import {
  cloudMediaConfig,
  createCloudMediaDirectUploadTarget,
  createCloudMediaRecordFromUploadedSource,
  deleteCloudUploadedSourceObject,
  findCloudMediaBySourceFileName
} from "../../../lib/cloud-media-store";
import { startCloudMediaPreparationWorker } from "../../../lib/cloud-media-preparation-worker";
import { readMediaFolderStore, writeMediaFolderStore } from "../../../lib/media-folder-store";
import {
  formatUploadLimit,
  imageDurationFromForm,
  maxUploadBytes,
  MediaUploadError,
  sanitizeMediaFileName
} from "../../../lib/media-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CloudUploadRequest = {
  action?: unknown;
  description?: unknown;
  durationSeconds?: unknown;
  fileName?: unknown;
  folderId?: unknown;
  mediaId?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
  sourceObjectKey?: unknown;
  tags?: unknown;
  title?: unknown;
};

function stringFromUnknown(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveSizeFromUnknown(value: unknown): number {
  const size = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(size) || size <= 0) {
    throw new MediaUploadError("The selected media file is empty.", 400);
  }
  if (size > maxUploadBytes) {
    throw new MediaUploadError(`Media uploads are limited to ${formatUploadLimit(maxUploadBytes)}.`, 413);
  }

  return Math.round(size);
}

function durationEntryFromUnknown(value: unknown): FormDataEntryValue | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function tagsFromUnknown(value: unknown): string[] {
  const text = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string").join(",")
      : "";

  return Array.from(
    new Set(
      text
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.slice(0, 48))
    )
  );
}

async function validateFolderId(folderIdInput: unknown): Promise<string | null> {
  const folderId = stringFromUnknown(folderIdInput).trim();
  if (!folderId) {
    return null;
  }

  const folderStore = await readMediaFolderStore();
  if (!folderStore.items.some((folder) => folder.id === folderId)) {
    throw new MediaUploadError("Folder not found.", 400);
  }

  return folderId;
}

async function assignMediaFolder(mediaId: string, folderId: string | null): Promise<void> {
  if (!folderId) {
    return;
  }

  const folderStore = await readMediaFolderStore();
  await writeMediaFolderStore({
    ...folderStore,
    assignments: {
      ...folderStore.assignments,
      [mediaId]: folderId
    },
    updatedAt: new Date().toISOString(),
    version: folderStore.version + 1
  });
}

function uploadTargetMatches(mediaId: string, fileName: string, sourceObjectKey: string): boolean {
  return sourceObjectKey.startsWith("uploads/") && sourceObjectKey.endsWith(`/${mediaId}/${fileName}`);
}

async function createUploadTarget(body: CloudUploadRequest) {
  const config = cloudMediaConfig();
  if (!config) {
    return NextResponse.json({ error: "Direct cloud uploads are only available in AWS mode." }, { status: 400 });
  }

  const fileName = sanitizeMediaFileName(stringFromUnknown(body.fileName));
  const sizeBytes = positiveSizeFromUnknown(body.sizeBytes);
  const mimeType = stringFromUnknown(body.mimeType) || "application/octet-stream";
  await validateFolderId(body.folderId);

  const existing = await findCloudMediaBySourceFileName(config, fileName);
  if (existing) {
    return NextResponse.json({ item: existing, skipped: true });
  }

  const upload = await createCloudMediaDirectUploadTarget(config, {
    fileName,
    mimeType,
    sizeBytes
  });

  return NextResponse.json({ upload }, { status: 201 });
}

async function completeUpload(body: CloudUploadRequest) {
  const config = cloudMediaConfig();
  if (!config) {
    return NextResponse.json({ error: "Direct cloud uploads are only available in AWS mode." }, { status: 400 });
  }

  const fileName = sanitizeMediaFileName(stringFromUnknown(body.fileName));
  const mediaId = stringFromUnknown(body.mediaId).trim();
  const sourceObjectKey = stringFromUnknown(body.sourceObjectKey).trim();
  const sizeBytes = positiveSizeFromUnknown(body.sizeBytes);
  const mimeType = stringFromUnknown(body.mimeType) || "application/octet-stream";
  const folderId = await validateFolderId(body.folderId);

  if (!mediaId || !sourceObjectKey) {
    throw new MediaUploadError("Upload completion is missing the upload target.", 400);
  }
  if (!uploadTargetMatches(mediaId, fileName, sourceObjectKey)) {
    throw new MediaUploadError("Upload completion did not match the signed upload target.", 400);
  }

  const existing = await findCloudMediaBySourceFileName(config, fileName);
  if (existing) {
    await deleteCloudUploadedSourceObject(config, sourceObjectKey);
    return NextResponse.json({ item: existing, skipped: true });
  }

  const item = await createCloudMediaRecordFromUploadedSource(config, {
    description: stringFromUnknown(body.description),
    durationSeconds: imageDurationFromForm(durationEntryFromUnknown(body.durationSeconds)),
    fileName,
    mediaId,
    mimeType,
    sizeBytes,
    sourceObjectKey,
    tags: tagsFromUnknown(body.tags),
    title: stringFromUnknown(body.title)
  });
  await assignMediaFolder(item.id, folderId);
  const result = await startCloudMediaPreparationWorker(config, item.id);

  return NextResponse.json({
    item: result.item ?? item,
    preparing: result.preparing,
    skipped: false
  }, { status: result.preparing ? 202 : 201 });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as CloudUploadRequest | null;
    if (!body) {
      return NextResponse.json({ error: "Upload request must be JSON." }, { status: 400 });
    }

    if (body.action === "create") {
      return createUploadTarget(body);
    }
    if (body.action === "complete") {
      return completeUpload(body);
    }

    return NextResponse.json({ error: "Upload action must be create or complete." }, { status: 400 });
  } catch (error) {
    const status = error instanceof MediaUploadError ? error.status : 500;
    if (status >= 500) {
      console.error("cloud direct media upload failed", error);
    }

    return apiErrorResponse(error, "Cloud media upload failed.");
  }
}
