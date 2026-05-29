#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const presets = [
  {
    name: "1080p-main-aac",
    size: "1920:1080",
    profile: "main",
    level: "4.0",
    fps: "30",
    audio: true
  },
  {
    name: "720p-main-aac",
    size: "1280:720",
    profile: "main",
    level: "3.1",
    fps: "30",
    audio: true
  },
  {
    name: "720p-baseline-aac",
    size: "1280:720",
    profile: "baseline",
    level: "3.1",
    fps: "30",
    audio: true
  }
];

function usage() {
  console.error(
    "Usage: node scripts/generate-still-video-presets.mjs <image> [durationSeconds] [outputDirectory]"
  );
}

function slugify(value) {
  return path
    .basename(value, path.extname(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "still-image";
}

function durationFrom(value) {
  const duration = Number.parseInt(value ?? "10", 10);
  if (!Number.isFinite(duration)) {
    return 10;
  }

  return Math.min(Math.max(duration, 1), 300);
}

async function run(command, args) {
  await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024 * 4,
    timeout: 120_000
  });
}

async function ffprobeSummary(filePath) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,profile,width,height,pix_fmt,color_range,avg_frame_rate,duration",
      "-of",
      "default=noprint_wrappers=1",
      filePath
    ],
    { maxBuffer: 1024 * 1024 }
  );
  return stdout.trim();
}

async function generatePreset(sourcePath, durationSeconds, outputDirectory, preset) {
  const outputPath = path.join(
    outputDirectory,
    `${slugify(sourcePath)}.${preset.name}.${durationSeconds}s.mp4`
  );
  const [width, height] = preset.size.split(":");
  const videoFilters = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:in_range=full:out_range=tv`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    "format=yuv420p"
  ].join(",");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    preset.fps,
    "-t",
    String(durationSeconds),
    "-i",
    sourcePath
  ];

  if (preset.audio) {
    args.push("-f", "lavfi", "-t", String(durationSeconds), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }

  args.push(
    "-vf",
    videoFilters,
    "-r",
    preset.fps,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-profile:v",
    preset.profile,
    "-level:v",
    preset.level,
    "-pix_fmt",
    "yuv420p",
    "-x264-params",
    `keyint=${preset.fps}:min-keyint=${preset.fps}:scenecut=0:bframes=0`,
    "-color_range",
    "tv",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709"
  );

  if (preset.audio) {
    args.push("-c:a", "aac", "-b:a", "96k", "-shortest");
  }

  args.push("-movflags", "+faststart", outputPath);

  await run("ffmpeg", args);
  const summary = await ffprobeSummary(outputPath);
  console.log(`created ${outputPath}`);
  console.log(summary);
  return outputPath;
}

async function main() {
  const sourcePath = process.argv[2];

  if (!sourcePath) {
    usage();
    process.exitCode = 2;
    return;
  }

  const durationSeconds = durationFrom(process.argv[3]);
  const outputDirectory = path.resolve(process.argv[4] ?? "sample-content/assets/still-tests");
  await mkdir(outputDirectory, { recursive: true });

  for (const preset of presets) {
    await generatePreset(sourcePath, durationSeconds, outputDirectory, preset);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
