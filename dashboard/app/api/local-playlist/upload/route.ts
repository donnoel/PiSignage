import { promises as fs } from "node:fs";
import os from "node:os";
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
  describePiPublishFailure,
  publishPlaylistToPi,
  quoteRemoteShell,
  readPiConfig,
  requiredRemoteAssetPaths,
  runScp,
  runSsh
} from "../../../lib/pi-local";
import type { PiPublishResult } from "../../../lib/local-playlist";
import {
  createStillVideoClip,
  defaultDurationSeconds,
  formatUploadLimit,
  imageDurationFromForm,
  maxUploadBytes,
  MediaUploadError,
  mediaSourceTypeFromFileName,
  sanitizeMediaFileName,
  slugify,
  stillClipFileName,
  uniqueFileName
} from "../../../lib/media-processing";

export const runtime = "nodejs";

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
      failure: "Upload was saved locally, but Pi publish needs attention.",
      success: `Published to Pi at ${config.host}.`
    });
  } catch (error) {
    console.error("local Pi publish failed", error);
    return {
      enabled: true,
      ok: false,
      message: `Upload was saved locally, but Pi publish needs attention. ${describePiPublishFailure(error)}`
    };
  }
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
        { error: `Media uploads are limited to ${formatUploadLimit(maxUploadBytes)}.` },
        { status: 413 }
      );
    }

    const safeFileName = sanitizeMediaFileName(file.name);
    const mediaType = mediaSourceTypeFromFileName(safeFileName);
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
    const message = error instanceof Error ? error.message : "Upload failed.";
    const status = error instanceof MediaUploadError ? error.status : 500;

    if (error instanceof MediaUploadError) {
      console.warn("local playlist upload rejected", message);
    } else {
      console.error("local playlist upload failed", error);
    }

    return NextResponse.json(
      { error: message },
      { status }
    );
  }
}
