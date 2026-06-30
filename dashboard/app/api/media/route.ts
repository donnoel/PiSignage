import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  cloudMediaConfig,
  cloudUploadInputFromForm,
  createCloudMediaUpload,
  deleteCloudMediaRecords,
  readCloudMediaStore
} from "../../lib/cloud-media-store";
import { startCloudMediaPreparationWorker } from "../../lib/cloud-media-preparation-worker";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  type MediaFolderStore,
  type MediaRecord,
  readMediaStore,
  writeMediaStore
} from "../../lib/local-data-store";
import { apiErrorResponse } from "../../lib/api-error-response";
import { readMediaFolderStore, writeMediaFolderStore } from "../../lib/media-folder-store";
import { sampleAssetsDirectory, writeFileAtomic } from "../../lib/local-playlist";
import type { PlaylistAsset } from "../../lib/local-playlist";
import { readPlaylistStore } from "../../lib/playlist-store";
import {
  playlistAssetFileName,
  playlistAssetsForMediaRecord,
  playlistFileNamesInUse,
  playlistUsesMediaRecord
} from "../../lib/media-playlist-usage";
import {
  assertPlaybackSafeVideoFile,
  createPlaybackSafeVideoClip,
  createStillVideoClip,
  defaultDurationSeconds,
  formatUploadLimit,
  imageDurationFromForm,
  maxUploadBytes,
  MediaUploadError,
  mediaSourceTypeFromFileName,
  playbackPrepProfile,
  sanitizeMediaFileName,
  sha256ForFile,
  stillClipFileName,
  transcodedVideoFileName,
  uniqueFileName
} from "../../lib/media-processing";
import { activeWorkspaceSession, workspaceContextFromSession } from "../../lib/workspace";

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

type BulkDeleteMediaResult = {
  blockedIds: string[];
  deletedIds: string[];
  missingIds: string[];
};

function mediaApiItemFromCloudRecord(
  item: MediaRecord,
  playlistAssets: PlaylistAsset[] = [],
  folderStore?: MediaFolderStore
): MediaApiItem {
  const folderById = new Map((folderStore?.items ?? []).map((folder) => [folder.id, folder.name]));
  const folderId = folderStore ? assignedFolderId(item.id, folderStore, folderById) : null;

  return {
    ...item,
    folderId,
    folderName: folderId ? folderById.get(folderId) ?? null : null,
    missingFile: false,
    origin: "media-store",
    playlistAssetIds: playlistAssets.map((asset) => asset.assetId),
    playlistUseCount: playlistAssets.length
  };
}

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

function roundedPositiveDuration(value: number | null, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.round(value));
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

function requestedMediaIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 500)
    )
  );
}

async function deleteMediaRecords(mediaIds: string[], actor: string): Promise<BulkDeleteMediaResult> {
  const mediaStore = await readMediaStore();
  const requestedIds = new Set(mediaIds.filter((id) => !id.startsWith("playlist:")));
  const missingIds = mediaIds.filter((id) => id.startsWith("playlist:"));
  const playlistFileNames = await playlistFileNamesInUse();
  const deletedIds: string[] = [];
  const blockedIds: string[] = [];
  const deletedFileNames = new Set<string>();

  for (const item of mediaStore.items) {
    if (!requestedIds.has(item.id)) {
      continue;
    }

    if (playlistFileNames.has(item.playbackFileName)) {
      blockedIds.push(item.id);
      continue;
    }

    deletedIds.push(item.id);
    deletedFileNames.add(item.playbackFileName);
  }

  for (const id of requestedIds) {
    if (
      !deletedIds.includes(id) &&
      !blockedIds.includes(id) &&
      !mediaStore.items.some((item) => item.id === id)
    ) {
      missingIds.push(id);
    }
  }

  if (deletedIds.length === 0) {
    return { blockedIds, deletedIds, missingIds };
  }

  const now = new Date().toISOString();
  const deletedIdSet = new Set(deletedIds);
  const nextItems = mediaStore.items.filter((item) => !deletedIdSet.has(item.id));
  const folderStore = await readMediaFolderStore();
  const assignments = { ...folderStore.assignments };

  for (const id of deletedIds) {
    delete assignments[id];
  }

  await writeMediaStore({
    ...mediaStore,
    items: nextItems,
    version: mediaStore.version + 1,
    updatedAt: now
  });
  await writeMediaFolderStore({
    ...folderStore,
    assignments,
    version: folderStore.version + 1,
    updatedAt: now
  });

  for (const fileName of deletedFileNames) {
    const fileStillReferenced = nextItems.some((item) => item.playbackFileName === fileName);
    if (!fileStillReferenced && !playlistFileNames.has(fileName)) {
      await fs.rm(path.join(sampleAssetsDirectory(), path.basename(fileName)), { force: true });
    }
  }

  await appendActivityRecord({
    id: randomUUID(),
    action: "media-bulk-delete",
    actor,
    entityId: deletedIds.join(","),
    entityType: "media",
    message: `Deleted ${deletedIds.length} media item${deletedIds.length === 1 ? "" : "s"} from media store.`,
    result: blockedIds.length > 0 ? "warning" : "success",
    timestamp: now
  });

  return { blockedIds, deletedIds, missingIds };
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

async function cloudMediaItemsWithPlaylistAssets(
  mediaStoreItems: MediaRecord[],
  folderStore: MediaFolderStore
): Promise<MediaApiItem[]> {
  return Promise.all(
    mediaStoreItems.map(async (item) => mediaApiItemFromCloudRecord(item, await playlistAssetsForMediaRecord(item), folderStore))
  );
}

async function cloudPlaylistBlockedMediaIds(mediaStoreItems: MediaRecord[]): Promise<Set<string>> {
  const blockedEntries = await Promise.all(
    mediaStoreItems.map(async (item) => [item.id, await playlistUsesMediaRecord(item)] as const)
  );

  return new Set(blockedEntries.filter(([, isBlocked]) => isBlocked).map(([id]) => id));
}

export async function GET(request: Request) {
  const session = activeWorkspaceSession();
  const context = workspaceContextFromSession(session);
  const cloudConfig = cloudMediaConfig();
  if (cloudConfig) {
    const [mediaStore, folderStore] = await Promise.all([readCloudMediaStore(cloudConfig), readMediaFolderStore()]);
    const mediaItems = await cloudMediaItemsWithPlaylistAssets(mediaStore.items, folderStore);
    const { searchParams } = new URL(request.url);
    const cursor = parsePositiveInt(searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
    const limit = parsePositiveInt(searchParams.get("limit"), 50, 200);
    const query = normalize(searchParams.get("q") ?? "");
    const requiredTag = normalize(searchParams.get("tag") ?? "");

    const filteredItems = mediaItems.filter((item) => {
      if (requiredTag && !item.tags.some((tag) => normalize(tag) === requiredTag)) {
        return false;
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
      activeWorkspaceId: context.activeWorkspaceId,
      folders: folderStore.items,
      items,
      version: mediaStore.version,
      updatedAt: mediaStore.updatedAt,
      userId: context.userId,
      pagination: {
        cursor,
        hasMore: nextCursorValue < sortedItems.length,
        limit,
        nextCursor: nextCursorValue < sortedItems.length ? String(nextCursorValue) : null,
        total: sortedItems.length
      }
    });
  }

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
    activeWorkspaceId: context.activeWorkspaceId,
    folders: folderStore.items,
    items,
    version: mediaStore.version,
    updatedAt: mediaStore.updatedAt,
    userId: context.userId,
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
  try {
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
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
    const cloudConfig = cloudMediaConfig();
    if (cloudConfig) {
      const folderStore = await readMediaFolderStore();
      const folderId = normalizeFolderId(formData.get("folderId"), folderStore);
      const input = await cloudUploadInputFromForm(file, formData, parseTags(formData.get("tags")));
      const item = await createCloudMediaUpload(cloudConfig, input);
      const now = new Date().toISOString();
      const nextFolderStore = folderId
        ? {
            ...folderStore,
            assignments: {
              ...folderStore.assignments,
              [item.id]: folderId
            },
            updatedAt: now,
            version: folderStore.version + 1
          }
        : folderStore;
      if (folderId) {
        await writeMediaFolderStore(nextFolderStore);
      }
      if (item.status === "ready") {
        return NextResponse.json({ item: mediaApiItemFromCloudRecord(item, [], nextFolderStore) }, { status: 201 });
      }

      const { item: preparingItem } = await startCloudMediaPreparationWorker(cloudConfig, item.id);
      return NextResponse.json({ item: mediaApiItemFromCloudRecord(preparingItem ?? item, [], nextFolderStore) }, { status: 201 });
    }

    await ensureLocalDataFoundation();
    const folderStore = await readMediaFolderStore();
    const folderId = normalizeFolderId(formData.get("folderId"), folderStore);
    const sourceType = mediaSourceTypeFromFileName(safeFileName);
    const stillDurationSeconds = imageDurationFromForm(formData.get("durationSeconds"));
    const uploadedBytes = Buffer.from(await file.arrayBuffer());
    const assetsDirectory = sampleAssetsDirectory();
    const isVideoSource = sourceType === "video";
    const playbackFileName = await uniqueFileName(
      assetsDirectory,
      sourceType === "image"
        ? stillClipFileName(safeFileName, stillDurationSeconds)
        : isVideoSource
          ? transcodedVideoFileName(safeFileName)
          : safeFileName
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
    } else if (isVideoSource) {
      const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pisignage-media-store-video-"));
      const sourceVideoPath = path.join(temporaryDirectory, safeFileName);

      try {
        await writeFileAtomic(sourceVideoPath, uploadedBytes);
        await createPlaybackSafeVideoClip(sourceVideoPath, playbackFilePath);
      } finally {
        await fs.rm(temporaryDirectory, { force: true, recursive: true });
      }
    }

    const playbackProbe = await assertPlaybackSafeVideoFile(playbackFilePath);
    const checksumSha256 = await sha256ForFile(playbackFilePath);
    const now = new Date().toISOString();
    const playbackFile = await fs.stat(playbackFilePath);
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
      mimeType: "video/mp4",
      sizeBytes: playbackFile.size,
      sourceSizeBytes: uploadedBytes.byteLength,
      durationSeconds:
        sourceType === "image"
          ? stillDurationSeconds
          : roundedPositiveDuration(playbackProbe.durationSeconds, defaultDurationSeconds),
      checksumSha256,
      playbackProfile: playbackPrepProfile.id,
      preparedAt: now,
      width: playbackProbe.width,
      height: playbackProbe.height,
      fps: playbackProbe.fps,
      videoCodec: playbackProbe.videoCodec,
      videoProfile: playbackProbe.videoProfile,
      pixelFormat: playbackProbe.pixelFormat,
      audioCodec: playbackProbe.audioCodec,
      bitRate: playbackProbe.bitRate,
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
      actor: context.userId,
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
    return apiErrorResponse(error, "Media upload failed.");
  }
}

export async function DELETE(request: Request) {
  try {
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
    const body = (await request.json().catch(() => ({}))) as {
      mediaIds?: unknown;
    };
    const mediaIds = requestedMediaIds(body.mediaIds);
    if (mediaIds.length === 0) {
      return NextResponse.json({ error: "Choose media to delete." }, { status: 400 });
    }

    const cloudConfig = cloudMediaConfig();
    if (cloudConfig) {
      const mediaStore = await readCloudMediaStore(cloudConfig);
      const result = await deleteCloudMediaRecords(
        cloudConfig,
        mediaIds,
        await cloudPlaylistBlockedMediaIds(mediaStore.items)
      );
      if (result.deletedIds.length === 0 && result.blockedIds.length > 0) {
        return NextResponse.json(
          {
            ...result,
            deleted: 0,
            error: "Selected media is still used by a playlist. Remove it from playlists before deleting it."
          },
          { status: 409 }
        );
      }

      return NextResponse.json({
        ...result,
        deleted: result.deletedIds.length
      });
    }

    await ensureLocalDataFoundation();
    const result = await deleteMediaRecords(mediaIds, context.userId);
    if (result.deletedIds.length === 0 && result.blockedIds.length > 0) {
      return NextResponse.json(
        {
          ...result,
          deleted: 0,
          error: "Selected media is still used by a playlist. Remove it from playlists before deleting it."
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      ...result,
      deleted: result.deletedIds.length
    });
  } catch (error) {
    console.error("bulk media delete failed", error);
    return apiErrorResponse(error, "Bulk media delete failed.");
  }
}
