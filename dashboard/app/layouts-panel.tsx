"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

type LayoutPreset = "fullscreen-overlay" | "inset-cta" | "side-by-side";

type LayoutCanvas = {
  backgroundColor: string;
  height: number;
  width: number;
};

type LayoutLayerBase = {
  height: number;
  id: string;
  name?: string;
  opacity?: number;
  width: number;
  x: number;
  y: number;
  zIndex: number;
};

type LayoutMediaLayer = LayoutLayerBase & {
  fit: "contain" | "cover" | "fill";
  kind: "media";
  mediaId: string;
  muted: boolean;
};

type LayoutTextLayer = LayoutLayerBase & {
  align: "left" | "center" | "right";
  backgroundColor?: string;
  color: string;
  fontSize: number;
  fontWeight: "regular" | "medium" | "bold";
  kind: "text";
  text: string;
  verticalAlign: "top" | "middle" | "bottom";
};

type LayoutShapeLayer = LayoutLayerBase & {
  fillColor?: string;
  kind: "shape";
  shape: "rectangle";
  strokeColor?: string;
  strokeWidth?: number;
};

type LayoutLayer = LayoutMediaLayer | LayoutTextLayer | LayoutShapeLayer;

type LayoutTemplate = {
  canvas: LayoutCanvas;
  durationSeconds: number;
  id: string;
  layers: LayoutLayer[];
  name: string;
  render: {
    reason?: string;
    status: "not-rendered" | "failed" | "ready";
  };
  updatedAt: string;
  version: number;
};

type LayoutApiResponse = {
  layouts: LayoutTemplate[];
};

type MediaItem = {
  id: string;
  durationSeconds: number | null;
  origin: "media-store" | "playlist";
  playbackFileName: string;
  status: "ready" | "processing" | "failed";
  title: string;
};

type MediaApiResponse = {
  items: MediaItem[];
};

type SaveResponse = {
  error?: string;
  layout?: LayoutTemplate;
  message?: string;
};

const canvas = {
  backgroundColor: "#08111f",
  height: 1080,
  width: 1920
};

const presetLabels: Record<LayoutPreset, string> = {
  "fullscreen-overlay": "Fullscreen overlay",
  "inset-cta": "Inset video",
  "side-by-side": "Side-by-side"
};

const presetDescriptions: Record<LayoutPreset, string> = {
  "fullscreen-overlay": "Full video, bottom callout",
  "inset-cta": "Framed video, right text",
  "side-by-side": "Two regions, shared text"
};

function textLayer(id: string, text: string, frame: Omit<LayoutLayerBase, "id">, options: Partial<LayoutTextLayer> = {}): LayoutTextLayer {
  return {
    align: options.align ?? "left",
    color: options.color ?? "#ffffff",
    fontSize: options.fontSize ?? 64,
    fontWeight: options.fontWeight ?? "bold",
    id,
    kind: "text",
    text,
    verticalAlign: options.verticalAlign ?? "middle",
    ...frame,
    ...(options.backgroundColor ? { backgroundColor: options.backgroundColor } : {})
  };
}

function shapeLayer(id: string, frame: Omit<LayoutLayerBase, "id">, options: Partial<LayoutShapeLayer> = {}): LayoutShapeLayer {
  return {
    fillColor: options.fillColor,
    id,
    kind: "shape",
    shape: "rectangle",
    strokeColor: options.strokeColor,
    strokeWidth: options.strokeWidth,
    ...frame
  };
}

function mediaLayer(id: string, mediaId: string, frame: Omit<LayoutLayerBase, "id">, fit: LayoutMediaLayer["fit"] = "cover"): LayoutMediaLayer {
  return {
    fit,
    id,
    kind: "media",
    mediaId,
    muted: true,
    ...frame
  };
}

function layersForPreset(preset: LayoutPreset, mediaId: string, headline: string, detail: string): LayoutLayer[] {
  if (preset === "inset-cta") {
    return [
      shapeLayer("background", { height: 1080, width: 1920, x: 0, y: 0, zIndex: 0 }, { fillColor: "#0f172a" }),
      shapeLayer("video-border", { height: 840, width: 1180, x: 90, y: 120, zIndex: 1 }, { fillColor: "#ffffff", strokeColor: "#ccfbf1", strokeWidth: 8 }),
      mediaLayer("main-video", mediaId, { height: 780, width: 1120, x: 120, y: 150, zIndex: 2 }),
      textLayer("headline", headline, { height: 260, width: 500, x: 1330, y: 170, zIndex: 3 }, { fontSize: 82 }),
      textLayer("detail", detail, { height: 150, width: 500, x: 1330, y: 470, zIndex: 3 }, { color: "#ccfbf1", fontSize: 54, fontWeight: "medium" })
    ];
  }

  if (preset === "side-by-side") {
    return [
      shapeLayer("background", { height: 1080, width: 1920, x: 0, y: 0, zIndex: 0 }, { fillColor: "#111827" }),
      mediaLayer("left-video", mediaId, { height: 760, width: 840, x: 90, y: 150, zIndex: 1 }),
      mediaLayer("right-video", mediaId, { height: 760, width: 840, x: 990, y: 150, zIndex: 1 }),
      shapeLayer("caption-bar", { height: 130, width: 1740, x: 90, y: 910, zIndex: 2 }, { fillColor: "#14b8a6e6" }),
      textLayer("caption", `${headline}  ${detail}`, { height: 110, width: 1660, x: 130, y: 920, zIndex: 3 }, { align: "center", color: "#082f49", fontSize: 58 })
    ];
  }

  return [
    mediaLayer("fullscreen-video", mediaId, { height: 1080, width: 1920, x: 0, y: 0, zIndex: 0 }),
    shapeLayer("lower-third", { height: 210, opacity: 0.92, width: 1760, x: 80, y: 790, zIndex: 1 }, { fillColor: "#0f172ae6" }),
    textLayer("headline", headline, { height: 96, width: 1640, x: 140, y: 820, zIndex: 2 }, { fontSize: 70 }),
    textLayer("detail", detail, { height: 72, width: 1640, x: 140, y: 914, zIndex: 2 }, { color: "#99f6e4", fontSize: 48, fontWeight: "medium" })
  ];
}

function inferPreset(layout: LayoutTemplate): LayoutPreset {
  const mediaCount = layout.layers.filter((layer) => layer.kind === "media").length;
  if (mediaCount >= 2) {
    return "side-by-side";
  }
  if (layout.layers.some((layer) => layer.kind === "media" && layer.width < 1600)) {
    return "inset-cta";
  }
  return "fullscreen-overlay";
}

function firstMediaId(layout: LayoutTemplate): string {
  return layout.layers.find((layer): layer is LayoutMediaLayer => layer.kind === "media")?.mediaId ?? "";
}

function firstText(layout: LayoutTemplate, fallback: string, index: number): string {
  return layout.layers.filter((layer): layer is LayoutTextLayer => layer.kind === "text")[index]?.text ?? fallback;
}

function layerStyle(layer: LayoutLayer): CSSProperties {
  return {
    height: `${(layer.height / canvas.height) * 100}%`,
    left: `${(layer.x / canvas.width) * 100}%`,
    opacity: layer.opacity,
    top: `${(layer.y / canvas.height) * 100}%`,
    width: `${(layer.width / canvas.width) * 100}%`,
    zIndex: layer.zIndex
  };
}

function fontWeightClass(weight: LayoutTextLayer["fontWeight"]): string {
  if (weight === "bold") {
    return "font-bold";
  }
  if (weight === "medium") {
    return "font-semibold";
  }
  return "font-normal";
}

function LayoutPreview({ layers, mediaById }: { layers: LayoutLayer[]; mediaById: Map<string, MediaItem> }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2 shadow-sm">
      <div
        className="relative aspect-video w-full overflow-hidden rounded-md"
        style={{ backgroundColor: canvas.backgroundColor }}
        aria-label="Layout preview"
      >
        {layers.map((layer) => {
          if (layer.kind === "shape") {
            return (
              <div
                key={layer.id}
                className="absolute"
                style={{
                  ...layerStyle(layer),
                  backgroundColor: layer.fillColor,
                  borderColor: layer.strokeColor,
                  borderStyle: layer.strokeColor ? "solid" : undefined,
                  borderWidth: layer.strokeWidth ? `${Math.max(1, layer.strokeWidth / 12)}px` : undefined
                }}
              />
            );
          }

          if (layer.kind === "media") {
            const media = mediaById.get(layer.mediaId);
            return (
              <div
                key={layer.id}
                className="absolute flex items-center justify-center overflow-hidden bg-[linear-gradient(145deg,#155e75,#0f766e_45%,#1e3a8a)] text-center text-white ring-1 ring-white/20"
                style={layerStyle(layer)}
              >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_20%,rgba(255,255,255,0.28),transparent_30%)]" aria-hidden="true" />
                <div className="relative min-w-0 px-3">
                  <p className="truncate text-sm font-semibold sm:text-base">{media?.title ?? layer.mediaId}</p>
                  <p className="mt-1 truncate text-xs text-cyan-50/80">{media?.playbackFileName ?? "Media reference"}</p>
                </div>
              </div>
            );
          }

          return (
            <div
              key={layer.id}
              className={`absolute flex min-w-0 items-center overflow-hidden px-3 leading-tight ${fontWeightClass(layer.fontWeight)} ${
                layer.align === "center" ? "justify-center text-center" : layer.align === "right" ? "justify-end text-right" : "justify-start text-left"
              }`}
              style={{
                ...layerStyle(layer),
                backgroundColor: layer.backgroundColor,
                color: layer.color,
                fontSize: `clamp(0.75rem, ${(layer.fontSize / 1920) * 100}vw, ${Math.max(1, layer.fontSize / 18)}rem)`
              }}
            >
              <span className="break-words">{layer.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LayoutsPanel() {
  const [layouts, setLayouts] = useState<LayoutTemplate[]>([]);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [selectedLayoutId, setSelectedLayoutId] = useState("");
  const [preset, setPreset] = useState<LayoutPreset>("fullscreen-overlay");
  const [selectedMediaId, setSelectedMediaId] = useState("");
  const [name, setName] = useState("Promo layout");
  const [headline, setHeadline] = useState("Call today");
  const [detail, setDetail] = useState("(555) 010-0199");
  const [durationSeconds, setDurationSeconds] = useState(30);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Loading layouts.");
  const [errorMessage, setErrorMessage] = useState("");

  const readyMedia = useMemo(
    () => mediaItems.filter((item) => item.status === "ready"),
    [mediaItems]
  );
  const mediaById = useMemo(
    () => new Map(mediaItems.map((item) => [item.id, item])),
    [mediaItems]
  );
  const selectedLayout = useMemo(
    () => layouts.find((layout) => layout.id === selectedLayoutId) ?? null,
    [layouts, selectedLayoutId]
  );
  const previewLayers = useMemo(
    () => (selectedMediaId ? layersForPreset(preset, selectedMediaId, headline, detail) : []),
    [detail, headline, preset, selectedMediaId]
  );
  const canSave = selectedMediaId && name.trim() && headline.trim() && detail.trim() && durationSeconds > 0;

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setIsLoading(true);
      setErrorMessage("");
      try {
        const [layoutsResponse, mediaResponse] = await Promise.all([
          fetch("/api/local-layouts", { cache: "no-store" }),
          fetch("/api/media?limit=200", { cache: "no-store" })
        ]);

        if (!layoutsResponse.ok) {
          throw new Error("Layout list could not be loaded.");
        }
        if (!mediaResponse.ok) {
          throw new Error("Media list could not be loaded.");
        }

        const layoutData = (await layoutsResponse.json()) as LayoutApiResponse;
        const mediaData = (await mediaResponse.json()) as MediaApiResponse;

        if (cancelled) {
          return;
        }

        const nextLayouts = layoutData.layouts ?? [];
        const nextMedia = mediaData.items ?? [];
        const nextReadyMedia = nextMedia.filter((item) => item.status === "ready");
        setLayouts(nextLayouts);
        setMediaItems(nextMedia);
        setSelectedMediaId((current) => current || nextReadyMedia[0]?.id || "");
        setStatusMessage(nextLayouts.length === 0 ? "No layouts saved." : `${nextLayouts.length} layout${nextLayouts.length === 1 ? "" : "s"} saved.`);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : "Layout data could not be loaded.");
          setStatusMessage("Layout data unavailable.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  function selectLayout(layout: LayoutTemplate) {
    setSelectedLayoutId(layout.id);
    setPreset(inferPreset(layout));
    setSelectedMediaId(firstMediaId(layout));
    setName(layout.name);
    setHeadline(firstText(layout, "Call today", 0));
    setDetail(firstText(layout, "(555) 010-0199", 1));
    setDurationSeconds(layout.durationSeconds);
    setStatusMessage(`${layout.name} loaded.`);
    setErrorMessage("");
  }

  function startNewLayout(nextPreset: LayoutPreset = preset) {
    setSelectedLayoutId("");
    setPreset(nextPreset);
    setName(`${presetLabels[nextPreset]} layout`);
    setHeadline("Call today");
    setDetail("(555) 010-0199");
    setDurationSeconds(30);
    setSelectedMediaId((current) => current || readyMedia[0]?.id || "");
    setStatusMessage("New local layout.");
    setErrorMessage("");
  }

  async function saveLayout() {
    if (!canSave) {
      setErrorMessage("Choose ready media and complete the layout fields.");
      return;
    }

    setIsSaving(true);
    setErrorMessage("");
    try {
      const payload = {
        canvas,
        durationSeconds,
        layers: previewLayers,
        name: name.trim()
      };
      const response = await fetch("/api/local-layouts", {
        body: JSON.stringify(selectedLayoutId ? { ...payload, layoutId: selectedLayoutId } : payload),
        headers: { "Content-Type": "application/json" },
        method: selectedLayoutId ? "PATCH" : "POST"
      });
      const data = (await response.json()) as SaveResponse;
      if (!response.ok || !data.layout) {
        throw new Error(data.error ?? "Layout could not be saved.");
      }

      setLayouts((current) => {
        const existingIndex = current.findIndex((layout) => layout.id === data.layout!.id);
        if (existingIndex === -1) {
          return [...current, data.layout!];
        }
        const next = [...current];
        next[existingIndex] = data.layout!;
        return next;
      });
      setSelectedLayoutId(data.layout.id);
      setStatusMessage(data.message ?? "Saved locally. Render before playlist use.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Layout could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteLayout() {
    if (!selectedLayout) {
      return;
    }

    setIsSaving(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/local-layouts", {
        body: JSON.stringify({ layoutId: selectedLayout.id }),
        headers: { "Content-Type": "application/json" },
        method: "DELETE"
      });
      const data = (await response.json()) as SaveResponse;
      if (!response.ok) {
        throw new Error(data.error ?? "Layout could not be deleted.");
      }

      setLayouts((current) => current.filter((layout) => layout.id !== selectedLayout.id));
      startNewLayout();
      setStatusMessage(data.message ?? "Deleted locally.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Layout could not be deleted.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <section aria-labelledby="saved-layouts-heading" className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="saved-layouts-heading" className="text-xl font-semibold">Saved layouts</h2>
              <p className="mt-1 text-sm text-zinc-600">{isLoading ? "Loading." : statusMessage}</p>
            </div>
            <button
              type="button"
              onClick={() => startNewLayout()}
              className="inline-flex min-h-10 shrink-0 items-center rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:cursor-not-allowed disabled:bg-zinc-300"
              disabled={isSaving}
            >
              New
            </button>
          </div>
        </div>
        <div className="divide-y divide-zinc-200">
          {layouts.length === 0 ? (
            <div className="p-4 text-sm text-zinc-600">No local layouts saved.</div>
          ) : (
            layouts.map((layout) => (
              <button
                key={layout.id}
                type="button"
                onClick={() => selectLayout(layout)}
                className={`block w-full p-4 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-teal-600 ${
                  layout.id === selectedLayoutId ? "bg-teal-50" : "hover:bg-zinc-50"
                }`}
              >
                <span className="block truncate font-semibold text-zinc-950">{layout.name}</span>
                <span className="mt-1 block text-sm text-zinc-600">
                  {layout.durationSeconds}s · {layout.render.status === "ready" ? "Rendered" : "Not rendered"}
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <section aria-labelledby="layout-editor-heading" className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase text-teal-700">Layouts</p>
              <h2 id="layout-editor-heading" className="mt-1 text-2xl font-semibold">Layout editor</h2>
              <p className="mt-1 text-sm text-zinc-600">Local template · 1920x1080 · {selectedLayout ? `v${selectedLayout.version}` : "draft"}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveLayout}
                disabled={!canSave || isSaving}
                className="inline-flex min-h-10 items-center justify-center rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:cursor-not-allowed disabled:bg-zinc-300"
              >
                {isSaving ? "Saving" : selectedLayout ? "Update" : "Save"}
              </button>
              <button
                type="button"
                onClick={deleteLayout}
                disabled={!selectedLayout || isSaving}
                className="inline-flex min-h-10 items-center justify-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-500 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:ring-zinc-200"
              >
                Delete
              </button>
            </div>
          </div>
          {errorMessage ? (
            <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800">{errorMessage}</p>
          ) : (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
              {selectedLayout?.render.status === "ready" ? "Rendered asset is ready." : "Saved layouts are not rendered or published yet."}
            </p>
          )}
        </div>

        <div className="grid gap-4 p-4 2xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <fieldset>
              <legend className="text-sm font-semibold text-zinc-950">Preset</legend>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {(Object.keys(presetLabels) as LayoutPreset[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setPreset(item);
                      if (!selectedLayoutId) {
                        setName(`${presetLabels[item]} layout`);
                      }
                    }}
                    className={`rounded-md border px-3 py-3 text-left focus:outline-none focus:ring-2 focus:ring-teal-600 ${
                      item === preset ? "border-teal-300 bg-teal-50 text-teal-950" : "border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50"
                    }`}
                  >
                    <span className="block text-sm font-semibold">{presetLabels[item]}</span>
                    <span className="mt-1 block text-xs text-zinc-600">{presetDescriptions[item]}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <LayoutPreview layers={previewLayers} mediaById={mediaById} />
          </div>

          <div className="space-y-4">
            <label className="block text-sm font-semibold text-zinc-950" htmlFor="layout-name">
              Name
              <input
                id="layout-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </label>

            <label className="block text-sm font-semibold text-zinc-950" htmlFor="layout-media">
              Media
              <select
                id="layout-media"
                value={selectedMediaId}
                onChange={(event) => setSelectedMediaId(event.target.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {readyMedia.length === 0 ? (
                  <option value="">No ready media</option>
                ) : (
                  readyMedia.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label className="block text-sm font-semibold text-zinc-950" htmlFor="layout-headline">
              Text
              <input
                id="layout-headline"
                value={headline}
                onChange={(event) => setHeadline(event.target.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </label>

            <label className="block text-sm font-semibold text-zinc-950" htmlFor="layout-detail">
              Detail
              <input
                id="layout-detail"
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </label>

            <label className="block text-sm font-semibold text-zinc-950" htmlFor="layout-duration">
              Duration seconds
              <input
                id="layout-duration"
                type="number"
                min="1"
                max="3600"
                value={durationSeconds}
                onChange={(event) => setDurationSeconds(Number.parseInt(event.target.value, 10) || 1)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </label>

            <dl className="grid grid-cols-2 gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
              <div>
                <dt className="font-semibold text-zinc-500">Layers</dt>
                <dd className="mt-1 font-semibold text-zinc-950">{previewLayers.length}</dd>
              </div>
              <div>
                <dt className="font-semibold text-zinc-500">Status</dt>
                <dd className="mt-1 font-semibold text-zinc-950">{selectedLayout?.render.status === "ready" ? "Ready" : "Draft"}</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>
    </div>
  );
}
