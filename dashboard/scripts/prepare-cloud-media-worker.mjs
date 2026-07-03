import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);
const dynamoDb = new DynamoDBClient({});
const s3 = new S3Client({});
const assetId = process.argv[2];
const tableName = process.env.BEAM_ASSETS_TABLE_NAME;
const defaultSourceBucketName = process.env.BEAM_SOURCE_MEDIA_BUCKET_NAME;
const defaultPlaybackBucketName = process.env.BEAM_PLAYBACK_MEDIA_BUCKET_NAME || defaultSourceBucketName;
const profile = {
  audioCodec: "aac",
  fps: 30,
  height: 1080,
  id: "signage-1080p-v1",
  pixelFormat: "yuv420p",
  videoCodec: "h264",
  width: 1920
};

function text(item, key, fallback = "") {
  const value = item[key];
  return value?.S ?? fallback;
}

function numberAttr(value) {
  return Number.isFinite(value) ? { N: String(value) } : { NULL: true };
}

async function updateItem(item, updates) {
  await dynamoDb.send(new PutItemCommand({
    TableName: tableName,
    Item: {
      ...item,
      ...updates,
      updatedAt: { S: new Date().toISOString() }
    }
  }));
}

async function readAsset() {
  const result = await dynamoDb.send(new GetItemCommand({
    Key: { assetId: { S: assetId } },
    TableName: tableName
  }));
  return result.Item ?? null;
}

async function bodyToBuffer(body) {
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes);
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function probe(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 * 2 });
  const output = JSON.parse(stdout);
  const video = output.streams?.find((stream) => stream.codec_type === "video") ?? {};
  const audio = output.streams?.find((stream) => stream.codec_type === "audio") ?? {};
  const fps = parseRate(video.avg_frame_rate ?? video.r_frame_rate);
  return {
    audioCodec: audio.codec_name ?? null,
    bitRate: parseNumber(video.bit_rate ?? output.format?.bit_rate),
    durationSeconds: parseNumber(output.format?.duration),
    fps,
    height: video.height ?? null,
    pixelFormat: video.pix_fmt ?? null,
    videoCodec: video.codec_name ?? null,
    videoProfile: video.profile ?? null,
    width: video.width ?? null
  };
}

function parseNumber(value) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRate(value) {
  const [left, right = "1"] = String(value ?? "").split("/");
  const numerator = Number.parseFloat(left);
  const denominator = Number.parseFloat(right);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 ? numerator / denominator : null;
}

function playbackFilter() {
  const size = `${profile.width}:${profile.height}`;
  return `scale=${size}:force_original_aspect_ratio=decrease:in_range=full:out_range=tv,pad=${size}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${profile.fps},format=yuv420p`;
}

function isPlaybackSafe(probeResult) {
  return (
    probeResult.videoCodec === profile.videoCodec &&
    probeResult.width === profile.width &&
    probeResult.height === profile.height &&
    probeResult.pixelFormat === profile.pixelFormat &&
    probeResult.fps !== null &&
    Math.abs(probeResult.fps - profile.fps) <= 0.05 &&
    (probeResult.audioCodec === null || probeResult.audioCodec === profile.audioCodec)
  );
}

function mediaSourceType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg" || extension === ".png") {
    return "image";
  }
  return "video";
}

async function createStillVideo(sourcePath, outputPath, durationSeconds) {
  const size = `${profile.width}:${profile.height}`;
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1",
    "-framerate", String(profile.fps),
    "-t", String(durationSeconds),
    "-i", sourcePath,
    "-f", "lavfi",
    "-t", String(durationSeconds),
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-vf", `scale=${size}:force_original_aspect_ratio=decrease:in_range=full:out_range=tv,pad=${size}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`,
    "-r", String(profile.fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-profile:v", "baseline",
    "-level:v", "4.0",
    "-pix_fmt", "yuv420p",
    "-x264-params", `keyint=${profile.fps}:min-keyint=${profile.fps}:scenecut=0:bframes=0`,
    "-color_range", "tv",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-c:a", "aac",
    "-b:a", "96k",
    "-shortest",
    "-movflags", "+faststart",
    outputPath
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 * 4 });
}

async function copyPlaybackSafeVideo(sourcePath, outputPath) {
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", sourcePath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-dn",
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 * 4 });
  const playbackProbe = await probe(outputPath);
  if (!isPlaybackSafe(playbackProbe)) {
    throw new Error(`Prepared copy did not match ${profile.id}.`);
  }
}

async function transcodeVideo(sourcePath, outputPath) {
  const sourceProbe = await probe(sourcePath);
  if (isPlaybackSafe(sourceProbe)) {
    await copyPlaybackSafeVideo(sourcePath, outputPath);
    return;
  }

  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", sourcePath,
    "-vf", playbackFilter(),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-maxrate", "12M",
    "-bufsize", "24M",
    "-profile:v", "high",
    "-level:v", "4.0",
    "-pix_fmt", "yuv420p",
    "-color_range", "tv",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    outputPath
  ], { timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 * 4 });
}

async function main() {
  if (!assetId || !tableName || !defaultSourceBucketName || !defaultPlaybackBucketName) {
    throw new Error("Missing media worker configuration.");
  }
  const item = await readAsset();
  if (!item) {
    throw new Error(`Media item ${assetId} was not found.`);
  }
  if (text(item, "status") === "ready" && text(item, "playbackObjectKey") && text(item, "preparedAt")) {
    console.log(`Preparing ${assetId}: already ready`);
    return;
  }

  const sourceFileName = text(item, "sourceFileName");
  const playbackFileName = text(item, "playbackFileName");
  const sourceObjectKey = text(item, "sourceObjectKey");
  const sourceBucketName = text(item, "sourceStorageBucket", defaultSourceBucketName);
  const playbackBucketName = text(item, "playbackStorageBucket", defaultPlaybackBucketName);
  const durationSeconds = Number.parseFloat(item.durationSeconds?.N ?? "30");
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "beam-worker-"));
  const sourcePath = path.join(tempDirectory, sourceFileName);
  const playbackPath = path.join(tempDirectory, playbackFileName);

  try {
    console.log(`Preparing ${assetId}: downloading ${sourceFileName}`);
    await updateItem(item, {
      cloudStatusDetail: { S: "Downloading source media from AWS." },
      playbackProfile: { S: "preparing-playback-mp4-v1" },
      status: { S: "processing" }
    });
    const sourceObject = await s3.send(new GetObjectCommand({ Bucket: sourceBucketName, Key: sourceObjectKey }));
    await fs.writeFile(sourcePath, await bodyToBuffer(sourceObject.Body));

    const sourceType = mediaSourceType(sourceFileName);
    const stage = sourceType === "image"
      ? "Converting image into a timed Pi-safe MP4 clip."
      : "Transcoding video into a Pi-safe MP4.";
    console.log(`Preparing ${assetId}: ${stage}`);
    await updateItem(item, {
      cloudStatusDetail: { S: stage },
      playbackProfile: { S: "preparing-playback-mp4-v1" },
      status: { S: "processing" }
    });
    if (sourceType === "image") {
      await createStillVideo(sourcePath, playbackPath, Number.isFinite(durationSeconds) ? durationSeconds : 10);
    } else {
      await transcodeVideo(sourcePath, playbackPath);
    }

    console.log(`Preparing ${assetId}: uploading ${playbackFileName}`);
    await updateItem(item, {
      cloudStatusDetail: { S: "Uploading prepared playback copy to AWS." },
      playbackProfile: { S: "preparing-playback-mp4-v1" },
      status: { S: "processing" }
    });
    const [metadata, checksum, stat] = await Promise.all([probe(playbackPath), sha256(playbackPath), fs.stat(playbackPath)]);
    const now = new Date().toISOString();
    const playbackObjectKey = `playback/${now.slice(0, 10)}/${assetId}/${playbackFileName}`;

    await s3.send(new PutObjectCommand({
      Body: await fs.readFile(playbackPath),
      Bucket: playbackBucketName,
      ContentLength: stat.size,
      ContentType: "video/mp4",
      Key: playbackObjectKey,
      ServerSideEncryption: "AES256"
    }));

    await updateItem(item, {
      audioCodec: metadata.audioCodec ? { S: metadata.audioCodec } : { NULL: true },
      bitRate: numberAttr(metadata.bitRate),
      checksumSha256: { S: checksum },
      cloudStatusDetail: { S: `Prepared ${profile.width}x${profile.height} H.264 playback copy for Pi/VLC.` },
      durationSeconds: numberAttr(metadata.durationSeconds),
      fps: numberAttr(metadata.fps),
      height: numberAttr(metadata.height),
      mimeType: { S: "video/mp4" },
      pixelFormat: metadata.pixelFormat ? { S: metadata.pixelFormat } : { NULL: true },
      playbackObjectKey: { S: playbackObjectKey },
      playbackProfile: { S: profile.id },
      playbackStorageBucket: { S: playbackBucketName },
      preparedAt: { S: now },
      sizeBytes: { N: String(stat.size) },
      status: { S: "ready" },
      storageBucket: { S: playbackBucketName },
      videoCodec: metadata.videoCodec ? { S: metadata.videoCodec } : { NULL: true },
      videoProfile: metadata.videoProfile ? { S: metadata.videoProfile } : { NULL: true },
      width: numberAttr(metadata.width)
    });
    console.log(`Preparing ${assetId}: ready`);
  } catch (error) {
    console.error(`Preparing ${assetId} failed`, error);
    const latest = await readAsset();
    if (latest && text(latest, "status") === "ready" && text(latest, "playbackObjectKey") && text(latest, "preparedAt")) {
      console.warn(`Preparing ${assetId}: failure ignored because the media is already ready`);
      return;
    }

    await updateItem(latest ?? item, {
      cloudStatusDetail: { S: error instanceof Error ? error.message : "Media preparation failed." },
      status: { S: "failed" }
    });
    throw error;
  } finally {
    await fs.rm(tempDirectory, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
