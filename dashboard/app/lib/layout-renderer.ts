import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { LayoutLayer, LayoutMediaLayer, LayoutShapeLayer, LayoutTemplate, LayoutTextLayer } from "./layout-contract";
import { MediaUploadError, playbackPrepProfile } from "./media-processing";

const ffmpegBinary = process.env.PISIGNAGE_FFMPEG_BIN ?? "ffmpeg";
const sipsBinary = process.env.PISIGNAGE_SIPS_BIN ?? "sips";
const execFileAsync = promisify(execFile);
const renderTimeoutMs = Number.parseInt(process.env.PISIGNAGE_LAYOUT_RENDER_TIMEOUT_MS ?? "", 10) || 5 * 60 * 1000;

export type LayoutMediaSource = {
  filePath: string;
  mediaId: string;
};

function ffmpegColor(value: string | undefined, fallback: string): string {
  const color = value ?? fallback;
  const match = color.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (!match) {
    return fallback;
  }

  const alpha = match[2] ? Number.parseInt(match[2], 16) / 255 : 1;
  return `0x${match[1]}@${Number(alpha.toFixed(3))}`;
}

function safeEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function mediaFitFilter(layer: LayoutMediaLayer): string {
  const width = safeEven(layer.width);
  const height = safeEven(layer.height);
  if (layer.fit === "fill") {
    return `scale=${width}:${height}:in_range=full:out_range=tv,setsar=1`;
  }

  const scaleMode = layer.fit === "cover" ? "increase" : "decrease";
  const finish = layer.fit === "cover"
    ? `crop=${width}:${height}`
    : `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;

  return `scale=${width}:${height}:force_original_aspect_ratio=${scaleMode}:in_range=full:out_range=tv,${finish},setsar=1`;
}

function textXExpression(layer: LayoutTextLayer): string {
  if (layer.align === "center") {
    return `${layer.x}+(${layer.width}-text_w)/2`;
  }
  if (layer.align === "right") {
    return `${layer.x}+${layer.width}-text_w`;
  }
  return String(layer.x);
}

function textYExpression(layer: LayoutTextLayer): string {
  if (layer.verticalAlign === "middle") {
    return `${layer.y}+(${layer.height}-text_h)/2`;
  }
  if (layer.verticalAlign === "bottom") {
    return `${layer.y}+${layer.height}-text_h`;
  }
  return String(layer.y);
}

function sortedLayers(layout: LayoutTemplate): LayoutLayer[] {
  return layout.layers.slice().sort((left, right) => left.zIndex - right.zIndex);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function svgPaint(value: string | undefined, fallback: string): { color: string; opacity: number } {
  const color = value ?? fallback;
  const match = color.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (!match) {
    return { color: fallback.slice(0, 7), opacity: 1 };
  }

  return {
    color: `#${match[1]}`,
    opacity: match[2] ? Number((Number.parseInt(match[2], 16) / 255).toFixed(3)) : 1
  };
}

function svgRect(layer: LayoutShapeLayer): string {
  const fill = svgPaint(layer.fillColor, "#000000");
  const stroke = layer.strokeColor ? svgPaint(layer.strokeColor, "#ffffff") : null;
  return [
    `<rect x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}"`,
    `fill="${fill.color}" fill-opacity="${fill.opacity}"`,
    stroke ? `stroke="${stroke.color}" stroke-opacity="${stroke.opacity}" stroke-width="${layer.strokeWidth ?? 1}"` : "",
    "/>"
  ].filter(Boolean).join(" ");
}

function svgText(layer: LayoutTextLayer): string {
  const paint = svgPaint(layer.color, "#ffffff");
  const anchor = layer.align === "center" ? "middle" : layer.align === "right" ? "end" : "start";
  const x = layer.align === "center" ? layer.x + layer.width / 2 : layer.align === "right" ? layer.x + layer.width : layer.x;
  const y = layer.verticalAlign === "middle"
    ? layer.y + layer.height / 2
    : layer.verticalAlign === "bottom"
      ? layer.y + layer.height - layer.fontSize * 0.15
      : layer.y + layer.fontSize;
  const baseline = layer.verticalAlign === "middle" ? "middle" : "auto";
  const weight = layer.fontWeight === "bold" ? 800 : layer.fontWeight === "medium" ? 650 : 500;
  const background = layer.backgroundColor
    ? svgRect({
        fillColor: layer.backgroundColor,
        height: layer.height,
        id: `${layer.id}-background`,
        kind: "shape",
        shape: "rectangle",
        width: layer.width,
        x: layer.x,
        y: layer.y,
        zIndex: layer.zIndex
      })
    : "";

  return `${background}<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(layer.fontSize)}" font-weight="${weight}" fill="${paint.color}" fill-opacity="${paint.opacity}">${escapeXml(layer.text)}</text>`;
}

function overlaySvg(layout: LayoutTemplate): string {
  const content = sortedLayers(layout)
    .filter((layer) => layer.kind !== "media")
    .map((layer) => (layer.kind === "shape" ? svgRect(layer) : svgText(layer)))
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.canvas.width}" height="${layout.canvas.height}" viewBox="0 0 ${layout.canvas.width} ${layout.canvas.height}">\n<rect width="${layout.canvas.width}" height="${layout.canvas.height}" fill="transparent"/>\n${content}\n</svg>\n`;
}

async function createOverlayPng(layout: LayoutTemplate, temporaryDirectory: string): Promise<string> {
  const svgPath = path.join(temporaryDirectory, "layout-overlay.svg");
  const pngPath = path.join(temporaryDirectory, "layout-overlay.png");
  await fs.writeFile(svgPath, overlaySvg(layout));

  try {
    await execFileAsync(
      sipsBinary,
      ["-s", "format", "png", svgPath, "--out", pngPath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 * 2 }
    );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & { stderr?: string };
    if (nodeError.code === "ENOENT") {
      throw new MediaUploadError("Layout rendering needs sips to rasterize text overlays on macOS.", 503);
    }

    const detail = typeof nodeError.stderr === "string" && nodeError.stderr.trim()
      ? ` sips said: ${nodeError.stderr.trim().split("\n").at(-1)}`
      : "";
    throw new MediaUploadError(`Layout text overlay could not be rasterized.${detail}`, 422);
  }

  return pngPath;
}

export async function renderLayoutToVideo(
  layout: LayoutTemplate,
  mediaSources: Map<string, LayoutMediaSource>,
  outputVideoPath: string
): Promise<void> {
  const temporaryOutputPath = `${outputVideoPath}.${process.pid}.tmp.mp4`;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pisignage-layout-render-"));
  const durationSeconds = Math.max(1, Math.round(layout.durationSeconds));
  const layers = sortedLayers(layout);
  const mediaLayers = layers.filter((layer): layer is LayoutMediaLayer => layer.kind === "media");
  const overlayPngPath = await createOverlayPng(layout, temporaryDirectory);
  const inputArgs: string[] = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-t",
    String(durationSeconds),
    "-i",
    `color=c=${ffmpegColor(layout.canvas.backgroundColor, "0x000000@1")}:s=${playbackPrepProfile.width}x${playbackPrepProfile.height}:r=${playbackPrepProfile.fps}`
  ];
  const mediaInputByLayerId = new Map<string, number>();

  for (const layer of mediaLayers) {
    const source = mediaSources.get(layer.mediaId);
    if (!source) {
      throw new MediaUploadError(`Layout media item ${layer.mediaId} was not found.`, 404);
    }

    mediaInputByLayerId.set(layer.id, mediaInputByLayerId.size + 1);
    inputArgs.push("-stream_loop", "-1", "-t", String(durationSeconds), "-i", source.filePath);
  }

  const overlayInputIndex = mediaLayers.length + 1;
  inputArgs.push("-loop", "1", "-t", String(durationSeconds), "-i", overlayPngPath);

  const audioInputIndex = mediaLayers.length + 2;
  inputArgs.push(
    "-f",
    "lavfi",
    "-t",
    String(durationSeconds),
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000"
  );

  const filterParts: string[] = [`[0:v]format=rgba[base0]`];
  let currentLabel = "base0";
  let labelIndex = 0;

  for (const layer of layers.filter((item) => item.kind === "media")) {
    const nextLabel = `base${labelIndex + 1}`;
    const inputIndex = mediaInputByLayerId.get(layer.id);
    if (inputIndex === undefined) {
      continue;
    }
    const mediaLabel = `media${labelIndex}`;
    filterParts.push(`[${inputIndex}:v]${mediaFitFilter(layer)},fps=${playbackPrepProfile.fps},format=rgba[${mediaLabel}]`);
    filterParts.push(`[${currentLabel}][${mediaLabel}]overlay=x=${layer.x}:y=${layer.y}:shortest=0:format=auto[${nextLabel}]`);
    currentLabel = nextLabel;
    labelIndex += 1;
  }

  const overlayLabel = `base${labelIndex + 1}`;
  filterParts.push(`[${overlayInputIndex}:v]format=rgba[overlay]`);
  filterParts.push(`[${currentLabel}][overlay]overlay=x=0:y=0:shortest=0:format=auto[${overlayLabel}]`);
  currentLabel = overlayLabel;
  filterParts.push(`[${currentLabel}]fps=${playbackPrepProfile.fps},format=yuv420p[vout]`);

  try {
    await execFileAsync(
      ffmpegBinary,
      [
        ...inputArgs,
        "-filter_complex",
        filterParts.join(";"),
        "-map",
        "[vout]",
        "-map",
        `${audioInputIndex}:a`,
        "-t",
        String(durationSeconds),
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
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-shortest",
        "-movflags",
        "+faststart",
        temporaryOutputPath
      ],
      { timeout: renderTimeoutMs, maxBuffer: 1024 * 1024 * 8 }
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
        "Layout rendering needs ffmpeg. Install ffmpeg locally or set PISIGNAGE_FFMPEG_BIN, then try again.",
        503
      );
    }

    if (nodeError.killed || nodeError.signal === "SIGTERM") {
      throw new MediaUploadError("Layout rendering timed out before ffmpeg finished.", 504);
    }

    const detail = typeof nodeError.stderr === "string" && nodeError.stderr.trim()
      ? ` ffmpeg said: ${nodeError.stderr.trim().split("\n").at(-1)}`
      : "";
    throw new MediaUploadError(`Layout could not be rendered.${detail}`, 422);
  } finally {
    await fs.rm(temporaryDirectory, { force: true, recursive: true });
  }
}
