import { NextResponse } from "next/server";
import { apiErrorResponse } from "../../../../../lib/api-error-response";
import type { DeviceDiagnosticsStatus } from "../../../../../lib/local-data-store";
import { updateDeviceDiagnosticsStatus } from "../../../../../lib/inventory-store";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

type DiagnosticsResultRequest = {
  commandId?: unknown;
  finishedAt?: unknown;
  message?: unknown;
  result?: unknown;
  startedAt?: unknown;
  status?: unknown;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function diagnosticsStatus(value: unknown): DeviceDiagnosticsStatus | null {
  return value === "failed" || value === "pending" || value === "running" || value === "succeeded"
    ? value
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resultString(value: unknown): string | null {
  if (typeof value === "string") {
    return optionalString(value);
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }

  return null;
}

export async function POST(request: Request, context: RouteContext) {
  const { deviceId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as DiagnosticsResultRequest;
  const commandId = optionalString(body.commandId);
  const status = diagnosticsStatus(body.status);

  if (!commandId || !status) {
    return NextResponse.json({ error: "commandId and status are required." }, { status: 400 });
  }

  try {
    const device = await updateDeviceDiagnosticsStatus({
      commandId,
      deviceId,
      finishedAt: optionalString(body.finishedAt),
      message: optionalString(body.message),
      result: resultString(body.result),
      startedAt: optionalString(body.startedAt),
      status
    });

    return NextResponse.json({
      deviceId: device.id,
      diagnosticsFinishedAt: device.diagnosticsFinishedAt,
      diagnosticsStatus: device.diagnosticsStatus,
      diagnosticsStatusMessage: device.diagnosticsStatusMessage,
      diagnosticsUpdatedAt: device.diagnosticsUpdatedAt,
      message: device.diagnosticsStatusMessage
    });
  } catch (error) {
    return apiErrorResponse(error, "Could not update diagnostics status.", 400);
  }
}
