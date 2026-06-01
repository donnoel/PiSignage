import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  readDeviceStore,
  readScreenStore,
  writeDeviceStore,
  writeScreenStore
} from "../../lib/local-data-store";
import {
  createDevice,
  createScreen,
  createScreenWithDevice,
  ensureInventorySeed,
  removeDevice,
  removeScreen
} from "../../lib/local-inventory";
import { readLivePlaylist } from "../../lib/local-playlist";
import { readPiConfig } from "../../lib/pi-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getInventoryResponse() {
  const [playlist, piConfig] = await Promise.all([readLivePlaylist(), Promise.resolve(readPiConfig())]);
  const inventory = await ensureInventorySeed({
    host: piConfig?.host ?? null,
    location: process.env.PISIGNAGE_LOCATION_NAME?.trim() || "Primary location",
    playlistId: playlist.playlistId,
    rootPath: piConfig?.root ?? null,
    screenName: process.env.PISIGNAGE_SCREEN_NAME?.trim() || "Primary Screen",
    sshUser: piConfig?.user ?? null
  });

  return NextResponse.json({
    devices: inventory.devices.items,
    playlistId: playlist.playlistId,
    playlistName: playlist.name,
    screens: inventory.screens.items
  });
}

export async function GET() {
  return getInventoryResponse();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as
      | {
          targetType: "screen";
          deviceId?: string | null;
          group?: string;
          host?: string;
          location?: string;
          name?: string;
          playlistId?: string | null;
          sshUser?: string;
        }
      | {
          targetType: "device";
          group?: string;
          host?: string;
          location?: string;
          name?: string;
          playlistId?: string | null;
          screenId?: string | null;
          sshUser?: string;
        };

    if (body.targetType === "screen") {
      if (!body.name || !body.name.trim()) {
        return NextResponse.json({ error: "Screen name is required." }, { status: 400 });
      }
      if (body.host?.trim()) {
        await createScreenWithDevice({
          group: body.group,
          host: body.host,
          location: body.location,
          name: body.name,
          playlistId: body.playlistId ?? null,
          sshUser: body.sshUser
        });
        return getInventoryResponse();
      }
      await createScreen({
        deviceId: body.deviceId ?? null,
        group: body.group,
        location: body.location,
        name: body.name,
        playlistId: body.playlistId ?? null
      });
      return getInventoryResponse();
    }

    if (body.targetType === "device") {
      if (!body.name || !body.name.trim()) {
        return NextResponse.json({ error: "Device name is required." }, { status: 400 });
      }
      if (!body.host || !body.host.trim()) {
        return NextResponse.json({ error: "Device host is required." }, { status: 400 });
      }
      await createDevice({
        group: body.group,
        host: body.host,
        location: body.location,
        name: body.name,
        playlistId: body.playlistId ?? null,
        screenId: body.screenId ?? null,
        sshUser: body.sshUser
      });
      return getInventoryResponse();
    }

    return NextResponse.json({ error: "Unsupported inventory target." }, { status: 400 });
  } catch (error) {
    console.error("inventory create failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Inventory create failed." },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as {
      id?: string;
      targetType?: "screen" | "device";
    };
    if (!body.id || !body.targetType) {
      return NextResponse.json({ error: "Missing remove target." }, { status: 400 });
    }

    if (body.targetType === "screen") {
      await removeScreen(body.id);
      return getInventoryResponse();
    }

    if (body.targetType === "device") {
      await removeDevice(body.id);
      return getInventoryResponse();
    }

    return NextResponse.json({ error: "Unsupported inventory target." }, { status: 400 });
  } catch (error) {
    console.error("inventory remove failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Inventory remove failed." },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as {
      id?: string;
      name?: string;
      playlistId?: string | null;
      targetType?: "screen" | "device";
    };

    if (!body.id || !body.targetType) {
      return NextResponse.json({ error: "Missing update target." }, { status: 400 });
    }

    const timestamp = new Date().toISOString();
    if (body.targetType === "screen") {
      const store = await readScreenStore();
      const index = store.items.findIndex((item) => item.id === body.id);
      if (index === -1) {
        return NextResponse.json({ error: "Screen was not found." }, { status: 404 });
      }
      const nextName = typeof body.name === "string" ? body.name.trim() : undefined;
      if (body.name !== undefined && !nextName) {
        return NextResponse.json({ error: "Screen name is required." }, { status: 400 });
      }
      const nextItems = [...store.items];
      const previous = nextItems[index];
      nextItems[index] = {
        ...previous,
        name: nextName ?? previous.name,
        playlistId: body.playlistId === undefined ? previous.playlistId : body.playlistId,
        updatedAt: timestamp
      };
      await writeScreenStore({
        ...store,
        items: nextItems,
        updatedAt: timestamp,
        version: store.version + 1
      });
      if (nextName && nextName !== previous.name) {
        await appendActivityRecord({
          id: randomUUID(),
          action: "screen-rename",
          actor: "local-operator",
          entityId: previous.id,
          entityType: "screen",
          message: `Renamed screen ${previous.name} to ${nextName}.`,
          result: "success",
          timestamp
        });
      }
      return getInventoryResponse();
    }

    const store = await readDeviceStore();
    const index = store.items.findIndex((item) => item.id === body.id);
    if (index === -1) {
      return NextResponse.json({ error: "Device was not found." }, { status: 404 });
    }
    const nextItems = [...store.items];
    nextItems[index] = {
      ...nextItems[index],
      playlistId: body.playlistId === undefined ? nextItems[index].playlistId : body.playlistId,
      updatedAt: timestamp
    };
    await writeDeviceStore({
      ...store,
      items: nextItems,
      updatedAt: timestamp,
      version: store.version + 1
    });
    return getInventoryResponse();
  } catch (error) {
    console.error("inventory update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Inventory update failed." },
      { status: 500 }
    );
  }
}
