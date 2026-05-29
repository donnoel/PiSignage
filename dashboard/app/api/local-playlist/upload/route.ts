import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import {
  ensureLivePlaylistPath,
  readPlaylist,
  sampleAssetsDirectory,
  writeFileAtomic,
  writePlaylist,
  writePublishStatus
} from "../../../lib/local-playlist";
import type { Playlist } from "../../../lib/local-playlist";
import {
  publishPlaylistToPi,
  quoteRemoteShell,
  readPiConfig,
  requiredRemoteAssetPaths,
  runScp,
  runSsh
} from "../../../lib/pi-local";
import type { PiPublishResult } from "../../../lib/local-playlist";

const defaultDurationSeconds = 30;
const defaultImageDurationSeconds = 10;
const minimumImageDurationSeconds = 1;
const maximumImageDurationSeconds = 300;
const defaultMaxUploadBytes = 1024 * 1024 * 1024;
const configuredMaxUploadBytes = Number.parseInt(
  process.env.PISIGNAGE_MAX_UPLOAD_BYTES ?? "",
  10
);
const maxUploadBytes = Number.isFinite(configuredMaxUploadBytes)
  ? configuredMaxUploadBytes
  : defaultMaxUploadBytes;
const ffmpegBinary = process.env.PISIGNAGE_FFMPEG_BIN ?? "ffmpeg";
const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function mediaTypeFromFileName(fileName: string): "image" | "video" {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".mp4") {
    return "video";
  }

  if (extension === ".jpg" || extension === ".jpeg" || extension === ".png") {
    return "image";
  }

  throw new Error("Only .mp4, .jpg, .jpeg, and .png uploads are recognized.");
}

function sanitizeMediaFileName(fileName: string): string {
  const baseName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "-");

  mediaTypeFromFileName(baseName);

  return baseName;
}

async function uniqueFileName(assetsDirectory: string, fileName: string): Promise<string> {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  let candidate = fileName;
  let suffix = 1;

  while (true) {
    try {
      await fs.access(path.join(assetsDirectory, candidate));
      candidate = `${baseName}-${suffix}${extension}`;
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

function imageDurationFromForm(value: FormDataEntryValue | null): number {
  if (typeof value !== "string" || value.trim() === "") {
    return defaultImageDurationSeconds;
  }

  const duration = Number.parseInt(value, 10);
  if (!Number.isFinite(duration)) {
    return defaultImageDurationSeconds;
  }

  return Math.min(Math.max(duration, minimumImageDurationSeconds), maximumImageDurationSeconds);
}

function stillClipFileName(fileName: string, durationSeconds: number): string {
  const baseName = path.basename(fileName, path.extname(fileName));
  return `${baseName}.still-${durationSeconds}s.mp4`;
}

async function createStillVideoClip(
  sourceImagePath: string,
  outputVideoPath: string,
  durationSeconds: number
): Promise<void> {
  const temporaryOutputPath = `${outputVideoPath}.${process.pid}.tmp.mp4`;

  try {
    await execFileAsync(
      ffmpegBinary,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-loop",
        "1",
        "-framerate",
        "30",
        "-t",
        String(durationSeconds),
        "-i",
        sourceImagePath,
        "-f",
        "lavfi",
        "-t",
        String(durationSeconds),
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=decrease:in_range=full:out_range=tv,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-profile:v",
        "baseline",
        "-level:v",
        "3.1",
        "-pix_fmt",
        "yuv420p",
        "-x264-params",
        "keyint=30:min-keyint=30:scenecut=0:bframes=0",
        "-color_range",
        "tv",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-shortest",
        "-movflags",
        "+faststart",
        temporaryOutputPath
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 * 4 }
    );
    await fs.rename(temporaryOutputPath, outputVideoPath);
  } catch (error) {
    await fs.rm(temporaryOutputPath, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Image upload could not be converted to the Pi-safe still-video preset. ${detail}`);
  }
}

function appendAsset(
  playlist: Playlist,
  savedFileName: string,
  mediaType: "image" | "video",
  durationSeconds: number,
  altText?: string
): Playlist {
  const baseAssetId = `asset-${slugify(savedFileName) || mediaType}`;
  const existingAssetIds = new Set(playlist.assets.map((asset) => asset.assetId));
  let assetId = baseAssetId;
  let suffix = 1;

  while (existingAssetIds.has(assetId)) {
    assetId = `${baseAssetId}-${suffix}`;
    suffix += 1;
  }

  return {
    ...playlist,
    version: playlist.version + 1,
    updatedAt: new Date().toISOString(),
    assets: [
      ...playlist.assets,
      {
        assetId,
        type: mediaType,
        uri: `assets/${savedFileName}`,
        durationSeconds,
        altText: altText ?? path.basename(savedFileName, path.extname(savedFileName))
      }
    ]
  };
}

async function publishUploadToPi(
  savedFilePath: string,
  savedFileName: string,
  playlistPath: string,
  playlist: Playlist
): Promise<PiPublishResult> {
  const config = readPiConfig();

  if (!config) {
    return {
      enabled: false,
      ok: false,
      message: "Pi publish is not configured; upload was saved locally only."
    };
  }

  const remoteAssetsDirectory = path.posix.join(config.root, "sample-content", "assets");

  try {
    await runSsh(config, `mkdir -p ${quoteRemoteShell(remoteAssetsDirectory)}`);
    await runScp(config, savedFilePath, path.posix.join(remoteAssetsDirectory, savedFileName));
    await runSsh(
      config,
      requiredRemoteAssetPaths(config, playlist)
        .map((assetPath) => `test -f ${quoteRemoteShell(assetPath)}`)
        .join(" && ")
    );
    return publishPlaylistToPi(playlistPath, playlist, {
      notConfigured: "Pi publish is not configured; upload was saved locally only.",
      failure: "Upload was saved locally, but Pi publish failed. Check Pi connectivity and required media files.",
      success: `Published to Pi at ${config.host}.`
    });
  } catch (error) {
    console.error("local Pi publish failed", error);
    return {
      enabled: true,
      ok: false,
      message:
        "Upload was saved locally, but Pi publish failed. Check Pi connectivity and required media files."
    };
  }
}

function formatUploadLimit(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

export async function POST(request: Request) {
  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "Upload must be sent as multipart form data." }, { status: 400 });
    }

    const file = formData.get("media") ?? formData.get("video");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing media file." }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "The selected media file is empty." }, { status: 400 });
    }

    if (file.size > maxUploadBytes) {
      return NextResponse.json(
        { error: `Media uploads are limited to ${formatUploadLimit(maxUploadBytes)} for the local demo.` },
        { status: 413 }
      );
    }

    const safeFileName = sanitizeMediaFileName(file.name);
    const mediaType = mediaTypeFromFileName(safeFileName);
    const imageDurationSeconds = imageDurationFromForm(formData.get("durationSeconds"));

    const assetsDirectory = sampleAssetsDirectory();
    const playlistPath = await ensureLivePlaylistPath();
    const savedFileName = await uniqueFileName(
      assetsDirectory,
      mediaType === "image" ? stillClipFileName(safeFileName, imageDurationSeconds) : safeFileName
    );
    const savedFilePath = path.join(assetsDirectory, savedFileName);
    const uploadedBytes = Buffer.from(await file.arrayBuffer());
    const playlist = await readPlaylist(playlistPath);
    const nextPlaylist = appendAsset(
      playlist,
      savedFileName,
      "video",
      mediaType === "image" ? imageDurationSeconds : defaultDurationSeconds,
      path.basename(safeFileName, path.extname(safeFileName))
    );

    if (mediaType === "image") {
      const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pisignage-image-upload-"));
      const sourceImagePath = path.join(temporaryDirectory, safeFileName);

      try {
        await writeFileAtomic(sourceImagePath, uploadedBytes);
        await createStillVideoClip(sourceImagePath, savedFilePath, imageDurationSeconds);
      } finally {
        await fs.rm(temporaryDirectory, { force: true, recursive: true });
      }
    } else {
      await writeFileAtomic(savedFilePath, uploadedBytes);
    }
    await writePlaylist(playlistPath, nextPlaylist);
    const piPublish = await publishUploadToPi(savedFilePath, savedFileName, playlistPath, nextPlaylist);
    await writePublishStatus("upload", nextPlaylist, piPublish);

    const appendedAsset = nextPlaylist.assets[nextPlaylist.assets.length - 1];
    return NextResponse.json({
      assetId: appendedAsset.assetId,
      uri: appendedAsset.uri,
      playlistVersion: nextPlaylist.version,
      piPublish
    });
  } catch (error) {
    console.error("local playlist upload failed", error);
    const message = error instanceof Error ? error.message : "Upload failed.";
    const status = message.startsWith("Only .mp4") ? 400 : 500;

    return NextResponse.json(
      { error: message },
      { status }
    );
  }
}
