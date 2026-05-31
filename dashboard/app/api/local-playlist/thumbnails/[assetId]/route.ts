import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, stat, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { localStateDirectory, readStoredPlaylist, sampleAssetsDirectory } from "../../../../lib/local-playlist";
import { slugify } from "../../../../lib/media-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type RouteContext = {
  params: Promise<{
    assetId: string;
  }>;
};

function playlistAssetPath(uri: string): string | null {
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

async function ensureThumbnail(sourcePath: string, thumbnailPath: string): Promise<void> {
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

export async function GET(request: Request, context: RouteContext) {
  try {
    const { assetId } = await context.params;
    const url = new URL(request.url);
    const { playlist } = await readStoredPlaylist(url.searchParams.get("playlistId"));
    const asset = playlist.assets.find((candidate) => candidate.assetId === assetId);

    if (!asset) {
      return NextResponse.json({ error: "Playlist item was not found." }, { status: 404 });
    }

    const sourcePath = playlistAssetPath(asset.uri);
    if (!sourcePath) {
      return NextResponse.json({ error: "Playlist media path is not local." }, { status: 400 });
    }

    await access(sourcePath, fsConstants.R_OK);

    const thumbnailName = `${slugify(playlist.playlistId) || "playlist"}-${slugify(asset.assetId) || "playlist-item"}.jpg`;
    const thumbnailPath = path.join(localStateDirectory(), "thumbnails", thumbnailName);
    await ensureThumbnail(sourcePath, thumbnailPath);

    const image = await readFile(thumbnailPath);
    return new NextResponse(image, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "image/jpeg"
      }
    });
  } catch (error) {
    console.error("playlist thumbnail failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create playlist thumbnail." },
      { status: 500 }
    );
  }
}
