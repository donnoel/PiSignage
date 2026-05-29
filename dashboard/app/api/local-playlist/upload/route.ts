import { promises as fs } from "node:fs";
import path from "node:path";
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
const defaultMaxUploadBytes = 1024 * 1024 * 1024;
const configuredMaxUploadBytes = Number.parseInt(
  process.env.PISIGNAGE_MAX_UPLOAD_BYTES ?? "",
  10
);
const maxUploadBytes = Number.isFinite(configuredMaxUploadBytes)
  ? configuredMaxUploadBytes
  : defaultMaxUploadBytes;

export const runtime = "nodejs";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.mp4$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function sanitizeMp4FileName(fileName: string): string {
  const baseName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "-");

  if (!baseName.toLowerCase().endsWith(".mp4")) {
    throw new Error("Only .mp4 uploads are supported.");
  }

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

function appendAsset(playlist: Playlist, savedFileName: string): Playlist {
  const baseAssetId = `asset-${slugify(savedFileName) || "video"}`;
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
        type: "video",
        uri: `assets/${savedFileName}`,
        durationSeconds: defaultDurationSeconds,
        altText: path.basename(savedFileName, path.extname(savedFileName))
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

    const file = formData.get("video");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing video file." }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "The selected MP4 is empty." }, { status: 400 });
    }

    if (file.size > maxUploadBytes) {
      return NextResponse.json(
        { error: `MP4 uploads are limited to ${formatUploadLimit(maxUploadBytes)} for the local demo.` },
        { status: 413 }
      );
    }

    const safeFileName = sanitizeMp4FileName(file.name);
    const assetsDirectory = sampleAssetsDirectory();
    const playlistPath = await ensureLivePlaylistPath();
    const savedFileName = await uniqueFileName(assetsDirectory, safeFileName);
    const savedFilePath = path.join(assetsDirectory, savedFileName);
    const uploadedBytes = Buffer.from(await file.arrayBuffer());
    const playlist = await readPlaylist(playlistPath);
    const nextPlaylist = appendAsset(playlist, savedFileName);

    await writeFileAtomic(savedFilePath, uploadedBytes);
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 }
    );
  }
}
