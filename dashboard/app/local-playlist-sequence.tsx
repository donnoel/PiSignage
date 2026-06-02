"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "./dashboard-ui";
import { LocalPlaylistItemEditor } from "./local-playlist-item-editor";
import type { PlaylistAsset } from "./lib/local-playlist";

type PlaylistSequenceProps = {
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

function assetTypeLabel(asset: PlaylistAsset): string {
  if (asset.type === "image") {
    return "Image needs conversion";
  }

  return /\.mp4$/i.test(asset.uri) ? "Ready MP4" : "Video";
}

function assetTypeTone(asset: PlaylistAsset): "good" | "warn" | "muted" {
  if (asset.type === "image") {
    return "warn";
  }

  return /\.mp4$/i.test(asset.uri) ? "good" : "muted";
}

function moveItem(items: PlaylistAsset[], fromIndex: number, toIndex: number): PlaylistAsset[] {
  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, item);
  return nextItems;
}

export function LocalPlaylistSequence({ assets, piAssetIds, playlistId }: PlaylistSequenceProps) {
  const router = useRouter();
  const pointerDragRef = useRef<{ pointerId: number; sourceAssetId: string } | null>(null);
  const [items, setItems] = useState(assets);
  const [draggedAssetId, setDraggedAssetId] = useState<string | null>(null);
  const [dropAssetId, setDropAssetId] = useState<string | null>(null);
  const [messageByAssetId, setMessageByAssetId] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const piAssetSet = useMemo(() => new Set(piAssetIds), [piAssetIds]);
  const isBusy = isSaving || isPending;

  useEffect(() => {
    setItems(assets);
  }, [assets]);

  async function saveOrder(nextItems: PlaylistAsset[], messageAssetId: string) {
    const orderedAssetIds = nextItems.map((asset) => asset.assetId);

    setIsSaving(true);
    setMessageByAssetId({ [messageAssetId]: "Saving order..." });

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

      setMessageByAssetId({ [messageAssetId]: result.message ?? savedMessage(result.piPublish) });
      startTransition(() => router.refresh());
    } catch (error) {
      setItems(assets);
      setMessageByAssetId({
        [messageAssetId]: error instanceof Error ? error.message : "Could not save playlist order."
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function removeItem(asset: PlaylistAsset) {
    if (isBusy || items.length <= 1) {
      return;
    }

    const assetLabel = asset.altText ?? asset.assetId;
    setIsSaving(true);
    setMessageByAssetId({ [asset.assetId]: `Removing ${assetLabel}...` });

    try {
      const response = await fetch("/api/local-playlist/items", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "remove",
          assetId: asset.assetId,
          playlistId
        })
      });
      const result = (await response.json()) as PlaylistEditResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Playlist edit failed.");
      }

      setMessageByAssetId({ [asset.assetId]: result.message ?? savedMessage(result.piPublish) });
      startTransition(() => router.refresh());
    } catch (error) {
      setMessageByAssetId({
        [asset.assetId]: error instanceof Error ? error.message : "Playlist edit failed."
      });
    } finally {
      setIsSaving(false);
    }
  }

  function reorderByAssetId(sourceAssetId: string | null, targetAssetId: string) {
    if (isBusy || !sourceAssetId || sourceAssetId === targetAssetId) {
      return;
    }

    const fromIndex = items.findIndex((item) => item.assetId === sourceAssetId);
    const toIndex = items.findIndex((item) => item.assetId === targetAssetId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
      return;
    }

    const nextItems = moveItem(items, fromIndex, toIndex);
    setItems(nextItems);
    void saveOrder(nextItems, sourceAssetId);
  }

  function assetIdAtPointer(clientX: number, clientY: number): string | null {
    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof Element)) {
      return null;
    }

    return target.closest<HTMLElement>("[data-playlist-asset-id]")?.dataset.playlistAssetId ?? null;
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
    <ul className="divide-y divide-zinc-200">
      {items.map((asset, index) => {
        const assetName = asset.altText ?? asset.assetId;
        const fileName = fileNameFromUri(asset.uri);
        const isDragging = draggedAssetId === asset.assetId;
        const isDropTarget = dropAssetId === asset.assetId && draggedAssetId !== asset.assetId;

        return (
          <li
            key={asset.assetId}
            data-playlist-asset-id={asset.assetId}
            className={`grid gap-3 px-5 py-4 text-sm lg:grid-cols-[44px_minmax(0,1fr)_auto] lg:items-start ${
              piAssetSet.has(asset.assetId) ? "bg-emerald-50/35" : ""
            } ${isDropTarget ? "ring-2 ring-inset ring-teal-300" : ""} ${isDragging ? "opacity-50" : "opacity-100"}`}
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
              setDraggedAssetId(null);
              setDropAssetId(null);
              reorderByAssetId(sourceAssetId, asset.assetId);
            }}
          >
            <button
              type="button"
              draggable={!isBusy}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", asset.assetId);
                setDraggedAssetId(asset.assetId);
              }}
              onDragEnd={() => {
                setDraggedAssetId(null);
                setDropAssetId(null);
              }}
              disabled={isBusy}
              onPointerDown={(event) => startPointerDrag(event, asset.assetId)}
              onPointerMove={movePointerDrag}
              onPointerUp={finishPointerDrag}
              onPointerCancel={cancelPointerDrag}
              className="flex h-10 w-10 touch-none cursor-grab items-center justify-center rounded-md bg-zinc-950 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={`Drag ${assetName} to reorder`}
              title="Drag to reorder"
            >
              {index + 1}
            </button>
            <div className="min-w-0">
              <LocalPlaylistItemEditor
                assetId={asset.assetId}
                defaultDurationSeconds={asset.durationSeconds ?? 30}
                defaultTitle={assetName}
                playlistId={playlistId}
              />
              <div className="mt-2 grid gap-2 text-xs text-zinc-600 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <span className="min-w-0 truncate" title={fileName}>{fileName}</span>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <StatusPill label={assetTypeLabel(asset)} tone={assetTypeTone(asset)} />
                  {piAssetSet.has(asset.assetId) ? <StatusPill label="On device" tone="good" /> : null}
                </div>
              </div>
              {messageByAssetId[asset.assetId] ? (
                <p className="mt-2 text-xs font-medium text-zinc-600" role="status" aria-live="polite">
                  {messageByAssetId[asset.assetId]}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                disabled={isBusy || items.length <= 1}
                onClick={() => void removeItem(asset)}
                className="min-h-10 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={`Remove ${assetName} from playlist`}
              >
                Remove
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
