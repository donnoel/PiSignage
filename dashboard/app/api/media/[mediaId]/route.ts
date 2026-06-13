import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  cloudMediaConfig,
  deleteCloudMediaRecords,
  readCloudMediaStore,
  updateCloudMediaMetadata
} from "../../../lib/cloud-media-store";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  readMediaStore,
  writeMediaStore
} from "../../../lib/local-data-store";
import { apiErrorResponse } from "../../../lib/api-error-response";
import { readMediaFolderStore, writeMediaFolderStore } from "../../../lib/media-folder-store";
import { sampleAssetsDirectory } from "../../../lib/local-playlist";
import type { PlaylistAsset } from "../../../lib/local-playlist";
import {
  playlistAssetFileName,
  playlistUsesFile,
  playlistUsesMediaRecord
} from "../../../lib/media-playlist-usage";
import { readPlaylistStore } from "../../../lib/playlist-store";
import { activeWorkspaceSession, workspaceContextFromSession } from "../../../lib/workspace";

type RouteContext = {
  params: Promise<{
    mediaId: string;
  }>;
};

export const dynamic = "force-dynamic";

function parseTags(value: unknown): string[] {
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

async function playlistAssetForMediaId(mediaId: string): Promise<PlaylistAsset | null> {
  if (!mediaId.startsWith("playlist:")) {
    return null;
  }

  const assetId = mediaId.replace(/^playlist:/, "");
  const playlistStore = await readPlaylistStore();
  for (const playlist of playlistStore.items) {
    const asset = playlist.assets.find((candidate) => candidate.assetId === assetId);
    if (asset) {
      return asset;
    }
  }

  return null;
}

export async function GET(_request: Request, context: RouteContext) {
  const session = activeWorkspaceSession();
  const workspaceContext = workspaceContextFromSession(session);
  const cloudConfig = cloudMediaConfig();
  if (cloudConfig) {
    const { mediaId } = await context.params;
    const mediaStore = await readCloudMediaStore(cloudConfig);
    const item = mediaStore.items.find((candidate) => candidate.id === mediaId);

    if (!item) {
      return NextResponse.json({ error: "Media item not found." }, { status: 404 });
    }

    return NextResponse.json({
      activeWorkspaceId: workspaceContext.activeWorkspaceId,
      item,
      userId: workspaceContext.userId
    });
  }

  await ensureLocalDataFoundation();
  const { mediaId } = await context.params;
  const mediaStore = await readMediaStore();
  const item = mediaStore.items.find((candidate) => candidate.id === mediaId);

  if (!item) {
    return NextResponse.json({ error: "Media item not found." }, { status: 404 });
  }

  return NextResponse.json({
    activeWorkspaceId: workspaceContext.activeWorkspaceId,
    item,
    userId: workspaceContext.userId
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { mediaId } = await context.params;

  try {
    const session = activeWorkspaceSession();
    const workspaceContext = workspaceContextFromSession(session);
    const body = (await request.json()) as {
      description?: string;
      tags?: string;
      title?: string;
    };

    const cloudConfig = cloudMediaConfig();
    if (cloudConfig) {
      const updated = await updateCloudMediaMetadata(cloudConfig, mediaId, {
        description: body.description,
        tags: Object.prototype.hasOwnProperty.call(body, "tags") ? parseTags(body.tags) : undefined,
        title: body.title
      });

      if (!updated) {
        return NextResponse.json({ error: "Media item not found." }, { status: 404 });
      }

      return NextResponse.json({ item: updated });
    }

    await ensureLocalDataFoundation();
    const mediaStore = await readMediaStore();
    const index = mediaStore.items.findIndex((candidate) => candidate.id === mediaId);

    const playlistAsset = index === -1 ? await playlistAssetForMediaId(mediaId) : null;
    if (index === -1 && !playlistAsset) {
      return NextResponse.json({ error: "Media item not found." }, { status: 404 });
    }

    const playbackFileName = playlistAsset ? playlistAssetFileName(playlistAsset) : null;
    if (playlistAsset && !playbackFileName) {
      return NextResponse.json({ error: "Only local playlist media can be tagged." }, { status: 400 });
    }

    const current = index === -1 && playlistAsset && playbackFileName
      ? {
          id: randomUUID(),
          title: playlistAsset.altText?.trim() || baseTitleFromFileName(playbackFileName),
          description: "",
          tags: [],
          sourceFileName: playbackFileName,
          playbackFileName,
          mimeType: mimeTypeFromExtension(playbackFileName),
          sizeBytes: 0,
          durationSeconds: playlistAsset.durationSeconds ?? null,
          status: "ready" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      : mediaStore.items[index];
    const nextTitle = typeof body.title === "string" ? body.title.trim().slice(0, 120) : current.title;
    if (!nextTitle) {
      return NextResponse.json({ error: "Title is required." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const updated = {
      ...current,
      title: nextTitle,
      description:
        typeof body.description === "string"
          ? body.description.trim().slice(0, 5000)
          : current.description,
      tags: Object.prototype.hasOwnProperty.call(body, "tags") ? parseTags(body.tags) : current.tags,
      updatedAt: now
    };

    const nextItems = [...mediaStore.items];
    if (index === -1) {
      nextItems.unshift(updated);
    } else {
      nextItems[index] = updated;
    }
    await writeMediaStore({
      ...mediaStore,
      items: nextItems,
      version: mediaStore.version + 1,
      updatedAt: now
    });

    await appendActivityRecord({
      id: randomUUID(),
      action: "media-update",
      actor: workspaceContext.userId,
      entityId: updated.id,
      entityType: "media",
      message: `Updated metadata for ${updated.playbackFileName}.`,
      result: "success",
      timestamp: now
    });

    return NextResponse.json({ item: updated });
  } catch (error) {
    console.error("media store update failed", error);
    return apiErrorResponse(error, "Failed to update media item.");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { mediaId } = await context.params;

  if (mediaId.startsWith("playlist:")) {
    return NextResponse.json(
      { error: "This item is in the playlist. Remove it from the playlist before deleting it here." },
      { status: 409 }
    );
  }

  try {
    const session = activeWorkspaceSession();
    const workspaceContext = workspaceContextFromSession(session);
    const cloudConfig = cloudMediaConfig();
    if (cloudConfig) {
      const mediaStore = await readCloudMediaStore(cloudConfig);
      const current = mediaStore.items.find((candidate) => candidate.id === mediaId);

      if (!current) {
        return NextResponse.json({ error: "Media item not found." }, { status: 404 });
      }

      if (await playlistUsesMediaRecord(current)) {
        return NextResponse.json(
          { error: "This media is in the playlist. Remove it from the playlist before deleting it." },
          { status: 409 }
        );
      }

      const result = await deleteCloudMediaRecords(cloudConfig, [mediaId]);
      if (result.deletedIds.length === 0) {
        return NextResponse.json({ error: "Media item not found." }, { status: 404 });
      }

      return NextResponse.json({ deleted: true, item: current });
    }

    await ensureLocalDataFoundation();
    const mediaStore = await readMediaStore();
    const index = mediaStore.items.findIndex((candidate) => candidate.id === mediaId);

    if (index === -1) {
      return NextResponse.json({ error: "Media item not found." }, { status: 404 });
    }

    const current = mediaStore.items[index];
    if (await playlistUsesFile(current.playbackFileName)) {
      return NextResponse.json(
        { error: "This media is in the playlist. Remove it from the playlist before deleting it." },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const nextItems = mediaStore.items.filter((item) => item.id !== mediaId);
    const folderStore = await readMediaFolderStore();
    const assignments = { ...folderStore.assignments };
    delete assignments[mediaId];

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

    const fileStillReferenced = nextItems.some((item) => item.playbackFileName === current.playbackFileName);
    if (!fileStillReferenced) {
      await fs.rm(path.join(sampleAssetsDirectory(), path.basename(current.playbackFileName)), { force: true });
    }

    await appendActivityRecord({
      id: randomUUID(),
      action: "media-delete",
      actor: workspaceContext.userId,
      entityId: current.id,
      entityType: "media",
      message: `Deleted ${current.playbackFileName} from media store.`,
      result: "success",
      timestamp: now
    });

    return NextResponse.json({ deleted: true, item: current });
  } catch (error) {
    console.error("media store delete failed", error);
    return apiErrorResponse(error, "Failed to delete media item.");
  }
}
