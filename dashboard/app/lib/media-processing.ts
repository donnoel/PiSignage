import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
const ffprobeBinary = process.env.PISIGNAGE_FFPROBE_BIN ?? "ffprobe";
const execFileAsync = promisify(execFile);

export type MediaSourceType = "image" | "video";

export type PlaybackPrepProfile = {
  audioCodec: "aac";
  fps: number;
  height: number;
  id: string;
  pixelFormat: "yuv420p";
  videoCodec: "h264";
  width: number;
};

export type MediaProbe = {
  audioCodec: string | null;
  averageFps: number | null;
  bitRate: number | null;
  durationSeconds: number | null;
  fps: number | null;
  height: number | null;
  pixelFormat: string | null;
  videoCodec: string | null;
  videoProfile: string | null;
  width: number | null;
};

type FfprobeStream = {
  avg_frame_rate?: string;
  bit_rate?: string;
  codec_name?: string;
  codec_type?: string;
  height?: number;
  pix_fmt?: string;
  profile?: string;
  r_frame_rate?: string;
  width?: number;
};

type FfprobeOutput = {
  format?: {
    bit_rate?: string;
    duration?: string;
  };
  streams?: FfprobeStream[];
};

export const playbackPrepProfile: PlaybackPrepProfile = {
  audioCodec: "aac",
  fps: 30,
  height: 1080,
  id: "signage-1080p-v1",
  pixelFormat: "yuv420p",
  videoCodec: "h264",
  width: 1920
};

const defaultVideoTranscodeTimeoutMs = 30 * 60 * 1000;
const configuredVideoTranscodeTimeoutMs = Number.parseInt(
  process.env.PISIGNAGE_VIDEO_TRANSCODE_TIMEOUT_MS ?? "",
  10
);
const videoTranscodeTimeoutMs = Number.isFinite(configuredVideoTranscodeTimeoutMs)
  ? configuredVideoTranscodeTimeoutMs
  : defaultVideoTranscodeTimeoutMs;

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
  return `${baseName}.signage-1080p.mp4`;
}

function parseNullableNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number.parseFloat(numeratorText ?? "");
  const denominator = Number.parseFloat(denominatorText ?? "1");
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return numerator / denominator;
}

function playbackSafeVideoFilter(): string {
  const targetSize = `${playbackPrepProfile.width}:${playbackPrepProfile.height}`;
  const scaleAndPad =
    `scale=${targetSize}:force_original_aspect_ratio=decrease:in_range=full:out_range=tv,` +
    `pad=${targetSize}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const cadence = `fps=${playbackPrepProfile.fps}`;

  return `${scaleAndPad},${cadence},format=yuv420p`;
}

export async function sha256ForFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function probeMediaFile(filePath: string): Promise<MediaProbe> {
  try {
    const { stdout } = await execFileAsync(
      ffprobeBinary,
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 * 2 }
    );
    const output = JSON.parse(stdout) as FfprobeOutput;
    const video = output.streams?.find((stream) => stream.codec_type === "video");
    const audio = output.streams?.find((stream) => stream.codec_type === "audio");

    return {
      audioCodec: audio?.codec_name ?? null,
      averageFps: parseFrameRate(video?.avg_frame_rate),
      bitRate: parseNullableNumber(video?.bit_rate ?? output.format?.bit_rate),
      durationSeconds: parseNullableNumber(output.format?.duration),
      fps: parseFrameRate(video?.r_frame_rate),
      height: video?.height ?? null,
      pixelFormat: video?.pix_fmt ?? null,
      videoCodec: video?.codec_name ?? null,
      videoProfile: video?.profile ?? null,
      width: video?.width ?? null
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & { stderr?: string };
    if (nodeError.code === "ENOENT") {
      throw new MediaUploadError(
        "Video validation needs ffprobe. Install ffmpeg locally or set PISIGNAGE_FFPROBE_BIN, then try again.",
        503
      );
    }

    const detail = typeof nodeError.stderr === "string" && nodeError.stderr.trim()
      ? ` ffprobe said: ${nodeError.stderr.trim().split("\n").at(-1)}`
      : "";
    throw new MediaUploadError(`That media file could not be inspected.${detail}`, 422);
  }
}

export function validatePlaybackSafeProbe(probe: MediaProbe): string[] {
  const failures = [];

  if (probe.videoCodec !== playbackPrepProfile.videoCodec) {
    failures.push(`video codec must be ${playbackPrepProfile.videoCodec}`);
  }
  if (probe.width !== playbackPrepProfile.width || probe.height !== playbackPrepProfile.height) {
    failures.push(`resolution must be ${playbackPrepProfile.width}x${playbackPrepProfile.height}`);
  }
  if (probe.pixelFormat !== playbackPrepProfile.pixelFormat) {
    failures.push(`pixel format must be ${playbackPrepProfile.pixelFormat}`);
  }
  if (
    probe.fps === null ||
    probe.averageFps === null ||
    Math.abs(probe.fps - playbackPrepProfile.fps) > 0.05 ||
    Math.abs(probe.averageFps - playbackPrepProfile.fps) > 0.05
  ) {
    failures.push(`frame rate must be constant ${playbackPrepProfile.fps}fps`);
  }
  if (probe.audioCodec !== null && probe.audioCodec !== playbackPrepProfile.audioCodec) {
    failures.push(`audio codec must be ${playbackPrepProfile.audioCodec} when audio is present`);
  }

  return failures;
}

export function isPlaybackSafeProbe(probe: MediaProbe): boolean {
  return validatePlaybackSafeProbe(probe).length === 0;
}

export async function assertPlaybackSafeVideoFile(filePath: string): Promise<MediaProbe> {
  const probe = await probeMediaFile(filePath);
  const failures = validatePlaybackSafeProbe(probe);
  if (failures.length > 0) {
    throw new MediaUploadError(
      `Prepared video did not match ${playbackPrepProfile.id}: ${failures.join("; ")}.`,
      422
    );
  }

  return probe;
}

export async function createPlaybackSafeVideoCopy(
  sourceVideoPath: string,
  outputVideoPath: string
): Promise<void> {
  const temporaryOutputPath = `${outputVideoPath}.${process.pid}.tmp.mp4`;

  try {
    const sourceProbe = await probeMediaFile(sourceVideoPath);
    const failures = validatePlaybackSafeProbe(sourceProbe);
    if (failures.length > 0) {
      throw new MediaUploadError(
        `Source video did not match ${playbackPrepProfile.id}: ${failures.join("; ")}.`,
        422
      );
    }

    await execFileAsync(
      ffmpegBinary,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        sourceVideoPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-dn",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        temporaryOutputPath
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 * 4 }
    );
    await assertPlaybackSafeVideoFile(temporaryOutputPath);
    await fs.rename(temporaryOutputPath, outputVideoPath);
  } catch (error) {
    await fs.rm(temporaryOutputPath, { force: true });
    throw error;
  }
}

export async function createStillVideoClip(
  sourceImagePath: string,
  outputVideoPath: string,
  durationSeconds: number
): Promise<void> {
  const temporaryOutputPath = `${outputVideoPath}.${process.pid}.tmp.mp4`;
  const targetSize = `${playbackPrepProfile.width}:${playbackPrepProfile.height}`;

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
        `scale=${targetSize}:force_original_aspect_ratio=decrease:in_range=full:out_range=tv,pad=${targetSize}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`,
        "-r",
        String(playbackPrepProfile.fps),
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-profile:v",
        "baseline",
        "-level:v",
        "4.0",
        "-pix_fmt",
        "yuv420p",
        "-x264-params",
        `keyint=${playbackPrepProfile.fps}:min-keyint=${playbackPrepProfile.fps}:scenecut=0:bframes=0`,
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
    const sourceProbe = await probeMediaFile(sourceVideoPath);
    if (isPlaybackSafeProbe(sourceProbe)) {
      await createPlaybackSafeVideoCopy(sourceVideoPath, outputVideoPath);
      return;
    }

    const targetVideoFilter = playbackSafeVideoFilter();

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
        targetVideoFilter,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-maxrate",
        "12M",
        "-bufsize",
        "24M",
        "-profile:v",
        "high",
        "-level:v",
        "4.0",
        "-pix_fmt",
        "yuv420p",
        "-color_range",
        "tv",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
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
      { timeout: videoTranscodeTimeoutMs, maxBuffer: 1024 * 1024 * 4 }
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
        "Video uploads need ffmpeg conversion before Pi playback. Install ffmpeg locally or set PISIGNAGE_FFMPEG_BIN, then try again.",
        503
      );
    }

    if (nodeError.killed || nodeError.signal === "SIGTERM") {
      throw new MediaUploadError(
        "The video conversion timed out before ffmpeg finished. Try a shorter or smaller source video.",
        504
      );
    }

    const detail = typeof nodeError.stderr === "string" && nodeError.stderr.trim()
      ? ` ffmpeg said: ${nodeError.stderr.trim().split("\n").at(-1)}`
      : "";
    throw new MediaUploadError(
      `That video file could not be converted into a Pi-safe MP4.${detail}`,
      422
    );
  }
}

export function formatUploadLimit(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}
