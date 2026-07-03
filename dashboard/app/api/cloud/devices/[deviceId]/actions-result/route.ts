import { NextResponse } from "next/server";
import { apiErrorResponse } from "../../../../../lib/api-error-response";
import type { DeviceActionStatus } from "../../../../../lib/local-data-store";
import { updateDeviceActionStatus } from "../../../../../lib/inventory-store";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

type ActionResultRequest = {
  commandId?: unknown;
  finishedAt?: unknown;
  message?: unknown;
  startedAt?: unknown;
  status?: unknown;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actionStatus(value: unknown): DeviceActionStatus | null {
  return value === "failed" || value === "pending" || value === "running" || value === "succeeded"
    ? value
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(request: Request, context: RouteContext) {
  const { deviceId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as ActionResultRequest;
  const commandId = optionalString(body.commandId);
  const status = actionStatus(body.status);

  if (!commandId || !status) {
    return NextResponse.json({ error: "commandId and status are required." }, { status: 400 });
  }

  try {
    const device = await updateDeviceActionStatus({
      commandId,
      deviceId,
      finishedAt: optionalString(body.finishedAt),
      message: optionalString(body.message),
      startedAt: optionalString(body.startedAt),
      status
    });

    return NextResponse.json({
      actionStatus: device.actionStatus,
      actionStatusMessage: device.actionStatusMessage,
      actionUpdatedAt: device.actionUpdatedAt,
      deviceId: device.id,
      message: device.actionStatusMessage
    });
  } catch (error) {
    return apiErrorResponse(error, "Could not update remote action status.", 400);
  }
}
