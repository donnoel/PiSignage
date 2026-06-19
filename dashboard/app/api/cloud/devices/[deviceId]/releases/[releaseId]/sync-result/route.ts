import { NextResponse } from "next/server";
import {
  readCloudRelease,
  releaseTargetsDevice,
  writeCloudSyncResult
} from "../../../../../../../lib/cloud-release-store";
import { apiErrorResponse } from "../../../../../../../lib/api-error-response";

type RouteContext = {
  params: Promise<{
    deviceId: string;
    releaseId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function numberFromBody(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function resultFromBody(value: unknown): "error" | "success" | "warning" {
  return value === "error" || value === "warning" || value === "success" ? value : "warning";
}

function failedAssetIdsFromBody(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.filter((entry): entry is string => typeof entry === "string").slice(0, 200)));
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { deviceId, releaseId } = await context.params;
    const release = await readCloudRelease(releaseId);
    if (!release || !releaseTargetsDevice(release, deviceId)) {
      return NextResponse.json(
        {
          error: "Release is unavailable for this device.",
          localFirst: true
        },
        { status: 404 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      assetCount?: unknown;
      downloadedBytes?: unknown;
      failedAssetIds?: unknown;
      message?: unknown;
      result?: unknown;
      skippedBytes?: unknown;
    };
    const sync = await writeCloudSyncResult({
      assetCount: numberFromBody(body.assetCount),
      deviceId,
      downloadedBytes: numberFromBody(body.downloadedBytes),
      failedAssetIds: failedAssetIdsFromBody(body.failedAssetIds),
      message: typeof body.message === "string" ? body.message : "Release sync result reported.",
      releaseId,
      result: resultFromBody(body.result),
      skippedBytes: numberFromBody(body.skippedBytes)
    });

    return NextResponse.json({ accepted: true, sync });
  } catch (error) {
    console.error("cloud release sync-result failed", error);
    return apiErrorResponse(error, "Could not record release sync result.");
  }
}
