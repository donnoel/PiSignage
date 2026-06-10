import { spawn } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  cloudMediaConfig,
  readCloudMediaStore,
  updateCloudMediaPreparationStatus
} from "../../../../lib/cloud-media-store";
import { MediaUploadError, playbackPrepProfile } from "../../../../lib/media-processing";

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
    const mediaStore = await readCloudMediaStore(cloudConfig);
    const current = mediaStore.items.find((item) => item.id === mediaId);
    if (!current) {
      return NextResponse.json({ error: "Media item not found." }, { status: 404 });
    }
    if (current.playbackObjectKey && current.preparedAt) {
      const readyItem = await updateCloudMediaPreparationStatus(cloudConfig, mediaId, {
        cloudStatusDetail: "Prepared playback copy is ready for Pi/VLC.",
        playbackProfile: playbackPrepProfile.id,
        status: "ready"
      });
      return NextResponse.json({ item: readyItem, preparing: false });
    }

    const startedItem = await updateCloudMediaPreparationStatus(cloudConfig, mediaId, {
      cloudStatusDetail: "Preparing Pi-safe playback copy in AWS.",
      playbackProfile: "preparing-playback-mp4-v1",
      status: "processing"
    });
    const workerPath = path.join(process.cwd(), "dashboard", "scripts", "prepare-cloud-media-worker.mjs");
    const child = spawn(process.execPath, [workerPath, mediaId], {
      detached: true,
      env: process.env,
      stdio: "ignore"
    });
    child.unref();

    return NextResponse.json({ item: startedItem, preparing: true }, { status: 202 });
  } catch (error) {
    const status = error instanceof MediaUploadError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Could not prepare media for playback.";
    if (status >= 500) {
      console.error("cloud media prepare failed", error);
    }

    return NextResponse.json({ error: message }, { status });
  }
}
