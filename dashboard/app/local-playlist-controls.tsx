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
};

type PlaylistEditResponse = {
  error?: string;
  playlistVersion?: number;
  piPublish?: {
    enabled: boolean;
    ok: boolean;
    message: string;
  };
};

export function LocalPlaylistControls({
  assetId,
  assetLabel,
  isFirst,
  isLast,
  isOnlyItem
}: PlaylistControlsProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  async function editPlaylist(action: PlaylistAction) {
    const actionText = {
      "move-up": "Moving up",
      "move-down": "Moving down",
      remove: "Removing"
    }[action];

    setMessage(`${actionText} ${assetLabel}...`);

    try {
      const response = await fetch("/api/local-playlist/items", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action, assetId })
      });
      const result = (await response.json()) as PlaylistEditResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Playlist edit failed.");
      }

      const publishMessage = result.piPublish?.message ? ` ${result.piPublish.message}` : "";
      setMessage(`Playlist v${result.playlistVersion} saved.${publishMessage}`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Playlist edit failed.");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 md:justify-end">
      <button
        type="button"
        disabled={isPending || isFirst}
        onClick={() => editPlaylist("move-up")}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 text-sm font-semibold text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={`Move ${assetLabel} up`}
        title="Move up"
      >
        ↑
      </button>
      <button
        type="button"
        disabled={isPending || isLast}
        onClick={() => editPlaylist("move-down")}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 text-sm font-semibold text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={`Move ${assetLabel} down`}
        title="Move down"
      >
        ↓
      </button>
      <button
        type="button"
        disabled={isPending || isOnlyItem}
        onClick={() => editPlaylist("remove")}
        className="min-h-9 rounded-md border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
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
