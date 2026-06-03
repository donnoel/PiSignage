"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

type PlaylistItemEditorProps = {
  assetId: string;
  defaultDurationSeconds: number;
  defaultTitle: string;
  playlistId: string;
};

type PlaylistEditResponse = {
  error?: string;
  message?: string;
  piPublish?: {
    enabled: boolean;
    message: string;
    ok: boolean;
  };
  playlistVersion?: number;
};

function savedMessage(piPublish: PlaylistEditResponse["piPublish"]): string {
  if (!piPublish) {
    return "Saved locally.";
  }

  return piPublish.message;
}

export function LocalPlaylistItemEditor({
  assetId,
  defaultDurationSeconds,
  defaultTitle,
  playlistId
}: PlaylistItemEditorProps) {
  const router = useRouter();
  const [title, setTitle] = useState(defaultTitle);
  const [durationSeconds, setDurationSeconds] = useState(String(defaultDurationSeconds));
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isSaving || isPending;
  const hasChanges = title !== defaultTitle || durationSeconds !== String(defaultDurationSeconds);

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
    setMessage("Saving...");
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
          durationSeconds: duration,
          playlistId
        })
      });
      const result = (await response.json()) as PlaylistEditResponse;
      if (!response.ok) {
        throw new Error(result.error ?? "Could not save item details.");
      }

      setMessage(result.message ?? savedMessage(result.piPublish));
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save item details.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={saveItemDetails} className="grid gap-2">
      <div className="grid gap-2 md:grid-cols-[minmax(180px,1fr)_100px_auto] md:items-center">
        <div>
          <label htmlFor={`item-title-${assetId}`} className="sr-only">
            Name
          </label>
          <input
            id={`item-title-${assetId}`}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            className="min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
            disabled={isBusy}
          />
        </div>
        <div>
          <label htmlFor={`item-duration-${assetId}`} className="sr-only">
            Seconds
          </label>
          <input
            id={`item-duration-${assetId}`}
            type="number"
            min="1"
            max="3600"
            value={durationSeconds}
            onChange={(event) => setDurationSeconds(event.currentTarget.value)}
            className="min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
            disabled={isBusy}
            aria-label="Seconds"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isBusy || !hasChanges}
            className={`inline-flex h-10 w-10 items-center justify-center rounded-md bg-teal-700 text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 ${
              hasChanges ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            aria-label={isBusy ? "Saving item details" : "Save item details"}
            aria-hidden={!hasChanges}
            tabIndex={hasChanges ? 0 : -1}
            title={isBusy ? "Saving..." : hasChanges ? "Save" : "Saved"}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {message ? <p className="text-xs text-zinc-600" role="status" aria-live="polite">{message}</p> : null}
    </form>
  );
}
