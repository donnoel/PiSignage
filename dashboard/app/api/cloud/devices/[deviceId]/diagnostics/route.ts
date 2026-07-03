import { NextResponse } from "next/server";
import { apiErrorResponse } from "../../../../../lib/api-error-response";
import { diagnosticsCommandForDevice, requestDeviceDiagnostics } from "../../../../../lib/inventory-store";
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
    const device = await requestDeviceDiagnostics(deviceId);
    const statusUrl = publicUrlForRequest(
      request,
      `/api/cloud/devices/${encodeURIComponent(deviceId)}/diagnostics-result`
    );
    const command = diagnosticsCommandForDevice(device, statusUrl);

    return NextResponse.json({
      command,
      diagnosticsStatus: device.diagnosticsStatus,
      diagnosticsUpdatedAt: device.diagnosticsUpdatedAt,
      message: "Remote diagnostics queued. The Pi will collect read-only evidence on its next cloud check-in."
    });
  } catch (error) {
    return apiErrorResponse(error, "Could not queue remote diagnostics.", 400);
  }
}
