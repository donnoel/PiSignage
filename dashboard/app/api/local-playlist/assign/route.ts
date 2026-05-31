import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  readDeviceStore,
  readScreenStore,
  writeDeviceStore,
  writeScreenStore
} from "../../../lib/local-data-store";
import { readLivePlaylist } from "../../../lib/local-playlist";
import { readPiConfig } from "../../../lib/pi-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AssignmentTarget = "screen" | "device";

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureDefaultInventory() {
  const [screenStore, deviceStore, playlist, piConfig] = await Promise.all([
    readScreenStore(),
    readDeviceStore(),
    readLivePlaylist(),
    Promise.resolve(readPiConfig())
  ]);

  let nextScreenStore = screenStore;
  let nextDeviceStore = deviceStore;
  let wroteScreens = false;
  let wroteDevices = false;
  const timestamp = nowIso();

  if (screenStore.items.length === 0) {
    nextScreenStore = {
      ...screenStore,
      items: [
        {
          deviceId: "device-primary",
          id: "screen-primary",
          location: "Primary location",
          name: "Primary Screen",
          notes: "",
          playlistId: playlist.playlistId,
          updatedAt: timestamp
        }
      ],
      updatedAt: timestamp,
      version: screenStore.version + 1
    };
    wroteScreens = true;
  }

  if (deviceStore.items.length === 0) {
    nextDeviceStore = {
      ...deviceStore,
      items: [
        {
          host: piConfig?.host ?? "Not configured",
          id: "device-primary",
          name: "Primary Device",
          notes: "",
          playlistId: playlist.playlistId,
          playerType: "vlc",
          rootPath: piConfig?.root ?? "~",
          screenId: nextScreenStore.items[0]?.id ?? null,
          sshUser: piConfig?.user ?? "pi",
          updatedAt: timestamp
        }
      ],
      updatedAt: timestamp,
      version: deviceStore.version + 1
    };
    wroteDevices = true;
  }

  if (wroteScreens) {
    await writeScreenStore(nextScreenStore);
  }

  if (wroteDevices) {
    await writeDeviceStore(nextDeviceStore);
  }

  return {
    deviceStore: nextDeviceStore,
    screenStore: nextScreenStore
  };
}

export async function GET() {
  const [playlist, inventory] = await Promise.all([readLivePlaylist(), ensureDefaultInventory()]);

  return NextResponse.json({
    devices: inventory.deviceStore.items,
    playlistId: playlist.playlistId,
    screens: inventory.screenStore.items
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
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

    const playlist = await readLivePlaylist();
    const playlistId = body.playlistId === null ? null : body.playlistId;
    if (playlistId !== null && playlistId !== playlist.playlistId) {
      return NextResponse.json({ error: "Only the local playlist can be assigned right now." }, { status: 400 });
    }

    const timestamp = nowIso();
    if (body.targetType === "screen") {
      const screenStore = await readScreenStore();
      const index = screenStore.items.findIndex((item) => item.id === body.targetId);
      if (index === -1) {
        return NextResponse.json({ error: "Screen was not found." }, { status: 404 });
      }

      const nextItems = [...screenStore.items];
      nextItems[index] = {
        ...nextItems[index],
        playlistId,
        updatedAt: timestamp
      };

      await writeScreenStore({
        ...screenStore,
        items: nextItems,
        updatedAt: timestamp,
        version: screenStore.version + 1
      });
    } else {
      const deviceStore = await readDeviceStore();
      const index = deviceStore.items.findIndex((item) => item.id === body.targetId);
      if (index === -1) {
        return NextResponse.json({ error: "Device was not found." }, { status: 404 });
      }

      const nextItems = [...deviceStore.items];
      nextItems[index] = {
        ...nextItems[index],
        playlistId,
        updatedAt: timestamp
      };

      await writeDeviceStore({
        ...deviceStore,
        items: nextItems,
        updatedAt: timestamp,
        version: deviceStore.version + 1
      });
    }

    await appendActivityRecord({
      id: randomUUID(),
      action: "playlist-assign",
      actor: "local-operator",
      entityId: body.targetId,
      entityType: body.targetType,
      message:
        playlistId === null
          ? `Unassigned playlist from ${body.targetType} ${body.targetId}.`
          : `Assigned playlist ${playlist.playlistId} to ${body.targetType} ${body.targetId}.`,
      result: "success",
      timestamp
    });

    return GET();
  } catch (error) {
    console.error("playlist assignment failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Playlist assignment failed." },
      { status: 500 }
    );
  }
}

