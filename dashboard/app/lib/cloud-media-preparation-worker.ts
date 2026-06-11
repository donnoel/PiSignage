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

const queuedMediaIds = new Set<string>();
const activeMediaIds = new Set<string>();
let queueRunning = false;

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

async function markWorkerExitFailureIfStillProcessing(
  config: CloudMediaConfig,
  mediaId: string,
  message: string
): Promise<void> {
  try {
    const mediaStore = await readCloudMediaStore(config);
    const current = mediaStore.items.find((item) => item.id === mediaId);
    if (current?.status === "processing") {
      await updateCloudMediaPreparationStatus(config, mediaId, {
        cloudStatusDetail: message,
        playbackProfile: current.playbackProfile,
        status: "failed"
      });
    }
  } catch (error) {
    console.error("could not mark cloud media worker failure", { error, mediaId });
  }
}

function runCloudMediaWorker(config: CloudMediaConfig, mediaId: string): Promise<void> {
  return new Promise((resolve) => {
    let workerPath: string;
    try {
      workerPath = mediaWorkerPath();
    } catch (error) {
      void markWorkerExitFailureIfStillProcessing(
        config,
        mediaId,
        error instanceof Error ? error.message : "Playback preparation worker was not available."
      ).finally(resolve);
      return;
    }

    console.log("starting cloud media prepare worker", { mediaId, workerPath });
    const child = spawn(process.execPath, [workerPath, mediaId], {
      env: process.env,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      void markWorkerExitFailureIfStillProcessing(
        config,
        mediaId,
        error instanceof Error ? error.message : "Playback preparation worker could not start."
      ).finally(resolve);
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const exitDetail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      void markWorkerExitFailureIfStillProcessing(
        config,
        mediaId,
        `Playback preparation worker stopped before completion (${exitDetail}).`
      ).finally(resolve);
    });
  });
}

async function drainCloudMediaPreparationQueue(config: CloudMediaConfig): Promise<void> {
  queueRunning = true;
  try {
    while (queuedMediaIds.size > 0) {
      const mediaId = queuedMediaIds.values().next().value;
      if (!mediaId) {
        break;
      }
      queuedMediaIds.delete(mediaId);
      activeMediaIds.add(mediaId);
      try {
        await runCloudMediaWorker(config, mediaId);
      } finally {
        activeMediaIds.delete(mediaId);
      }
    }
  } finally {
    queueRunning = false;
  }
}

function enqueueCloudMediaPreparation(config: CloudMediaConfig, mediaId: string): void {
  if (activeMediaIds.has(mediaId)) {
    return;
  }

  queuedMediaIds.add(mediaId);
  if (queueRunning) {
    return;
  }

  void drainCloudMediaPreparationQueue(config).catch((error) => {
    queueRunning = false;
    console.error("cloud media preparation queue stopped", error);
  });
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
    cloudStatusDetail: "Pending Pi-safe playback preparation in AWS.",
    playbackProfile: "pending-playback-mp4-v1",
    status: "processing"
  });
  enqueueCloudMediaPreparation(config, mediaId);

  return { item: startedItem, preparing: true };
}
