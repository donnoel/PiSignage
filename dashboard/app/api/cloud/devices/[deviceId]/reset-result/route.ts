import { NextResponse } from "next/server";
import type { DeviceResetStatus } from "../../../../../lib/local-data-store";
import { updateDeviceResetStatus } from "../../../../../lib/inventory-store";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

type ResetResultRequest = {
  commandId?: unknown;
  finishedAt?: unknown;
  message?: unknown;
  startedAt?: unknown;
  status?: unknown;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resetStatus(value: unknown): DeviceResetStatus | null {
  return value === "failed" || value === "pending" || value === "running" || value === "succeeded"
    ? value
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(request: Request, context: RouteContext) {
  const { deviceId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as ResetResultRequest;
  const commandId = optionalString(body.commandId);
  const status = resetStatus(body.status);

  if (!commandId || !status) {
    return NextResponse.json({ error: "commandId and status are required." }, { status: 400 });
  }

  try {
    const device = await updateDeviceResetStatus({
      commandId,
      deviceId,
      finishedAt: optionalString(body.finishedAt),
      message: optionalString(body.message),
      startedAt: optionalString(body.startedAt),
      status
    });

    return NextResponse.json({
      deviceId: device.id,
      message: device.resetStatusMessage,
      resetStatus: device.resetStatus,
      resetUpdatedAt: device.resetUpdatedAt
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update reset status." },
      { status: 400 }
    );
  }
}
