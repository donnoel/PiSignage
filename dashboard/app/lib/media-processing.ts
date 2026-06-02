import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const defaultDurationSeconds = 30;
export const defaultImageDurationSeconds = 10;
export const minimumImageDurationSeconds = 1;
export const maximumImageDurationSeconds = 300;
export const defaultMaxUploadBytes = 1024 * 1024 * 1024;
const configuredMaxUploadBytes = Number.parseInt(
  process.env.PISIGNAGE_MAX_UPLOAD_BYTES ?? "",
  10
);
export const maxUploadBytes = Number.isFinite(configuredMaxUploadBytes)
  ? configuredMaxUploadBytes
  : defaultMaxUploadBytes;

const ffmpegBinary = process.env.PISIGNAGE_FFMPEG_BIN ?? "ffmpeg";
const execFileAsync = promisify(execFile);

export type MediaSourceType = "image" | "video";

export class MediaUploadError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "MediaUploadError";
  }
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function mediaSourceTypeFromFileName(fileName: string): MediaSourceType {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".mp4" || extension === ".mov") {
    return "video";
  }

  if (extension === ".jpg" || extension === ".jpeg" || extension === ".png") {
    return "image";
  }

  if (extension === ".mp3") {
    throw new MediaUploadError(
      "MP3 is not enabled yet. We still need to define what audio-only signage should display.",
      400
    );
  }

  throw new MediaUploadError(
    "Accepted media formats are MP4, MOV, JPEG, and PNG.",
    400
  );
}

export function sanitizeMediaFileName(fileName: string): string {
  const baseName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "-");

  if (!baseName || baseName === "." || baseName === "..") {
    throw new MediaUploadError("Choose a media file with a usable file name.", 400);
  }

  mediaSourceTypeFromFileName(baseName);
  return baseName;
}

export async function uniqueFileName(assetsDirectory: string, fileName: string): Promise<string> {
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

export function imageDurationFromForm(value: FormDataEntryValue | null): number {
  if (typeof value !== "string" || value.trim() === "") {
    return defaultImageDurationSeconds;
  }

  const duration = Number.parseInt(value, 10);
  if (!Number.isFinite(duration)) {
    return defaultImageDurationSeconds;
  }

  return Math.min(Math.max(duration, minimumImageDurationSeconds), maximumImageDurationSeconds);
}

export function stillClipFileName(fileName: string, durationSeconds: number): string {
  const baseName = path.basename(fileName, path.extname(fileName));
  return `${baseName}.still-${durationSeconds}s.mp4`;
}

export function transcodedVideoFileName(fileName: string): string {
  const baseName = path.basename(fileName, path.extname(fileName));
  return `${baseName}.transcoded.mp4`;
}

export async function createStillVideoClip(
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
    const nodeError = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals;
      stderr?: string;
    };

    if (nodeError.code === "ENOENT") {
      throw new MediaUploadError(
        "JPEG/PNG uploads need ffmpeg before they can become Pi-safe MP4 still clips. Install ffmpeg locally or set PISIGNAGE_FFMPEG_BIN, then try again.",
        503
      );
    }

    if (nodeError.killed || nodeError.signal === "SIGTERM") {
      throw new MediaUploadError(
        "The image conversion timed out before ffmpeg finished. Try a smaller image or a shorter still duration.",
        504
      );
    }

    const detail = typeof nodeError.stderr === "string" && nodeError.stderr.trim()
      ? ` ffmpeg said: ${nodeError.stderr.trim().split("\n").at(-1)}`
      : "";
    throw new MediaUploadError(
      `That image could not be converted into a Pi-safe MP4 still clip.${detail}`,
      422
    );
  }
}

export async function createPlaybackSafeVideoClip(
  sourceVideoPath: string,
  outputVideoPath: string
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
        "-i",
        sourceVideoPath,
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
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "48000",
        "-ac",
        "2",
        temporaryOutputPath
      ],
      { timeout: 300_000, maxBuffer: 1024 * 1024 * 4 }
    );
    await fs.rename(temporaryOutputPath, outputVideoPath);
  } catch (error) {
    await fs.rm(temporaryOutputPath, { force: true });
    const nodeError = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals;
      stderr?: string;
    };

    if (nodeError.code === "ENOENT") {
      throw new MediaUploadError(
        "MOV uploads need ffmpeg conversion before Pi playback. Install ffmpeg locally or set PISIGNAGE_FFMPEG_BIN, then try again.",
        503
      );
    }

    if (nodeError.killed || nodeError.signal === "SIGTERM") {
      throw new MediaUploadError(
        "The MOV conversion timed out before ffmpeg finished. Try a shorter or smaller source video.",
        504
      );
    }

    const detail = typeof nodeError.stderr === "string" && nodeError.stderr.trim()
      ? ` ffmpeg said: ${nodeError.stderr.trim().split("\n").at(-1)}`
      : "";
    throw new MediaUploadError(
      `That MOV file could not be converted into a Pi-safe MP4.${detail}`,
      422
    );
  }
}

export function formatUploadLimit(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}
