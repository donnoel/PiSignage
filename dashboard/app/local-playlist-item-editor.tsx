"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type PlaylistItemEditorProps = {
  assetId: string;
  defaultDurationSeconds: number;
  defaultTitle: string;
};

type PlaylistEditResponse = {
  error?: string;
  piPublish?: {
    enabled: boolean;
    message: string;
    ok: boolean;
  };
  playlistVersion?: number;
};

export function LocalPlaylistItemEditor({
  assetId,
  defaultDurationSeconds,
  defaultTitle
}: PlaylistItemEditorProps) {
  const router = useRouter();
  const [title, setTitle] = useState(defaultTitle);
  const [durationSeconds, setDurationSeconds] = useState(String(defaultDurationSeconds));
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isSaving || isPending;

  async function saveItemDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    const duration = Number.parseInt(durationSeconds, 10);
    if (!Number.isFinite(duration) || duration < 1 || duration > 3600) {
      setMessage("Duration must be between 1 and 3600 seconds.");
      return;
    }

    setIsSaving(true);
    setMessage("Saving item details...");
    try {
      const response = await fetch("/api/local-playlist/items", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "update-item",
          altText: title,
          assetId,
          durationSeconds: duration
        })
      });
      const result = (await response.json()) as PlaylistEditResponse;
      if (!response.ok) {
        throw new Error(result.error ?? "Could not save item details.");
      }

      const publishMessage = result.piPublish?.message ? ` ${result.piPublish.message}` : "";
      setMessage(`Saved in playlist v${result.playlistVersion}.${publishMessage}`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save item details.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={saveItemDetails} className="grid gap-2 rounded-md bg-zinc-50 p-3 ring-1 ring-zinc-200">
      <div className="grid gap-2 md:grid-cols-[1fr_160px_auto] md:items-end">
        <div>
          <label htmlFor={`item-title-${assetId}`} className="text-xs font-semibold uppercase text-zinc-500">
            Item title
          </label>
          <input
            id={`item-title-${assetId}`}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            className="mt-1 min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
            disabled={isBusy}
          />
        </div>
        <div>
          <label htmlFor={`item-duration-${assetId}`} className="text-xs font-semibold uppercase text-zinc-500">
            Duration (s)
          </label>
          <input
            id={`item-duration-${assetId}`}
            type="number"
            min="1"
            max="3600"
            value={durationSeconds}
            onChange={(event) => setDurationSeconds(event.currentTarget.value)}
            className="mt-1 min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
            disabled={isBusy}
          />
        </div>
        <button
          type="submit"
          disabled={isBusy}
          className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {isBusy ? "Saving..." : "Save"}
        </button>
      </div>
      {message ? <p className="text-xs text-zinc-600">{message}</p> : null}
    </form>
  );
}

