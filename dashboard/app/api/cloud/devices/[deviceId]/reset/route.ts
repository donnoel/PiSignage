import { NextResponse } from "next/server";
import { apiErrorResponse } from "../../../../../lib/api-error-response";
import { requestDeviceReset, resetCommandForDevice } from "../../../../../lib/inventory-store";
import { publicUrlForRequest } from "../../../../../lib/public-origin";

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
    const statusUrl = publicUrlForRequest(
      request,
      `/api/cloud/devices/${encodeURIComponent(deviceId)}/reset-result`
    );
    const command = resetCommandForDevice(device, statusUrl);

    return NextResponse.json({
      command,
      message: "Reset queued. The Pi will run it on its next cloud check-in."
    });
  } catch (error) {
    return apiErrorResponse(error, "Could not queue reset.", 400);
  }
}
