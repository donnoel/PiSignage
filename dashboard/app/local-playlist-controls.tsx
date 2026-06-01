"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type PlaylistAction = "move-up" | "move-down" | "remove";

type PlaylistControlsProps = {
  assetId: string;
  assetLabel: string;
  isFirst: boolean;
  isLast: boolean;
  isOnlyItem: boolean;
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

  if (piPublish.ok) {
    return "Saved locally and sent to the screen.";
  }

  return `Saved locally. ${piPublish.message}`;
}

export function LocalPlaylistControls({
  assetId,
  assetLabel,
  isFirst,
  isLast,
  isOnlyItem,
  playlistId
}: PlaylistControlsProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isSaving || isPending;

  async function editPlaylist(action: PlaylistAction) {
    if (isBusy) {
      return;
    }

    const actionText = {
      "move-up": "Moving up",
      "move-down": "Moving down",
      remove: "Removing"
    }[action];

    setMessage(`${actionText} ${assetLabel}...`);
    setIsSaving(true);

    try {
      const response = await fetch("/api/local-playlist/items", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action, assetId, playlistId })
      });
      const result = (await response.json()) as PlaylistEditResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Playlist edit failed.");
      }

      setMessage(result.message ?? savedMessage(result.piPublish));
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Playlist edit failed.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-md border border-zinc-200 bg-white p-1">
        <button
          type="button"
          disabled={isBusy || isFirst}
          onClick={() => editPlaylist("move-up")}
          className="flex h-9 w-9 items-center justify-center rounded text-sm font-semibold text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Move ${assetLabel} up`}
          title="Move up"
        >
          ↑
        </button>
        <button
          type="button"
          disabled={isBusy || isLast}
          onClick={() => editPlaylist("move-down")}
          className="flex h-9 w-9 items-center justify-center rounded text-sm font-semibold text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Move ${assetLabel} down`}
          title="Move down"
        >
          ↓
        </button>
      </div>
      <button
        type="button"
        disabled={isBusy || isOnlyItem}
        onClick={() => editPlaylist("remove")}
        className="min-h-11 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={`Remove ${assetLabel} from playlist`}
      >
        Remove
      </button>
      {message ? (
        <p className="basis-full text-xs font-medium text-zinc-600" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
