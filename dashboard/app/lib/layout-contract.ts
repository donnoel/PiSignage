import path from "node:path";
import type { PlaylistAsset } from "./local-playlist";
import { isPlaybackSafeVideoFileName } from "./playback-safety";

export const layoutContractVersion = 1;
export const defaultLayoutCanvas = {
  width: 1920,
  height: 1080,
  backgroundColor: "#000000"
} as const;

export const maxLayoutLayers = 24;
export const minLayoutDurationSeconds = 1;
export const maxLayoutDurationSeconds = 3600;

export type LayoutCanvas = {
  backgroundColor: string;
  height: number;
  width: number;
};

export type LayoutFit = "contain" | "cover" | "fill";
export type LayoutHorizontalAlign = "left" | "center" | "right";
export type LayoutVerticalAlign = "top" | "middle" | "bottom";

type LayoutLayerBase = {
  height: number;
  id: string;
  name?: string;
  opacity?: number;
  rotationDegrees?: number;
  width: number;
  x: number;
  y: number;
  zIndex: number;
};

export type LayoutMediaLayer = LayoutLayerBase & {
  fit: LayoutFit;
  kind: "media";
  mediaId: string;
  muted: boolean;
};

export type LayoutTextLayer = LayoutLayerBase & {
  align: LayoutHorizontalAlign;
  backgroundColor?: string;
  color: string;
  fontSize: number;
  fontWeight: "regular" | "medium" | "bold";
  kind: "text";
  text: string;
  verticalAlign: LayoutVerticalAlign;
};

export type LayoutShapeLayer = LayoutLayerBase & {
  fillColor?: string;
  kind: "shape";
  shape: "rectangle";
  strokeColor?: string;
  strokeWidth?: number;
};

export type LayoutLayer = LayoutMediaLayer | LayoutTextLayer | LayoutShapeLayer;

export type LayoutRender =
  | {
      reason?: string;
      status: "not-rendered";
    }
  | {
      failedAt: string;
      message: string;
      status: "failed";
    }
  | {
      mediaId: string;
      playbackFileName: string;
      renderedAt: string;
      status: "ready";
    };

export type ReadyLayoutRender = Extract<LayoutRender, { status: "ready" }>;

export type LayoutTemplate = {
  canvas: LayoutCanvas;
  contractVersion: typeof layoutContractVersion;
  durationSeconds: number;
  id: string;
  layers: LayoutLayer[];
  name: string;
  render: LayoutRender;
  updatedAt: string;
  version: number;
  workspaceId?: string;
};

export type LayoutStore = {
  items: LayoutTemplate[];
  updatedAt: string;
  version: number;
};

export type LayoutValidationResult =
  | {
      ok: true;
      value: LayoutTemplate;
    }
  | {
      errors: string[];
      ok: false;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength = 160): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isOptionalString(value: unknown, maxLength = 240): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isSafeColor(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

function validateOptionalColor(value: unknown, label: string, errors: string[]): void {
  if (value !== undefined && !isSafeColor(value)) {
    errors.push(`${label} must be a #RRGGBB or #RRGGBBAA color.`);
  }
}

function validateCanvas(canvas: unknown, errors: string[]): canvas is LayoutCanvas {
  if (!isRecord(canvas)) {
    errors.push("Layout canvas must be an object.");
    return false;
  }

  if (canvas.width !== defaultLayoutCanvas.width || canvas.height !== defaultLayoutCanvas.height) {
    errors.push("Layout canvas must be 1920x1080 for the initial Pi-safe render pipeline.");
  }

  if (!isSafeColor(canvas.backgroundColor)) {
    errors.push("Layout canvas backgroundColor must be a #RRGGBB or #RRGGBBAA color.");
  }

  return errors.length === 0;
}

function validateLayerFrame(
  layer: Record<string, unknown>,
  canvas: LayoutCanvas,
  label: string,
  errors: string[]
): void {
  if (!isNonEmptyString(layer.id, 80)) {
    errors.push(`${label}: id is required.`);
  }

  if (!isOptionalString(layer.name)) {
    errors.push(`${label}: name must be a short string when present.`);
  }

  if (!isFiniteNumberInRange(layer.x, 0, canvas.width)) {
    errors.push(`${label}: x must be within the canvas.`);
  }

  if (!isFiniteNumberInRange(layer.y, 0, canvas.height)) {
    errors.push(`${label}: y must be within the canvas.`);
  }

  if (!isFiniteNumberInRange(layer.width, 1, canvas.width)) {
    errors.push(`${label}: width must fit within the canvas.`);
  }

  if (!isFiniteNumberInRange(layer.height, 1, canvas.height)) {
    errors.push(`${label}: height must fit within the canvas.`);
  }

  if (
    typeof layer.x === "number" &&
    typeof layer.width === "number" &&
    layer.x + layer.width > canvas.width
  ) {
    errors.push(`${label}: x + width must stay inside the canvas.`);
  }

  if (
    typeof layer.y === "number" &&
    typeof layer.height === "number" &&
    layer.y + layer.height > canvas.height
  ) {
    errors.push(`${label}: y + height must stay inside the canvas.`);
  }

  if (!isIntegerInRange(layer.zIndex, 0, 999)) {
    errors.push(`${label}: zIndex must be an integer between 0 and 999.`);
  }

  if (layer.opacity !== undefined && !isFiniteNumberInRange(layer.opacity, 0, 1)) {
    errors.push(`${label}: opacity must be between 0 and 1 when present.`);
  }

  if (layer.rotationDegrees !== undefined && !isFiniteNumberInRange(layer.rotationDegrees, -360, 360)) {
    errors.push(`${label}: rotationDegrees must be between -360 and 360 when present.`);
  }
}

function validateMediaLayer(layer: Record<string, unknown>, label: string, errors: string[]): void {
  if (!isNonEmptyString(layer.mediaId, 120)) {
    errors.push(`${label}: mediaId is required.`);
  }

  if (layer.fit !== "contain" && layer.fit !== "cover" && layer.fit !== "fill") {
    errors.push(`${label}: fit must be contain, cover, or fill.`);
  }

  if (typeof layer.muted !== "boolean") {
    errors.push(`${label}: muted must be true or false.`);
  }
}

function validateTextLayer(layer: Record<string, unknown>, label: string, errors: string[]): void {
  if (!isNonEmptyString(layer.text, 500)) {
    errors.push(`${label}: text is required.`);
  }

  if (!isFiniteNumberInRange(layer.fontSize, 8, 240)) {
    errors.push(`${label}: fontSize must be between 8 and 240.`);
  }

  if (layer.fontWeight !== "regular" && layer.fontWeight !== "medium" && layer.fontWeight !== "bold") {
    errors.push(`${label}: fontWeight must be regular, medium, or bold.`);
  }

  if (layer.align !== "left" && layer.align !== "center" && layer.align !== "right") {
    errors.push(`${label}: align must be left, center, or right.`);
  }

  if (
    layer.verticalAlign !== "top" &&
    layer.verticalAlign !== "middle" &&
    layer.verticalAlign !== "bottom"
  ) {
    errors.push(`${label}: verticalAlign must be top, middle, or bottom.`);
  }

  if (!isSafeColor(layer.color)) {
    errors.push(`${label}: color must be a #RRGGBB or #RRGGBBAA color.`);
  }

  validateOptionalColor(layer.backgroundColor, `${label}: backgroundColor`, errors);
}

function validateShapeLayer(layer: Record<string, unknown>, label: string, errors: string[]): void {
  if (layer.shape !== "rectangle") {
    errors.push(`${label}: shape must be rectangle.`);
  }

  validateOptionalColor(layer.fillColor, `${label}: fillColor`, errors);
  validateOptionalColor(layer.strokeColor, `${label}: strokeColor`, errors);

  if (layer.strokeWidth !== undefined && !isFiniteNumberInRange(layer.strokeWidth, 0, 80)) {
    errors.push(`${label}: strokeWidth must be between 0 and 80 when present.`);
  }
}

function validateLayer(layer: unknown, canvas: LayoutCanvas, index: number, errors: string[]): layer is LayoutLayer {
  const label = `Layer ${index + 1}`;
  if (!isRecord(layer)) {
    errors.push(`${label} must be an object.`);
    return false;
  }

  validateLayerFrame(layer, canvas, label, errors);

  if (layer.kind === "media") {
    validateMediaLayer(layer, label, errors);
  } else if (layer.kind === "text") {
    validateTextLayer(layer, label, errors);
  } else if (layer.kind === "shape") {
    validateShapeLayer(layer, label, errors);
  } else {
    errors.push(`${label}: kind must be media, text, or shape.`);
  }

  return true;
}

function validateRender(render: unknown, errors: string[]): render is LayoutRender {
  if (!isRecord(render)) {
    errors.push("Layout render must be an object.");
    return false;
  }

  if (render.status === "not-rendered") {
    if (!isOptionalString(render.reason, 240)) {
      errors.push("Layout render reason must be a short string when present.");
    }
  } else if (render.status === "failed") {
    if (!isNonEmptyString(render.message, 500)) {
      errors.push("Layout render failure message is required.");
    }
    if (!isIsoTimestamp(render.failedAt)) {
      errors.push("Layout render failedAt must be a valid timestamp.");
    }
  } else if (render.status === "ready") {
    if (!isNonEmptyString(render.mediaId, 120)) {
      errors.push("Layout render mediaId is required.");
    }
    if (
      !isNonEmptyString(render.playbackFileName, 240) ||
      path.basename(render.playbackFileName) !== render.playbackFileName
    ) {
      errors.push("Layout render playbackFileName must be a file name.");
    } else if (!isPlaybackSafeVideoFileName(render.playbackFileName)) {
      errors.push("Layout render playbackFileName must be a Pi-safe MP4.");
    }
    if (!isIsoTimestamp(render.renderedAt)) {
      errors.push("Layout render renderedAt must be a valid timestamp.");
    }
  } else {
    errors.push("Layout render status must be not-rendered, failed, or ready.");
  }

  return true;
}

export function validateLayoutTemplate(value: unknown): LayoutValidationResult {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return {
      errors: ["Layout template must be an object."],
      ok: false
    };
  }

  if (value.contractVersion !== layoutContractVersion) {
    errors.push(`Layout contractVersion must be ${layoutContractVersion}.`);
  }

  if (!isNonEmptyString(value.id, 120)) {
    errors.push("Layout id is required.");
  }

  if (!isNonEmptyString(value.name, 160)) {
    errors.push("Layout name is required.");
  }

  if (!isIntegerInRange(value.version, 1, 1_000_000)) {
    errors.push("Layout version must be a positive integer.");
  }

  if (!isIsoTimestamp(value.updatedAt)) {
    errors.push("Layout updatedAt must be a valid timestamp.");
  }

  if (!isIntegerInRange(value.durationSeconds, minLayoutDurationSeconds, maxLayoutDurationSeconds)) {
    errors.push("Layout durationSeconds must be between 1 and 3600.");
  }

  const canvas = value.canvas;
  const canvasErrors: string[] = [];
  const hasCanvas = validateCanvas(canvas, canvasErrors);
  errors.push(...canvasErrors);

  if (!Array.isArray(value.layers)) {
    errors.push("Layout layers must be an array.");
  } else if (value.layers.length === 0) {
    errors.push("Layout must contain at least one layer.");
  } else if (value.layers.length > maxLayoutLayers) {
    errors.push(`Layout must contain ${maxLayoutLayers} layers or fewer.`);
  }

  if (hasCanvas && Array.isArray(value.layers)) {
    const layerIds = new Set<string>();
    value.layers.forEach((layer, index) => {
      validateLayer(layer, canvas, index, errors);
      if (isRecord(layer) && typeof layer.id === "string") {
        if (layerIds.has(layer.id)) {
          errors.push(`Layer ${index + 1}: duplicate layer id.`);
        }
        layerIds.add(layer.id);
      }
    });
  }

  validateRender(value.render, errors);

  if (errors.length > 0) {
    return {
      errors,
      ok: false
    };
  }

  return {
    ok: true,
    value: value as LayoutTemplate
  };
}

export function assertValidLayoutTemplate(value: unknown): asserts value is LayoutTemplate {
  const result = validateLayoutTemplate(value);
  if (!result.ok) {
    throw new Error(`Layout template is malformed. ${result.errors.join(" ")}`);
  }
}

export function layoutHasReadyRenderedAsset(
  template: LayoutTemplate
): template is LayoutTemplate & { render: ReadyLayoutRender } {
  return (
    template.render.status === "ready" &&
    path.basename(template.render.playbackFileName) === template.render.playbackFileName &&
    isPlaybackSafeVideoFileName(template.render.playbackFileName)
  );
}

export function renderedLayoutPlaylistAsset(template: LayoutTemplate): PlaylistAsset | null {
  if (!layoutHasReadyRenderedAsset(template)) {
    return null;
  }

  return {
    assetId: `layout-${template.id}`,
    type: "video",
    uri: `assets/${template.render.playbackFileName}`,
    durationSeconds: template.durationSeconds,
    altText: template.name
  };
}
