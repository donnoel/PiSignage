import { NextResponse } from "next/server";
import { apiErrorResponse } from "../../../../../lib/api-error-response";
import type { DeviceActionType } from "../../../../../lib/local-data-store";
import { actionCommandForDevice, requestDeviceAction } from "../../../../../lib/inventory-store";
import { publicUrlForRequest } from "../../../../../lib/public-origin";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

type ActionRequest = {
  action?: unknown;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actionType(value: unknown): DeviceActionType | null {
  return value === "mute-audio" ||
    value === "reboot-device" ||
    value === "restart-playback" ||
    value === "run-recovery" ||
    value === "unmute-audio"
    ? value
    : null;
}

export async function POST(request: Request, context: RouteContext) {
  const { deviceId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as ActionRequest;
  const action = actionType(body.action);

  if (!action) {
    return NextResponse.json({ error: "Supported action is required." }, { status: 400 });
  }

  try {
    const device = await requestDeviceAction(deviceId, action);
    const statusUrl = publicUrlForRequest(
      request,
      `/api/cloud/devices/${encodeURIComponent(deviceId)}/actions-result`
    );
    const command = actionCommandForDevice(device, statusUrl);

    return NextResponse.json({
      actionStatus: device.actionStatus,
      actionUpdatedAt: device.actionUpdatedAt,
      command,
      message: device.actionStatusMessage
    });
  } catch (error) {
    return apiErrorResponse(error, "Could not queue remote action.", 400);
  }
}
