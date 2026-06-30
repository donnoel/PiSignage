import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import type { PlaylistAsset } from "../../../../lib/local-playlist";
import { localStateDirectory, sampleAssetsDirectory } from "../../../../lib/local-playlist";
import { slugify } from "../../../../lib/media-processing";
import { readStoredPlaylist } from "../../../../lib/playlist-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const s3 = new S3Client({});

type RouteContext = {
  params: Promise<{
    assetId: string;
  }>;
};

class ThumbnailUnavailableError extends Error {
  status: number;

  constructor(message: string, status = 404) {
    super(message);
    this.status = status;
  }
}

function playlistAssetPath(uri: string): string | null {
  if (uri.startsWith("s3://")) {
    return null;
  }

  const normalizedPath = path.posix.normalize(`/${uri}`).replace(/^\/+/, "");
  const resolvedPath = path.resolve(sampleAssetsDirectory(), normalizedPath.replace(/^assets\//, ""));
  const assetsDirectory = sampleAssetsDirectory();

  if (resolvedPath !== assetsDirectory && !resolvedPath.startsWith(`${assetsDirectory}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function s3LocationFromAsset(asset: PlaylistAsset): { bucket: string; key: string } | null {
  const objectKey = asset.playbackObjectKey ?? asset.sourceObjectKey;
  const bucket = asset.playbackStorageBucket ?? asset.storageBucket ?? asset.sourceStorageBucket;
  if (bucket && objectKey) {
    return { bucket, key: objectKey };
  }

  if (!asset.uri.startsWith("s3://")) {
    return null;
  }

  const withoutScheme = asset.uri.slice("s3://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex <= 0 || slashIndex === withoutScheme.length - 1) {
    return null;
  }

  return {
    bucket: withoutScheme.slice(0, slashIndex),
    key: withoutScheme.slice(slashIndex + 1)
  };
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body || typeof body !== "object" || !("transformToByteArray" in body)) {
    throw new ThumbnailUnavailableError("Thumbnail source media was unreadable.", 502);
  }

  const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes);
}

async function createThumbnail(sourcePath: string, thumbnailPath: string): Promise<void> {
  await mkdir(path.dirname(thumbnailPath), { recursive: true });
  const temporaryPath = `${thumbnailPath}.${process.pid}.${Date.now()}.tmp.jpg`;

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        "0",
        "-i",
        sourcePath,
        "-frames:v",
        "1",
        "-vf",
        "scale=360:-1",
        "-q:v",
        "3",
        temporaryPath
      ],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      }
    );
    await rename(temporaryPath, thumbnailPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function ensureLocalThumbnail(sourcePath: string, thumbnailPath: string): Promise<void> {
  const [sourceStats, thumbnailExists] = await Promise.all([
    stat(sourcePath),
    fileExists(thumbnailPath)
  ]);

  if (thumbnailExists) {
    const thumbnailStats = await stat(thumbnailPath);
    if (thumbnailStats.mtimeMs >= sourceStats.mtimeMs) {
      return;
    }
  }

  await createThumbnail(sourcePath, thumbnailPath);
}

async function ensureCloudThumbnail(asset: PlaylistAsset, thumbnailPath: string): Promise<void> {
  if (await fileExists(thumbnailPath)) {
    return;
  }

  const location = s3LocationFromAsset(asset);
  if (!location) {
    throw new ThumbnailUnavailableError("Cloud playlist media is not available for thumbnail preview.");
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beam-thumbnail-"));
  const extension = path.extname(location.key) || ".mp4";
  const sourcePath = path.join(temporaryDirectory, `source${extension}`);

  try {
    const object = await s3.send(new GetObjectCommand({
      Bucket: location.bucket,
      Key: location.key
    }));
    await writeFile(sourcePath, await bodyToBuffer(object.Body));
    await createThumbnail(sourcePath, thumbnailPath);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function thumbnailResponse(image: Buffer): NextResponse {
  return new NextResponse(new Blob([new Uint8Array(image)]), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "image/jpeg"
    }
  });
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { assetId } = await context.params;
    const url = new URL(request.url);
    const { playlist } = await readStoredPlaylist(url.searchParams.get("playlistId"));
    const asset = playlist.assets.find((candidate) => candidate.assetId === assetId);

    if (!asset) {
      return NextResponse.json({ error: "Playlist item was not found." }, { status: 404 });
    }

    const thumbnailName = [
      slugify(playlist.playlistId) || "playlist",
      slugify(asset.assetId) || "playlist-item",
      asset.checksumSha256?.slice(0, 12) ?? String(asset.sizeBytes ?? "unknown")
    ].join("-");
    const thumbnailPath = path.join(localStateDirectory(), "thumbnails", thumbnailName);
    const sourcePath = playlistAssetPath(asset.uri);
    if (sourcePath) {
      await access(sourcePath, fsConstants.R_OK);
      await ensureLocalThumbnail(sourcePath, thumbnailPath);
    } else {
      await ensureCloudThumbnail(asset, thumbnailPath);
    }

    const image = await readFile(thumbnailPath);
    return thumbnailResponse(image);
  } catch (error) {
    if (error instanceof ThumbnailUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("playlist thumbnail failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create playlist thumbnail." },
      { status: 500 }
    );
  }
}
