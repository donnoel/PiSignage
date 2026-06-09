import { NextResponse } from "next/server";
import {
  createInventoryDevice,
  createInventoryScreen,
  readInventory,
  removeInventoryDevice,
  removeInventoryScreen,
  updateInventory
} from "../../lib/inventory-store";
import { readLivePlaylist } from "../../lib/local-playlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getInventoryResponse() {
  const playlist = await readLivePlaylist();
  const inventory = await readInventory(playlist.playlistId);

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
      await createInventoryScreen({
        deviceId: body.deviceId ?? null,
        group: body.group,
        host: body.host,
        location: body.location,
        name: body.name,
        playlistId: body.playlistId ?? null,
        sshUser: body.sshUser
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
      await createInventoryDevice({
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
      await removeInventoryScreen(body.id);
      return getInventoryResponse();
    }

    if (body.targetType === "device") {
      await removeInventoryDevice(body.id);
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

    await updateInventory({
      id: body.id,
      name: body.name,
      playlistId: body.playlistId,
      targetType: body.targetType
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
