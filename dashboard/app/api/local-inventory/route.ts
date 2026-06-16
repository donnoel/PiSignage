import { NextResponse } from "next/server";
import {
  createInventoryDevice,
  createInventoryScreen,
  readInventory,
  removeInventoryDevice,
  removeInventoryScreen,
  updateInventory
} from "../../lib/inventory-store";
import { apiErrorResponse } from "../../lib/api-error-response";
import { readLivePlaylist } from "../../lib/local-playlist";
import { activeWorkspaceSession, workspaceContextFromSession } from "../../lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getInventoryResponse() {
  const session = activeWorkspaceSession();
  const context = workspaceContextFromSession(session);
  const playlist = await readLivePlaylist();
  const inventory = await readInventory(playlist.playlistId);

  return NextResponse.json({
    activeWorkspaceId: context.activeWorkspaceId,
    devices: inventory.devices.items,
    playlistId: playlist.playlistId,
    playlistName: playlist.name,
    screens: inventory.screens.items,
    userId: context.userId
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
    return apiErrorResponse(error, "Inventory create failed.");
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
    return apiErrorResponse(error, "Inventory remove failed.");
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as {
      group?: string;
      id?: string;
      location?: string;
      name?: string;
      playlistId?: string | null;
      targetType?: "screen" | "device";
    };

    if (!body.id || !body.targetType) {
      return NextResponse.json({ error: "Missing update target." }, { status: 400 });
    }

    await updateInventory({
      group: body.group,
      id: body.id,
      location: body.location,
      name: body.name,
      playlistId: body.playlistId,
      targetType: body.targetType
    });
    return getInventoryResponse();
  } catch (error) {
    console.error("inventory update failed", error);
    return apiErrorResponse(error, "Inventory update failed.");
  }
}
