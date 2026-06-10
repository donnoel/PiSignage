import { NextResponse } from "next/server";
import { cloudMediaConfig } from "../../../../lib/cloud-media-store";
import { startCloudMediaPreparationWorker } from "../../../../lib/cloud-media-preparation-worker";
import { MediaUploadError } from "../../../../lib/media-processing";

type RouteContext = {
  params: Promise<{
    mediaId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: RouteContext) {
  const cloudConfig = cloudMediaConfig();
  if (!cloudConfig) {
    return NextResponse.json(
      { error: "Playback preparation is only needed for AWS media uploads." },
      { status: 400 }
    );
  }

  const { mediaId } = await context.params;

  try {
    const result = await startCloudMediaPreparationWorker(cloudConfig, mediaId);
    if (!result.item) {
      return NextResponse.json({ error: "Media item not found." }, { status: 404 });
    }

    return NextResponse.json({ item: result.item, preparing: result.preparing }, { status: result.preparing ? 202 : 200 });
  } catch (error) {
    const status = error instanceof MediaUploadError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Could not prepare media for playback.";
    if (status >= 500) {
      console.error("cloud media prepare failed", error);
    }

    return NextResponse.json({ error: message }, { status });
  }
}
