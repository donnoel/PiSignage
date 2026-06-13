import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  readDeviceStore,
  readScreenStore,
  writeDeviceStore,
  writeScreenStore
} from "../../../lib/local-data-store";
import { apiErrorResponse } from "../../../lib/api-error-response";
import { readInventory, updateInventory } from "../../../lib/inventory-store";
import { readPlaylistStore, readStoredPlaylist, selectPlaylist } from "../../../lib/playlist-store";
import { activeWorkspaceSession, workspaceContextFromSession } from "../../../lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AssignmentTarget = "screen" | "device";

function nowIso(): string {
  return new Date().toISOString();
}

function isCloudMode(): boolean {
  return process.env.BEAM_DASHBOARD_MODE === "cloud";
}

async function assignmentResponse(playlistId?: string | null) {
  const session = activeWorkspaceSession();
  const context = workspaceContextFromSession(session);
  const store = await readPlaylistStore();
  const playlist = selectPlaylist(store, playlistId);
  const inventory = await readInventory(playlist.playlistId);

  return NextResponse.json({
    activeWorkspaceId: context.activeWorkspaceId,
    devices: inventory.devices.items,
    playlistId: playlist.playlistId,
    screens: inventory.screens.items,
    userId: context.userId
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return assignmentResponse(url.searchParams.get("playlistId"));
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      assigned?: boolean;
      playlistId?: string | null;
      targetId?: string;
      targetType?: AssignmentTarget;
    };

    if (body.targetType !== "screen" && body.targetType !== "device") {
      return NextResponse.json({ error: "Unsupported assignment target." }, { status: 400 });
    }

    if (!body.targetId) {
      return NextResponse.json({ error: "Missing assignment target." }, { status: 400 });
    }

    const selectedPlaylistId = body.playlistId ?? undefined;
    const { playlist } = await readStoredPlaylist(selectedPlaylistId);
    const shouldAssign = body.assigned ?? body.playlistId !== null;
    const assignmentPlaylistId = shouldAssign ? playlist.playlistId : null;
    if (shouldAssign && !selectedPlaylistId) {
      return NextResponse.json({ error: "Choose a playlist to assign." }, { status: 400 });
    }

    if (assignmentPlaylistId !== null && playlist.assets.length === 0) {
      return NextResponse.json(
        { error: "Add media before assigning this playlist to a screen or device." },
        { status: 400 }
      );
    }

    const timestamp = nowIso();
    if (isCloudMode()) {
      await updateInventory({
        id: body.targetId,
        playlistId: assignmentPlaylistId,
        targetType: body.targetType
      });
    } else if (body.targetType === "screen") {
      const [screenStore, deviceStore] = await Promise.all([readScreenStore(), readDeviceStore()]);
      const index = screenStore.items.findIndex((item) => item.id === body.targetId);
      if (index === -1) {
        return NextResponse.json({ error: "Screen was not found." }, { status: 404 });
      }

      const nextItems = [...screenStore.items];
      nextItems[index] = {
        ...nextItems[index],
        playlistId: assignmentPlaylistId,
        updatedAt: timestamp
      };

      await writeScreenStore({
        ...screenStore,
        items: nextItems,
        updatedAt: timestamp,
        version: screenStore.version + 1
      });

      const linkedDeviceId = nextItems[index].deviceId;
      const nextDeviceItems = deviceStore.items.map((device) =>
        device.id === linkedDeviceId || device.screenId === body.targetId
          ? {
              ...device,
              playlistId: assignmentPlaylistId,
              updatedAt: timestamp
            }
          : device
      );

      if (JSON.stringify(nextDeviceItems) !== JSON.stringify(deviceStore.items)) {
        await writeDeviceStore({
          ...deviceStore,
          items: nextDeviceItems,
          updatedAt: timestamp,
          version: deviceStore.version + 1
        });
      }
    } else {
      const [deviceStore, screenStore] = await Promise.all([readDeviceStore(), readScreenStore()]);
      const index = deviceStore.items.findIndex((item) => item.id === body.targetId);
      if (index === -1) {
        return NextResponse.json({ error: "Device was not found." }, { status: 404 });
      }

      const nextItems = [...deviceStore.items];
      nextItems[index] = {
        ...nextItems[index],
        playlistId: assignmentPlaylistId,
        updatedAt: timestamp
      };

      await writeDeviceStore({
        ...deviceStore,
        items: nextItems,
        updatedAt: timestamp,
        version: deviceStore.version + 1
      });

      const linkedScreenId = nextItems[index].screenId;
      const nextScreenItems = screenStore.items.map((screen) =>
        screen.id === linkedScreenId || screen.deviceId === body.targetId
          ? {
              ...screen,
              playlistId: assignmentPlaylistId,
              updatedAt: timestamp
            }
          : screen
      );

      if (JSON.stringify(nextScreenItems) !== JSON.stringify(screenStore.items)) {
        await writeScreenStore({
          ...screenStore,
          items: nextScreenItems,
          updatedAt: timestamp,
          version: screenStore.version + 1
        });
      }
    }

    await appendActivityRecord({
      id: randomUUID(),
      action: "playlist-assign",
      actor: "local-operator",
      entityId: body.targetId,
      entityType: body.targetType,
      message:
        assignmentPlaylistId === null
          ? `Unassigned playlist from ${body.targetType} ${body.targetId}.`
          : `Assigned playlist ${playlist.name} to ${body.targetType} ${body.targetId}.`,
      result: "success",
      timestamp
    });

    return assignmentResponse(playlist.playlistId);
  } catch (error) {
    console.error("playlist assignment failed", error);
    return apiErrorResponse(error, "Playlist assignment failed.");
  }
}
