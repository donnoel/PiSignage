import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  type MediaFolderStore,
  type MediaRecord,
  readMediaFolderStore,
  readMediaStore,
  writeMediaFolderStore,
  writeMediaStore
} from "../../lib/local-data-store";
import { readPlaylistStore, sampleAssetsDirectory, writeFileAtomic } from "../../lib/local-playlist";
import type { PlaylistAsset } from "../../lib/local-playlist";
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

type MediaApiItem = MediaRecord & {
  folderId: string | null;
  folderName: string | null;
  missingFile: boolean;
  origin: "media-store" | "playlist";
  playlistAssetIds: string[];
  playlistUseCount: number;
};

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

function normalizeFolderId(value: FormDataEntryValue | null, folderStore: MediaFolderStore): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const folderId = value.trim();
  if (!folderStore.items.some((folder) => folder.id === folderId)) {
    throw new MediaUploadError("Folder not found.", 400);
  }

  return folderId;
}

function assignedFolderId(
  mediaId: string,
  folderStore: MediaFolderStore,
  folderById: Map<string, string>
): string | null {
  const folderId = folderStore.assignments[mediaId] ?? null;
  return folderId && folderById.has(folderId) ? folderId : null;
}

function playlistAssetFileName(asset: PlaylistAsset): string | null {
  if (!asset.uri.startsWith("assets/")) {
    return null;
  }

  return path.basename(asset.uri);
}

async function fileSizeForPlaybackFile(fileName: string): Promise<{ missingFile: boolean; sizeBytes: number }> {
  try {
    const stat = await fs.stat(path.join(sampleAssetsDirectory(), fileName));
    return { missingFile: false, sizeBytes: stat.size };
  } catch {
    return { missingFile: true, sizeBytes: 0 };
  }
}

function playlistAssetRecord(
  fileName: string,
  assets: PlaylistAsset[],
  playlistUpdatedAt: string,
  sizeBytes: number,
  missingFile: boolean,
  folderStore: MediaFolderStore,
  folderById: Map<string, string>
): MediaApiItem {
  const primaryAsset = assets[0];
  const itemId = `playlist:${primaryAsset.assetId}`;
  const folderId = assignedFolderId(itemId, folderStore, folderById);

  return {
    id: itemId,
    title: primaryAsset.altText?.trim() || baseTitleFromFileName(fileName),
    description: "",
    tags: [],
    sourceFileName: fileName,
    playbackFileName: fileName,
    mimeType: mimeTypeFromExtension(fileName),
    sizeBytes,
    durationSeconds: primaryAsset.durationSeconds ?? null,
    status: missingFile ? "failed" : "ready",
    createdAt: playlistUpdatedAt,
    updatedAt: playlistUpdatedAt,
    folderId,
    folderName: folderId ? folderById.get(folderId) ?? null : null,
    origin: "playlist",
    missingFile,
    playlistAssetIds: assets.map((asset) => asset.assetId),
    playlistUseCount: assets.length
  };
}

async function mediaItemsWithPlaylistAssets(
  mediaStoreItems: MediaRecord[],
  folderStore: MediaFolderStore
): Promise<MediaApiItem[]> {
  const playlistStore = await readPlaylistStore();
  const playlistAssetsByFileName = new Map<string, PlaylistAsset[]>();
  const folderById = new Map(folderStore.items.map((folder) => [folder.id, folder.name]));

  for (const playlist of playlistStore.items) {
    for (const asset of playlist.assets) {
      const fileName = playlistAssetFileName(asset);
      if (!fileName) {
        continue;
      }

      const assets = playlistAssetsByFileName.get(fileName) ?? [];
      assets.push(asset);
      playlistAssetsByFileName.set(fileName, assets);
    }
  }

  const storeFileNames = new Set(mediaStoreItems.map((item) => item.playbackFileName));
  const storeItems = await Promise.all(
    mediaStoreItems.map(async (item): Promise<MediaApiItem> => {
      const playlistAssets = playlistAssetsByFileName.get(item.playbackFileName) ?? [];
      const fileState = await fileSizeForPlaybackFile(item.playbackFileName);
      const folderId = assignedFolderId(item.id, folderStore, folderById);

      return {
        ...item,
        folderId,
        folderName: folderId ? folderById.get(folderId) ?? null : null,
        sizeBytes: item.sizeBytes || fileState.sizeBytes,
        status: fileState.missingFile ? "failed" : item.status,
        origin: "media-store",
        missingFile: fileState.missingFile,
        playlistAssetIds: playlistAssets.map((asset) => asset.assetId),
        playlistUseCount: playlistAssets.length
      };
    })
  );

  const playlistOnlyItems = await Promise.all(
    Array.from(playlistAssetsByFileName.entries())
      .filter(([fileName]) => !storeFileNames.has(fileName))
      .map(async ([fileName, assets]) => {
        const fileState = await fileSizeForPlaybackFile(fileName);
        return playlistAssetRecord(
          fileName,
          assets,
          playlistStore.updatedAt,
          fileState.sizeBytes,
          fileState.missingFile,
          folderStore,
          folderById
        );
      })
  );

  return [...storeItems, ...playlistOnlyItems];
}

export async function GET(request: Request) {
  await ensureLocalDataFoundation();
  const [mediaStore, folderStore] = await Promise.all([readMediaStore(), readMediaFolderStore()]);
  const mediaItems = await mediaItemsWithPlaylistAssets(mediaStore.items, folderStore);
  const { searchParams } = new URL(request.url);
  const cursor = parsePositiveInt(searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
  const limit = parsePositiveInt(searchParams.get("limit"), 50, 200);
  const query = normalize(searchParams.get("q") ?? "");
  const requiredTag = normalize(searchParams.get("tag") ?? "");

  const filteredItems = mediaItems.filter((item) => {
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
      `${item.title}\n${item.description}\n${item.tags.join(" ")}\n${item.playbackFileName}\n${item.sourceFileName}\n${item.origin}`
        + `\n${item.folderName ?? ""}`
    );
    return haystack.includes(query);
  });

  const sortedItems = filteredItems
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const nextCursorValue = cursor + limit;
  const items = sortedItems.slice(cursor, nextCursorValue);

  return NextResponse.json({
    folders: folderStore.items,
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
    const folderStore = await readMediaFolderStore();
    const folderId = normalizeFolderId(formData.get("folderId"), folderStore);
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

    if (folderId) {
      await writeMediaFolderStore({
        ...folderStore,
        assignments: {
          ...folderStore.assignments,
          [item.id]: folderId
        },
        version: folderStore.version + 1,
        updatedAt: now
      });
    }

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
