import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "../../../lib/api-error-response";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  readLayoutStore,
  readMediaStore,
  writeLayoutStore,
  writeMediaStore
} from "../../../lib/local-data-store";
import type { MediaRecord } from "../../../lib/local-data-store";
import type { LayoutMediaLayer, LayoutTemplate } from "../../../lib/layout-contract";
import { renderLayoutToVideo } from "../../../lib/layout-renderer";
import type { LayoutMediaSource } from "../../../lib/layout-renderer";
import { readPlaylistStore, sampleAssetsDirectory } from "../../../lib/local-playlist";
import {
  assertPlaybackSafeVideoFile,
  MediaUploadError,
  playbackPrepProfile,
  sha256ForFile,
  slugify,
  uniqueFileName
} from "../../../lib/media-processing";
import { activeWorkspaceSession, workspaceContextFromSession } from "../../../lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class LayoutRenderApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type RenderInput = {
  layoutId?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readRenderInput(request: Request): Promise<RenderInput> {
  const input = await request.json();
  if (!isRecord(input)) {
    throw new LayoutRenderApiError("Render request body must be an object.");
  }

  return input;
}

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nowIso(): string {
  return new Date().toISOString();
}

function layoutMediaIds(layout: LayoutTemplate): string[] {
  return Array.from(
    new Set(
      layout.layers
        .filter((layer): layer is LayoutMediaLayer => layer.kind === "media")
        .map((layer) => layer.mediaId)
    )
  );
}

function playlistFileNameFromUri(uri: string): string | null {
  if (!uri.startsWith("assets/")) {
    return null;
  }

  return path.basename(uri);
}

async function mediaSourcesById(): Promise<Map<string, LayoutMediaSource>> {
  const [mediaStore, playlistStore] = await Promise.all([readMediaStore(), readPlaylistStore()]);
  const sources = new Map<string, LayoutMediaSource>();
  const assetsDirectory = sampleAssetsDirectory();

  for (const item of mediaStore.items) {
    if (item.status === "ready") {
      sources.set(item.id, {
        filePath: path.join(assetsDirectory, path.basename(item.playbackFileName)),
        mediaId: item.id
      });
    }
  }

  for (const playlist of playlistStore.items) {
    for (const asset of playlist.assets) {
      const fileName = playlistFileNameFromUri(asset.uri);
      if (fileName) {
        sources.set(`playlist:${asset.assetId}`, {
          filePath: path.join(assetsDirectory, fileName),
          mediaId: `playlist:${asset.assetId}`
        });
      }
    }
  }

  return sources;
}

async function assertMediaFilesExist(layout: LayoutTemplate, sources: Map<string, LayoutMediaSource>): Promise<void> {
  for (const mediaId of layoutMediaIds(layout)) {
    const source = sources.get(mediaId);
    if (!source) {
      throw new LayoutRenderApiError(`Layout media item ${mediaId} was not found or is not ready.`, 404);
    }

    try {
      await fs.access(source.filePath);
    } catch {
      throw new LayoutRenderApiError(`Layout media file ${path.basename(source.filePath)} is missing.`, 404);
    }
  }
}

function mediaRecordFromRender(layout: LayoutTemplate, playbackFileName: string, file: Awaited<ReturnType<typeof fs.stat>>, probe: Awaited<ReturnType<typeof assertPlaybackSafeVideoFile>>, checksumSha256: string, timestamp: string): MediaRecord {
  const title = `${layout.name} render`;
  return {
    audioCodec: probe.audioCodec,
    bitRate: probe.bitRate,
    checksumSha256,
    createdAt: timestamp,
    description: `Rendered local layout template ${layout.name}.`,
    durationSeconds: Math.round(probe.durationSeconds ?? layout.durationSeconds),
    fps: probe.averageFps ?? probe.fps,
    height: probe.height,
    id: randomUUID(),
    mimeType: "video/mp4",
    pixelFormat: probe.pixelFormat,
    playbackFileName,
    playbackProfile: playbackPrepProfile.id,
    preparedAt: timestamp,
    sizeBytes: Number(file.size),
    sourceFileName: playbackFileName,
    status: "ready",
    tags: ["layout"],
    title,
    updatedAt: timestamp,
    videoCodec: probe.videoCodec,
    videoProfile: probe.videoProfile,
    width: probe.width
  };
}

function errorResponse(error: unknown, fallback: string) {
  const status =
    error instanceof LayoutRenderApiError
      ? error.status
      : error instanceof MediaUploadError
        ? error.status
        : 500;

  return apiErrorResponse(error, fallback, status);
}

export async function POST(request: Request) {
  let layoutForFailure: LayoutTemplate | null = null;

  try {
    await ensureLocalDataFoundation();
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
    const input = await readRenderInput(request);
    const layoutId = normalizeId(input.layoutId);
    if (!layoutId) {
      throw new LayoutRenderApiError("Choose a layout to render.");
    }

    const layoutStore = await readLayoutStore();
    const layoutIndex = layoutStore.items.findIndex((item) => item.id === layoutId);
    if (layoutIndex === -1) {
      throw new LayoutRenderApiError("Layout was not found.", 404);
    }

    const layout = layoutStore.items[layoutIndex];
    layoutForFailure = layout;
    const sources = await mediaSourcesById();
    await assertMediaFilesExist(layout, sources);

    const assetsDirectory = sampleAssetsDirectory();
    const playbackFileName = await uniqueFileName(
      assetsDirectory,
      `layout-${slugify(layout.name) || "render"}.signage-1080p.mp4`
    );
    const outputPath = path.join(assetsDirectory, playbackFileName);
    await renderLayoutToVideo(layout, sources, outputPath);

    const [file, probe, checksumSha256] = await Promise.all([
      fs.stat(outputPath),
      assertPlaybackSafeVideoFile(outputPath),
      sha256ForFile(outputPath)
    ]);
    const timestamp = nowIso();
    const mediaRecord = mediaRecordFromRender(layout, playbackFileName, file, probe, checksumSha256, timestamp);
    const mediaStore = await readMediaStore();

    await writeMediaStore({
      ...mediaStore,
      items: [mediaRecord, ...mediaStore.items],
      updatedAt: timestamp,
      version: mediaStore.version + 1
    });

    const renderedLayout: LayoutTemplate = {
      ...layout,
      render: {
        mediaId: mediaRecord.id,
        playbackFileName,
        renderedAt: timestamp,
        status: "ready"
      },
      updatedAt: timestamp,
      version: layout.version + 1
    };
    const nextLayouts = [...layoutStore.items];
    nextLayouts[layoutIndex] = renderedLayout;
    await writeLayoutStore({
      ...layoutStore,
      items: nextLayouts,
      updatedAt: timestamp,
      version: layoutStore.version + 1
    });
    await appendActivityRecord({
      id: randomUUID(),
      action: "layout-render",
      actor: context.userId,
      entityId: renderedLayout.id,
      entityType: "layout",
      message: `Rendered layout ${renderedLayout.name} to ${playbackFileName}. No playlist or screen publish was changed.`,
      result: "success",
      timestamp
    });

    return NextResponse.json({
      layout: renderedLayout,
      media: mediaRecord,
      message: "Rendered to Media Store. No playlist or screen publish was changed."
    });
  } catch (error) {
    console.error("layout render failed", error);

    if (layoutForFailure) {
      try {
        const timestamp = nowIso();
        const store = await readLayoutStore();
        const index = store.items.findIndex((item) => item.id === layoutForFailure?.id);
        if (index !== -1) {
          const nextItems = [...store.items];
          nextItems[index] = {
            ...nextItems[index],
            render: {
              failedAt: timestamp,
              message: error instanceof Error ? error.message : "Layout render failed.",
              status: "failed"
            },
            updatedAt: timestamp,
            version: nextItems[index].version + 1
          };
          await writeLayoutStore({
            ...store,
            items: nextItems,
            updatedAt: timestamp,
            version: store.version + 1
          });
        }
      } catch (writeError) {
        console.error("layout render failure state write failed", writeError);
      }
    }

    return errorResponse(error, "Layout render failed.");
  }
}
