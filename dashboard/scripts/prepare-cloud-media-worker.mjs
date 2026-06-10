import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);
const dynamoDb = new DynamoDBClient({});
const s3 = new S3Client({});
const assetId = process.argv[2];
const tableName = process.env.BEAM_ASSETS_TABLE_NAME;
const bucketName = process.env.BEAM_SOURCE_MEDIA_BUCKET_NAME;
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
  const result = await dynamoDb.send(new ScanCommand({ TableName: tableName }));
  return (result.Items ?? []).find((item) => text(item, "assetId") === assetId || text(item, "id") === assetId) ?? null;
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

async function transcodeVideo(sourcePath, outputPath) {
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", sourcePath,
    "-vf", playbackFilter(),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
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
  if (!assetId || !tableName || !bucketName) {
    throw new Error("Missing media worker configuration.");
  }
  const item = await readAsset();
  if (!item) {
    throw new Error(`Media item ${assetId} was not found.`);
  }

  const sourceFileName = text(item, "sourceFileName");
  const playbackFileName = text(item, "playbackFileName");
  const sourceObjectKey = text(item, "sourceObjectKey");
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "beam-worker-"));
  const sourcePath = path.join(tempDirectory, sourceFileName);
  const playbackPath = path.join(tempDirectory, playbackFileName);

  try {
    const sourceObject = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: sourceObjectKey }));
    await fs.writeFile(sourcePath, await bodyToBuffer(sourceObject.Body));
    await transcodeVideo(sourcePath, playbackPath);
    const [metadata, checksum, stat] = await Promise.all([probe(playbackPath), sha256(playbackPath), fs.stat(playbackPath)]);
    const now = new Date().toISOString();
    const playbackObjectKey = `playback/${now.slice(0, 10)}/${assetId}/${playbackFileName}`;

    await s3.send(new PutObjectCommand({
      Body: await fs.readFile(playbackPath),
      Bucket: bucketName,
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
      preparedAt: { S: now },
      sizeBytes: { N: String(stat.size) },
      status: { S: "ready" },
      videoCodec: metadata.videoCodec ? { S: metadata.videoCodec } : { NULL: true },
      videoProfile: metadata.videoProfile ? { S: metadata.videoProfile } : { NULL: true },
      width: numberAttr(metadata.width)
    });
  } catch (error) {
    await updateItem(item, {
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
