import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  readDeviceStore,
  readScreenStore,
  writeDeviceStore,
  writeScreenStore
} from "../../lib/local-data-store";
import {
  localStateDirectory,
  livePlaylistPath,
  publishStatusPath,
  readLivePlaylist,
  writePlaylist,
} from "../../lib/local-playlist";
import type { Playlist } from "../../lib/local-playlist";
import { isCloudInventoryConfigured, readInventory, updateInventory } from "../../lib/inventory-store";
import { apiErrorResponse } from "../../lib/api-error-response";
import { readPlaylistStore, writePlaylistStore } from "../../lib/playlist-store";
import { slugify } from "../../lib/media-processing";
import { activeWorkspaceSession, workspaceContextFromSession } from "../../lib/workspace";
import { deleteLocalCloudReleaseRecordsForPlaylists } from "../../lib/cloud-release-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function nowIso(): string {
  return new Date().toISOString();
}

function uniquePlaylistId(name: string, existingIds: Set<string>): string {
  const baseId = `playlist-${slugify(name) || "new-loop"}`;
  let playlistId = baseId;
  let suffix = 1;

  while (existingIds.has(playlistId)) {
    playlistId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return playlistId;
}

async function clearPlaylistAssignments(playlistIds: Set<string>, timestamp: string): Promise<void> {
  if (isCloudInventoryConfigured()) {
    const inventory = await readInventory("");
    await Promise.all([
      ...inventory.screens.items
        .filter((screen) =>
          (screen.playlistId && playlistIds.has(screen.playlistId)) ||
          (screen.publishedPlaylistId && playlistIds.has(screen.publishedPlaylistId))
        )
        .map((screen) => updateInventory({ id: screen.id, playlistId: null, targetType: "screen" })),
      ...inventory.devices.items
        .filter((device) =>
          (device.playlistId && playlistIds.has(device.playlistId)) ||
          (device.publishedPlaylistId && playlistIds.has(device.publishedPlaylistId))
        )
        .map((device) => updateInventory({ id: device.id, playlistId: null, targetType: "device" }))
    ]);
    return;
  }

  const [screenStore, deviceStore] = await Promise.all([readScreenStore(), readDeviceStore()]);
  const nextScreens = screenStore.items.map((screen) => {
    const assignedToDeletedPlaylist = screen.playlistId && playlistIds.has(screen.playlistId);
    const publishedDeletedPlaylist = screen.publishedPlaylistId && playlistIds.has(screen.publishedPlaylistId);

    return assignedToDeletedPlaylist || publishedDeletedPlaylist
      ? {
          ...screen,
          desiredReleaseId: publishedDeletedPlaylist ? null : screen.desiredReleaseId,
          desiredReleaseManifestChecksum: publishedDeletedPlaylist ? null : screen.desiredReleaseManifestChecksum,
          playlistId: assignedToDeletedPlaylist ? null : screen.playlistId,
          publishedAt: publishedDeletedPlaylist ? null : screen.publishedAt,
          publishedPlaylistId: publishedDeletedPlaylist ? null : screen.publishedPlaylistId,
          publishedPlaylistVersion: publishedDeletedPlaylist ? null : screen.publishedPlaylistVersion,
          updatedAt: timestamp
        }
      : screen;
  });
  const nextDevices = deviceStore.items.map((device) => {
    const assignedToDeletedPlaylist = device.playlistId && playlistIds.has(device.playlistId);
    const publishedDeletedPlaylist = device.publishedPlaylistId && playlistIds.has(device.publishedPlaylistId);

    return assignedToDeletedPlaylist || publishedDeletedPlaylist
      ? {
          ...device,
          desiredReleaseId: publishedDeletedPlaylist ? null : device.desiredReleaseId,
          desiredReleaseManifestChecksum: publishedDeletedPlaylist ? null : device.desiredReleaseManifestChecksum,
          playlistId: assignedToDeletedPlaylist ? null : device.playlistId,
          publishedAt: publishedDeletedPlaylist ? null : device.publishedAt,
          publishedPlaylistId: publishedDeletedPlaylist ? null : device.publishedPlaylistId,
          publishedPlaylistVersion: publishedDeletedPlaylist ? null : device.publishedPlaylistVersion,
          updatedAt: timestamp
        }
      : device;
  });

  if (JSON.stringify(nextScreens) !== JSON.stringify(screenStore.items)) {
    await writeScreenStore({
      ...screenStore,
      items: nextScreens,
      updatedAt: timestamp,
      version: screenStore.version + 1
    });
  }

  if (JSON.stringify(nextDevices) !== JSON.stringify(deviceStore.items)) {
    await writeDeviceStore({
      ...deviceStore,
      items: nextDevices,
      updatedAt: timestamp,
      version: deviceStore.version + 1
    });
  }
}

async function clearDeletedPlaylistPublishStatus(playlistIds: Set<string>): Promise<void> {
  try {
    const publishStatus = JSON.parse(await fs.readFile(publishStatusPath(), "utf8")) as { playlistId?: unknown };
    if (typeof publishStatus.playlistId === "string" && playlistIds.has(publishStatus.playlistId)) {
      await fs.rm(publishStatusPath(), { force: true });
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function removeDeletedPlaylistThumbnails(playlists: Playlist[]): Promise<void> {
  const thumbnailDirectory = path.join(localStateDirectory(), "thumbnails");
  const prefixes = playlists
    .map((playlist) => `${slugify(playlist.playlistId)}-`)
    .filter((prefix) => prefix !== "-");

  if (prefixes.length === 0) {
    return;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(thumbnailDirectory);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix)))
      .map((entry) => fs.rm(path.join(thumbnailDirectory, entry), { force: true }))
  );
}

async function clearDeletedPlaylistRuntimeRecords(playlists: Playlist[], timestamp: string): Promise<void> {
  const playlistIds = new Set(playlists.map((playlist) => playlist.playlistId));
  await Promise.all([
    clearPlaylistAssignments(playlistIds, timestamp),
    clearDeletedPlaylistPublishStatus(playlistIds),
    deleteLocalCloudReleaseRecordsForPlaylists(playlistIds),
    removeDeletedPlaylistThumbnails(playlists)
  ]);
}

export async function POST(request: Request) {
  try {
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
    const body = (await request.json()) as {
      name?: string;
    };
    const name = body.name?.trim().slice(0, 80);

    if (!name) {
      return NextResponse.json({ error: "Enter a playlist name." }, { status: 400 });
    }

    const store = await readPlaylistStore();
    const timestamp = nowIso();
    const playlist: Playlist = {
      playlistId: uniquePlaylistId(name, new Set(store.items.map((item) => item.playlistId))),
      name,
      version: 1,
      updatedAt: timestamp,
      assets: []
    };

    await writePlaylistStore({
      ...store,
      items: [...store.items, playlist],
      updatedAt: timestamp,
      version: store.version + 1
    });

    await appendActivityRecord({
      id: randomUUID(),
      action: "playlist-create",
      actor: context.userId,
      entityId: playlist.playlistId,
      entityType: "playlist",
      message: `Created playlist ${playlist.name}.`,
      result: "success",
      timestamp
    });

    return NextResponse.json({ playlist });
  } catch (error) {
    console.error("playlist create failed", error);
    return apiErrorResponse(error, "Playlist create failed.");
  }
}

export async function PATCH(request: Request) {
  try {
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
    const body = (await request.json()) as {
      name?: string;
      playlistId?: string;
    };
    const playlistId = body.playlistId?.trim();
    const name = body.name?.trim().slice(0, 80);

    if (!playlistId) {
      return NextResponse.json({ error: "Choose a playlist." }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: "Enter a playlist name." }, { status: 400 });
    }

    const store = await readPlaylistStore();
    const index = store.items.findIndex((item) => item.playlistId === playlistId);
    if (index === -1) {
      return NextResponse.json({ error: "Playlist was not found." }, { status: 404 });
    }
    const existing = store.items.find(
      (item) => item.playlistId !== playlistId && item.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      return NextResponse.json({ error: "A playlist with that name already exists." }, { status: 409 });
    }

    const timestamp = nowIso();
    const previous = store.items[index];
    const playlist: Playlist = {
      ...previous,
      name,
      updatedAt: timestamp
    };
    const nextItems = [...store.items];
    nextItems[index] = playlist;

    await writePlaylistStore({
      ...store,
      items: nextItems,
      updatedAt: timestamp,
      version: store.version + 1
    });

    if (name !== previous.name) {
      await appendActivityRecord({
        id: randomUUID(),
        action: "playlist-rename",
        actor: context.userId,
        entityId: playlist.playlistId,
        entityType: "playlist",
        message: `Renamed playlist ${previous.name} to ${playlist.name}.`,
        result: "success",
        timestamp
      });
    }

    return NextResponse.json({ playlist });
  } catch (error) {
    console.error("playlist rename failed", error);
    return apiErrorResponse(error, "Playlist rename failed.");
  }
}

export async function DELETE(request: Request) {
  try {
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
    const body = (await request.json()) as {
      resetLibrary?: boolean;
      resetName?: string;
      playlistId?: string;
    };
    const timestamp = nowIso();

    if (body.resetLibrary) {
      const store = await readPlaylistStore();
      const resetName = body.resetName?.trim().slice(0, 80) || "New playlist";
      const resetPlaylist: Playlist = {
        playlistId: uniquePlaylistId(resetName, new Set()),
        name: resetName,
        version: 1,
        updatedAt: timestamp,
        assets: []
      };
      await writePlaylistStore({
        ...store,
        items: [resetPlaylist],
        updatedAt: timestamp,
        version: store.version + 1
      });
      if (!isCloudInventoryConfigured()) {
        await writePlaylist(livePlaylistPath(), resetPlaylist);
      }
      await clearDeletedPlaylistRuntimeRecords(store.items, timestamp);

      await appendActivityRecord({
        id: randomUUID(),
        action: "playlist-library-reset",
        actor: context.userId,
        entityId: resetPlaylist.playlistId,
        entityType: "playlist",
        message: `Reset playlist library and created ${resetPlaylist.name}. Publish manually when the new playlist is ready.`,
        result: "warning",
        timestamp
      });

      return NextResponse.json({
        deleted: store.items.length,
        nextPlaylistId: resetPlaylist.playlistId,
        playlist: resetPlaylist
      });
    }

    const playlistId = body.playlistId?.trim();

    if (!playlistId) {
      return NextResponse.json({ error: "Choose a playlist." }, { status: 400 });
    }

    const store = await readPlaylistStore();
    if (store.items.length <= 1) {
      return NextResponse.json({ error: "Keep at least one playlist." }, { status: 400 });
    }

    const playlist = store.items.find((item) => item.playlistId === playlistId);
    if (!playlist) {
      return NextResponse.json({ error: "Playlist was not found." }, { status: 404 });
    }

    const nextItems = store.items.filter((item) => item.playlistId !== playlistId);
    const fallbackPlaylist = nextItems[0];
    if (!fallbackPlaylist) {
      return NextResponse.json({ error: "Keep at least one playlist." }, { status: 400 });
    }

    await writePlaylistStore({
      ...store,
      items: nextItems,
      updatedAt: timestamp,
      version: store.version + 1
    });

    if (!isCloudInventoryConfigured()) {
      const livePlaylist = await readLivePlaylist();
      if (livePlaylist.playlistId === playlistId) {
        await writePlaylist(livePlaylistPath(), fallbackPlaylist);
      }
    }

    await clearDeletedPlaylistRuntimeRecords([playlist], timestamp);

    await appendActivityRecord({
      id: randomUUID(),
      action: "playlist-delete",
      actor: context.userId,
      entityId: playlist.playlistId,
      entityType: "playlist",
      message: `Deleted playlist ${playlist.name}. Publish the replacement playlist manually if a screen should change.`,
      result: "success",
      timestamp
    });

    return NextResponse.json({
      nextPlaylistId: fallbackPlaylist.playlistId,
      playlistId: playlist.playlistId
    });
  } catch (error) {
    console.error("playlist delete failed", error);
    return apiErrorResponse(error, "Playlist delete failed.");
  }
}
