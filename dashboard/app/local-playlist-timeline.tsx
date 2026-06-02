"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import type { PlaylistAsset } from "./lib/local-playlist";

type PlaylistTimelineProps = {
  assets: PlaylistAsset[];
  piAssetIds: string[];
  playlistId: string;
};

type PlaylistEditResponse = {
  error?: string;
  message?: string;
  playlistVersion?: number;
  piPublish?: {
    enabled: boolean;
    ok: boolean;
    message: string;
  };
};

function savedMessage(piPublish: PlaylistEditResponse["piPublish"]): string {
  if (!piPublish) {
    return "Saved locally.";
  }

  return piPublish.message;
}

function fileNameFromUri(uri: string): string {
  return uri.split("/").filter(Boolean).at(-1) ?? uri;
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "Duration unknown";
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function moveItem(items: PlaylistAsset[], fromIndex: number, toIndex: number): PlaylistAsset[] {
  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, item);
  return nextItems;
}

export function LocalPlaylistTimeline({ assets, piAssetIds, playlistId }: PlaylistTimelineProps) {
  const router = useRouter();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pointerDragRef = useRef<{ pointerId: number; sourceAssetId: string } | null>(null);
  const [items, setItems] = useState(assets);
  const [draggedAssetId, setDraggedAssetId] = useState<string | null>(null);
  const [dropAssetId, setDropAssetId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const piAssetSet = useMemo(() => new Set(piAssetIds), [piAssetIds]);
  const isBusy = isSaving || isPending;

  useEffect(() => {
    setItems(assets);
  }, [assets]);

  async function saveOrder(nextItems: PlaylistAsset[]) {
    const orderedAssetIds = nextItems.map((asset) => asset.assetId);

    setIsSaving(true);
    setMessage("Saving...");

    try {
      const response = await fetch("/api/local-playlist/items", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "reorder",
          orderedAssetIds,
          playlistId
        })
      });
      const result = (await response.json()) as PlaylistEditResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Could not save playlist order.");
      }

      setMessage(result.message ?? savedMessage(result.piPublish));
      startTransition(() => router.refresh());
    } catch (error) {
      setItems(assets);
      setMessage(error instanceof Error ? error.message : "Could not save playlist order.");
    } finally {
      setIsSaving(false);
    }
  }

  function reorderByIndex(fromIndex: number, toIndex: number) {
    if (isBusy || fromIndex === toIndex || fromIndex < 0 || toIndex < 0) {
      return;
    }

    const nextItems = moveItem(items, fromIndex, toIndex);
    setItems(nextItems);
    void saveOrder(nextItems);
  }

  function reorderByAssetId(sourceAssetId: string | null, targetAssetId: string) {
    const fromIndex = items.findIndex((item) => item.assetId === sourceAssetId);
    const toIndex = items.findIndex((item) => item.assetId === targetAssetId);
    reorderByIndex(fromIndex, toIndex);
  }

  function assetIdAtPointer(clientX: number, clientY: number): string | null {
    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof Element)) {
      return null;
    }

    return target.closest<HTMLElement>("[data-playlist-timeline-asset-id]")?.dataset.playlistTimelineAssetId ?? null;
  }

  function startPointerDrag(event: ReactPointerEvent<HTMLButtonElement>, sourceAssetId: string) {
    if (isBusy || event.pointerType === "mouse") {
      return;
    }

    event.preventDefault();
    pointerDragRef.current = { pointerId: event.pointerId, sourceAssetId };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggedAssetId(sourceAssetId);
    setDropAssetId(null);
  }

  function movePointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const pointerDrag = pointerDragRef.current;
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const targetAssetId = assetIdAtPointer(event.clientX, event.clientY);
    setDropAssetId(targetAssetId && targetAssetId !== pointerDrag.sourceAssetId ? targetAssetId : null);
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const pointerDrag = pointerDragRef.current;
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const targetAssetId = dropAssetId ?? assetIdAtPointer(event.clientX, event.clientY);
    pointerDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggedAssetId(null);
    setDropAssetId(null);

    if (targetAssetId) {
      reorderByAssetId(pointerDrag.sourceAssetId, targetAssetId);
    }
  }

  function cancelPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const pointerDrag = pointerDragRef.current;
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) {
      return;
    }

    pointerDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggedAssetId(null);
    setDropAssetId(null);
  }

  return (
    <div className="border-b border-zinc-200 bg-[radial-gradient(circle_at_18%_12%,rgba(45,212,191,0.38),transparent_30%),radial-gradient(circle_at_82%_8%,rgba(251,191,36,0.24),transparent_24%),linear-gradient(135deg,#0f2f2e_0%,#123d32_42%,#3b2433_100%)] px-5 py-5 text-white">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold">Preview</h3>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          {message ? (
            <p className="text-sm text-zinc-300" role="status" aria-live="polite">
              {message}
            </p>
          ) : null}
        </div>
      </div>
      <div
        ref={scrollerRef}
        className="max-w-full overflow-x-auto overscroll-x-contain pb-4"
        onWheel={(event) => {
          const scroller = scrollerRef.current;
          if (!scroller || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
            return;
          }

          event.preventDefault();
          scroller.scrollLeft += event.deltaY;
        }}
      >
        <ol className="flex min-h-[178px] gap-3">
          {items.map((asset, index) => {
            const assetName = asset.altText ?? asset.assetId;
            const thumbnailUrl = `/api/local-playlist/thumbnails/${encodeURIComponent(asset.assetId)}?playlistId=${encodeURIComponent(playlistId)}`;
            const isDragging = draggedAssetId === asset.assetId;
            const isDropTarget = dropAssetId === asset.assetId && draggedAssetId !== asset.assetId;

            return (
              <li
                key={asset.assetId}
                data-playlist-timeline-asset-id={asset.assetId}
                className={`group relative flex w-[172px] shrink-0 flex-col overflow-hidden rounded-lg border bg-white/10 shadow-[0_14px_34px_rgba(0,0,0,0.28)] backdrop-blur transition ${
                  isDropTarget ? "border-cyan-200 ring-2 ring-cyan-200" : "border-white/20"
                } ${isDragging ? "opacity-45" : "opacity-100"}`}
                draggable={!isBusy}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", asset.assetId);
                  setDraggedAssetId(asset.assetId);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropAssetId(asset.assetId);
                }}
                onDragLeave={() => {
                  setDropAssetId((current) => (current === asset.assetId ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceAssetId = event.dataTransfer.getData("text/plain") || draggedAssetId;
                  const fromIndex = items.findIndex((item) => item.assetId === sourceAssetId);
                  const toIndex = index;
                  setDraggedAssetId(null);
                  setDropAssetId(null);
                  reorderByIndex(fromIndex, toIndex);
                }}
                onDragEnd={() => {
                  setDraggedAssetId(null);
                  setDropAssetId(null);
                }}
              >
                <div className="relative aspect-video bg-black/25">
                  <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs font-semibold text-zinc-500">
                    Frame unavailable
                  </span>
                  <img
                    src={thumbnailUrl}
                    alt={`First frame for ${assetName}`}
                    className="relative h-full w-full object-cover"
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                  <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-xs font-semibold">
                    {index + 1}
                  </span>
                  {piAssetSet.has(asset.assetId) ? (
                    <span className="absolute right-2 top-2 rounded bg-emerald-300 px-2 py-1 text-xs font-semibold text-emerald-950">
                      On device
                    </span>
                  ) : null}
                </div>
                <div className="flex min-h-[82px] flex-col justify-between bg-black/20 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold" title={assetName}>{assetName}</p>
                    <p className="mt-1 truncate text-xs text-zinc-400" title={fileNameFromUri(asset.uri)}>
                      {fileNameFromUri(asset.uri)}
                    </p>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-zinc-300">{formatSeconds(asset.durationSeconds ?? 0)}</span>
                    <button
                      type="button"
                      disabled={isBusy}
                      onPointerDown={(event) => startPointerDrag(event, asset.assetId)}
                      onPointerMove={movePointerDrag}
                      onPointerUp={finishPointerDrag}
                      onPointerCancel={cancelPointerDrag}
                      className="touch-none rounded px-1 py-0.5 text-xs font-semibold text-zinc-400 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={`Drag ${assetName} to reorder`}
                      title="Drag to reorder"
                    >
                      Drag
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
