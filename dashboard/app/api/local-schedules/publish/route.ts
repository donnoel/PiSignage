import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  readScheduleStore,
  scheduleStorePath
} from "../../../lib/local-data-store";
import { apiErrorResponse } from "../../../lib/api-error-response";
import { publishScheduleStoreToPi } from "../../../lib/pi-local";
import { piConfigForDevice, targetDevicesForRequest } from "../../../lib/pi-targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sumOk(results: Array<{ ok: boolean }>): number {
  return results.filter((result) => result.ok).length;
}

export async function POST(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const body = (await request.json().catch(() => ({}))) as {
      deviceId?: string;
      screenId?: string;
    };
    const scheduleStore = await readScheduleStore();

    const targets = await targetDevicesForRequest({
      deviceId: body.deviceId,
      screenId: body.screenId
    });
    if (targets.length === 0) {
      return NextResponse.json(
        { error: "No configured Pi was found for this schedule target." },
        { status: 400 }
      );
    }

    const publishResults = await Promise.all(
      targets.map((device) =>
        publishScheduleStoreToPi(
          scheduleStorePath(),
          {
            failure: `Schedule publish to ${device.name} needs attention.`,
            notConfigured: `Schedule publish is not configured for ${device.name}; schedules stayed local.`,
            success: `Published schedules to ${device.name} at ${device.host}.`
          },
          piConfigForDevice(device)
        )
      )
    );
    const okCount = sumOk(publishResults);
    const publish = {
      enabled: publishResults.some((result) => result.enabled),
      ok: publishResults.length > 0 && publishResults.every((result) => result.ok),
      message:
        publishResults.length === 1
          ? publishResults[0].message
          : `Published schedules to ${okCount}/${publishResults.length} target screen(s). ${publishResults
              .map((result) => result.message)
              .join(" ")}`
    };
    const timestamp = new Date().toISOString();

    await appendActivityRecord({
      id: randomUUID(),
      action: "schedule-publish",
      actor: "local-operator",
      entityId: body.screenId ?? body.deviceId ?? "schedules",
      entityType: "schedule",
      message: publish.message,
      result: publish.ok ? "success" : publish.enabled ? "warning" : "warning",
      timestamp
    });

    return NextResponse.json({
      publish,
      publishResults,
      storeUpdatedAt: scheduleStore.updatedAt,
      storeVersion: scheduleStore.version
    });
  } catch (error) {
    console.error("manual schedule publish failed", error);
    return apiErrorResponse(error, "Schedule publish failed.");
  }
}
