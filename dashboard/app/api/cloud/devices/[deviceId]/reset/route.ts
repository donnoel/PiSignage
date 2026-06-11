import { NextResponse } from "next/server";
import { requestDeviceReset, resetCommandForDevice } from "../../../../../lib/inventory-store";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext) {
  const { deviceId } = await context.params;

  try {
    const device = await requestDeviceReset(deviceId);
    const statusUrl = new URL(`/api/cloud/devices/${encodeURIComponent(deviceId)}/reset-result`, request.url).toString();
    const command = resetCommandForDevice(device, statusUrl);

    return NextResponse.json({
      command,
      message: "Reset queued. The Pi will run it on its next cloud check-in."
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not queue reset." },
      { status: 400 }
    );
  }
}
