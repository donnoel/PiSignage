import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { appendActivityRecord, readMediaStore } from "../../../lib/local-data-store";
import {
  ensureLivePlaylistPath,
  readPlaylist,
  sampleAssetsDirectory,
  writePlaylist,
  writePublishStatus
} from "../../../lib/local-playlist";
import type { Playlist, PlaylistAsset } from "../../../lib/local-playlist";
import { publishPlaylistToPi } from "../../../lib/pi-local";
import { defaultDurationSeconds, slugify } from "../../../lib/media-processing";

type PlaylistEditAction = "move-up" | "move-down" | "remove" | "update-item" | "add-media" | "reorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function nextAssetId(playlist: Playlist, baseName: string): string {
  const baseAssetId = `asset-${slugify(baseName) || "media"}`;
  const existingAssetIds = new Set(playlist.assets.map((asset) => asset.assetId));
  let assetId = baseAssetId;
  let suffix = 1;

  while (existingAssetIds.has(assetId)) {
    assetId = `${baseAssetId}-${suffix}`;
    suffix += 1;
  }

  return assetId;
}

function playlistAssetFileName(asset: PlaylistAsset): string | null {
  if (!asset.uri.startsWith("assets/")) {
    return null;
  }

  return path.basename(asset.uri);
}

function updatePlaylistOrder(playlist: Playlist, action: PlaylistEditAction, assetId: string): Playlist {
  const index = playlist.assets.findIndex((asset) => asset.assetId === assetId);

  if (index === -1) {
    throw new Error("Playlist item was not found.");
  }

  const assets = [...playlist.assets];

  if (action === "remove") {
    if (assets.length <= 1) {
      throw new Error("At least one playlist item is required.");
    }

    assets.splice(index, 1);
  } else if (action === "move-up") {
    if (index === 0) {
      throw new Error("Playlist item is already first.");
    }

    [assets[index - 1], assets[index]] = [assets[index], assets[index - 1]];
  } else if (action === "move-down") {
    if (index === assets.length - 1) {
      throw new Error("Playlist item is already last.");
    }

    [assets[index], assets[index + 1]] = [assets[index + 1], assets[index]];
  }

  return {
    ...playlist,
    version: playlist.version + 1,
    updatedAt: new Date().toISOString(),
    assets
  };
}

function reorderPlaylist(playlist: Playlist, orderedAssetIds: unknown): Playlist {
  if (!Array.isArray(orderedAssetIds)) {
    throw new Error("Missing playlist order.");
  }

  const normalizedIds = orderedAssetIds.map((assetId) =>
    typeof assetId === "string" ? assetId : ""
  );
  const uniqueIds = new Set(normalizedIds);
  const currentIds = new Set(playlist.assets.map((asset) => asset.assetId));

  if (
    normalizedIds.length !== playlist.assets.length ||
    uniqueIds.size !== playlist.assets.length ||
    normalizedIds.some((assetId) => !currentIds.has(assetId))
  ) {
    throw new Error("Playlist order does not match the current playlist.");
  }

  const assetById = new Map(playlist.assets.map((asset) => [asset.assetId, asset]));

  return {
    ...playlist,
    version: playlist.version + 1,
    updatedAt: new Date().toISOString(),
    assets: normalizedIds.map((assetId) => {
      const asset = assetById.get(assetId);
      if (!asset) {
        throw new Error("Playlist order contains an unknown item.");
      }
      return asset;
    })
  };
}

function updatePlaylistItemDetails(
  playlist: Playlist,
  assetId: string,
  options: { altText?: string; durationSeconds?: number }
): Playlist {
  const index = playlist.assets.findIndex((asset) => asset.assetId === assetId);
  if (index === -1) {
    throw new Error("Playlist item was not found.");
  }

  const current = playlist.assets[index];
  const nextDuration = options.durationSeconds ?? current.durationSeconds ?? defaultDurationSeconds;
  if (!Number.isFinite(nextDuration) || nextDuration < 1 || nextDuration > 3600) {
    throw new Error("Duration must be between 1 and 3600 seconds.");
  }

  const nextAsset: PlaylistAsset = {
    ...current,
    durationSeconds: Math.round(nextDuration),
    altText:
      typeof options.altText === "string" && options.altText.trim()
        ? options.altText.trim().slice(0, 160)
        : current.altText
  };

  const assets = [...playlist.assets];
  assets[index] = nextAsset;

  return {
    ...playlist,
    version: playlist.version + 1,
    updatedAt: new Date().toISOString(),
    assets
  };
}

async function appendMediaStoreItemToPlaylist(playlist: Playlist, mediaId: string): Promise<Playlist> {
  const mediaStore = await readMediaStore();
  const media = mediaStore.items.find((item) => item.id === mediaId);
  if (!media) {
    throw new Error("Media item was not found.");
  }

  if (media.status !== "ready") {
    throw new Error("Only ready media can be added to the playlist.");
  }

  if (path.extname(media.playbackFileName).toLowerCase() !== ".mp4") {
    throw new Error("Only MP4 playback files can be added to the Pi playlist. Convert this media before using it.");
  }

  if (playlist.assets.some((asset) => playlistAssetFileName(asset) === media.playbackFileName)) {
    throw new Error("That media is already in the local playlist.");
  }

  const playbackPath = path.join(sampleAssetsDirectory(), media.playbackFileName);
  try {
    await fs.access(playbackPath);
  } catch {
    throw new Error(`Media file ${media.playbackFileName} is unavailable on disk.`);
  }

  const assetId = nextAssetId(playlist, media.playbackFileName);
  return {
    ...playlist,
    version: playlist.version + 1,
    updatedAt: new Date().toISOString(),
    assets: [
      ...playlist.assets,
      {
        assetId,
        type: "video",
        uri: `assets/${media.playbackFileName}`,
        durationSeconds: media.durationSeconds ?? defaultDurationSeconds,
        altText: media.title
      }
    ]
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: string;
      altText?: string;
      assetId?: string;
      durationSeconds?: number;
      mediaId?: string;
      orderedAssetIds?: string[];
    };

    if (
      body.action !== "move-up" &&
      body.action !== "move-down" &&
      body.action !== "remove" &&
      body.action !== "update-item" &&
      body.action !== "add-media" &&
      body.action !== "reorder"
    ) {
      return NextResponse.json({ error: "Unsupported playlist action." }, { status: 400 });
    }

    if ((body.action === "move-up" || body.action === "move-down" || body.action === "remove" || body.action === "update-item") && !body.assetId) {
      return NextResponse.json({ error: "Missing playlist item." }, { status: 400 });
    }

    if (body.action === "add-media" && !body.mediaId) {
      return NextResponse.json({ error: "Missing media selection." }, { status: 400 });
    }

    const playlistPath = await ensureLivePlaylistPath();
    const playlist = await readPlaylist(playlistPath);
    let nextPlaylist = playlist;
    if (body.action === "add-media") {
      nextPlaylist = await appendMediaStoreItemToPlaylist(playlist, body.mediaId as string);
    } else if (body.action === "reorder") {
      nextPlaylist = reorderPlaylist(playlist, body.orderedAssetIds);
    } else if (body.action === "update-item") {
      nextPlaylist = updatePlaylistItemDetails(playlist, body.assetId as string, {
        altText: body.altText,
        durationSeconds: body.durationSeconds
      });
    } else {
      nextPlaylist = updatePlaylistOrder(playlist, body.action, body.assetId as string);
    }

    await writePlaylist(playlistPath, nextPlaylist);
    const piPublish = await publishPlaylistToPi(playlistPath, nextPlaylist, {
      notConfigured: "Pi publish is not configured; playlist was updated locally only.",
      failure: "Playlist was updated locally, but Pi publish needs attention."
    });
    await writePublishStatus(body.action, nextPlaylist, piPublish);
    await appendActivityRecord({
      id: randomUUID(),
      action: `playlist-${body.action}`,
      actor: "local-operator",
      entityId: body.assetId ?? body.mediaId ?? nextPlaylist.playlistId,
      entityType: "playlist",
      message: `Playlist action ${body.action} applied to ${body.assetId ?? body.mediaId ?? nextPlaylist.playlistId}.`,
      result: "success",
      timestamp: new Date().toISOString()
    });

    return NextResponse.json({
      playlistVersion: nextPlaylist.version,
      assetCount: nextPlaylist.assets.length,
      piPublish
    });
  } catch (error) {
    console.error("local playlist edit failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Playlist edit failed." },
      { status: 500 }
    );
  }
}
