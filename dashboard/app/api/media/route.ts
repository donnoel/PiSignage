import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  readMediaStore,
  writeMediaStore
} from "../../lib/local-data-store";
import { sampleAssetsDirectory, writeFileAtomic } from "../../lib/local-playlist";
import {
  createStillVideoClip,
  defaultDurationSeconds,
  formatUploadLimit,
  imageDurationFromForm,
  maxUploadBytes,
  MediaUploadError,
  mediaSourceTypeFromFileName,
  sanitizeMediaFileName,
  stillClipFileName,
  uniqueFileName
} from "../../lib/media-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseTags(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.slice(0, 48))
    )
  );
}

function baseTitleFromFileName(fileName: string): string {
  const title = path.basename(fileName, path.extname(fileName)).replace(/[-_]+/g, " ").trim();
  return title || "Untitled media";
}

function mimeTypeFromExtension(fileName: string): string {
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

function parsePositiveInt(value: string | null, fallback: number, maximum: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.min(parsed, maximum);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function GET(request: Request) {
  await ensureLocalDataFoundation();
  const mediaStore = await readMediaStore();
  const { searchParams } = new URL(request.url);
  const cursor = parsePositiveInt(searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
  const limit = parsePositiveInt(searchParams.get("limit"), 50, 200);
  const query = normalize(searchParams.get("q") ?? "");
  const requiredTag = normalize(searchParams.get("tag") ?? "");

  const filteredItems = mediaStore.items.filter((item) => {
    if (requiredTag) {
      const hasTag = item.tags.some((tag) => normalize(tag) === requiredTag);
      if (!hasTag) {
        return false;
      }
    }

    if (!query) {
      return true;
    }

    const haystack = normalize(
      `${item.title}\n${item.description}\n${item.tags.join(" ")}\n${item.playbackFileName}\n${item.sourceFileName}`
    );
    return haystack.includes(query);
  });

  const sortedItems = filteredItems
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const nextCursorValue = cursor + limit;
  const items = sortedItems.slice(cursor, nextCursorValue);

  return NextResponse.json({
    items,
    version: mediaStore.version,
    updatedAt: mediaStore.updatedAt,
    pagination: {
      cursor,
      hasMore: nextCursorValue < sortedItems.length,
      limit,
      nextCursor: nextCursorValue < sortedItems.length ? String(nextCursorValue) : null,
      total: sortedItems.length
    }
  });
}

export async function POST(request: Request) {
  await ensureLocalDataFoundation();

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "Upload must be sent as multipart form data." }, { status: 400 });
    }

    const file = formData.get("media");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing media file." }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "The selected media file is empty." }, { status: 400 });
    }

    if (file.size > maxUploadBytes) {
      return NextResponse.json(
        { error: `Media uploads are limited to ${formatUploadLimit(maxUploadBytes)}.` },
        { status: 413 }
      );
    }

    const safeFileName = sanitizeMediaFileName(file.name);
    const sourceType = mediaSourceTypeFromFileName(safeFileName);
    const stillDurationSeconds = imageDurationFromForm(formData.get("durationSeconds"));
    const uploadedBytes = Buffer.from(await file.arrayBuffer());
    const assetsDirectory = sampleAssetsDirectory();
    const playbackFileName = await uniqueFileName(
      assetsDirectory,
      sourceType === "image" ? stillClipFileName(safeFileName, stillDurationSeconds) : safeFileName
    );
    const playbackFilePath = path.join(assetsDirectory, playbackFileName);

    if (sourceType === "image") {
      const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pisignage-media-store-image-"));
      const sourceImagePath = path.join(temporaryDirectory, safeFileName);

      try {
        await writeFileAtomic(sourceImagePath, uploadedBytes);
        await createStillVideoClip(sourceImagePath, playbackFilePath, stillDurationSeconds);
      } finally {
        await fs.rm(temporaryDirectory, { force: true, recursive: true });
      }
    } else {
      await writeFileAtomic(playbackFilePath, uploadedBytes);
    }

    const now = new Date().toISOString();
    const titleEntry = formData.get("title");
    const descriptionEntry = formData.get("description");
    const mediaStore = await readMediaStore();
    const item = {
      id: randomUUID(),
      title:
        typeof titleEntry === "string" && titleEntry.trim()
          ? titleEntry.trim().slice(0, 120)
          : baseTitleFromFileName(safeFileName),
      description: typeof descriptionEntry === "string" ? descriptionEntry.trim().slice(0, 5000) : "",
      tags: parseTags(formData.get("tags")),
      sourceFileName: safeFileName,
      playbackFileName,
      mimeType: file.type || mimeTypeFromExtension(safeFileName),
      sizeBytes: uploadedBytes.byteLength,
      durationSeconds: sourceType === "image" ? stillDurationSeconds : defaultDurationSeconds,
      status: "ready" as const,
      createdAt: now,
      updatedAt: now
    };

    await writeMediaStore({
      ...mediaStore,
      items: [item, ...mediaStore.items],
      version: mediaStore.version + 1,
      updatedAt: now
    });

    await appendActivityRecord({
      id: randomUUID(),
      action: "media-upload",
      actor: "local-operator",
      entityId: item.id,
      entityType: "media",
      message: `Uploaded ${item.playbackFileName} to media store.`,
      result: "success",
      timestamp: now
    });

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    const status = error instanceof MediaUploadError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Media upload failed.";
    if (status >= 500) {
      console.error("media store upload failed", error);
    } else {
      console.warn("media store upload rejected", message);
    }
    return NextResponse.json({ error: message }, { status });
  }
}
