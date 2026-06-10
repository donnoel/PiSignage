import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { MediaRecord } from "./local-data-store";
import {
  readCloudMediaStore,
  updateCloudMediaPreparationStatus
} from "./cloud-media-store";
import type { CloudMediaConfig } from "./cloud-media-store";
import { MediaUploadError, playbackPrepProfile } from "./media-processing";

function mediaWorkerPath(): string {
  const candidates = [
    path.join(process.cwd(), "scripts", "prepare-cloud-media-worker.mjs"),
    path.join(process.cwd(), "dashboard", "scripts", "prepare-cloud-media-worker.mjs"),
    "/app/dashboard/scripts/prepare-cloud-media-worker.mjs"
  ];
  const workerPath = candidates.find((candidate) => existsSync(candidate));
  if (!workerPath) {
    throw new MediaUploadError(`Media worker script was not found. Checked: ${candidates.join(", ")}`, 500);
  }

  return workerPath;
}

export async function startCloudMediaPreparationWorker(
  config: CloudMediaConfig,
  mediaId: string
): Promise<{ item: MediaRecord | null; preparing: boolean }> {
  const mediaStore = await readCloudMediaStore(config);
  const current = mediaStore.items.find((item) => item.id === mediaId);
  if (!current) {
    return { item: null, preparing: false };
  }
  if (current.playbackObjectKey && current.preparedAt) {
    const readyItem = await updateCloudMediaPreparationStatus(config, mediaId, {
      cloudStatusDetail: "Prepared playback copy is ready for Pi/VLC.",
      playbackProfile: playbackPrepProfile.id,
      status: "ready"
    });
    return { item: readyItem, preparing: false };
  }

  const startedItem = await updateCloudMediaPreparationStatus(config, mediaId, {
    cloudStatusDetail: "Preparing Pi-safe playback copy in AWS.",
    playbackProfile: "preparing-playback-mp4-v1",
    status: "processing"
  });
  const workerPath = mediaWorkerPath();
  console.log("starting cloud media prepare worker", { mediaId, workerPath });
  const child = spawn(process.execPath, [workerPath, mediaId], {
    detached: true,
    env: process.env,
    stdio: "inherit"
  });
  child.unref();

  return { item: startedItem, preparing: true };
}
