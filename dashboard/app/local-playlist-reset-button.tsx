"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type ResetPlaylistResponse = {
  deleted?: number;
  error?: string;
  nextPlaylistId?: string;
};

type LocalPlaylistResetButtonProps = {
  playlistCount: number;
};

export function LocalPlaylistResetButton({ playlistCount }: LocalPlaylistResetButtonProps) {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isSaving || isPending;

  async function resetLibrary() {
    if (isBusy) {
      return;
    }

    const confirmed = window.confirm(
      `Reset playlist library?\n\nThis removes ${playlistCount} saved playlist${playlistCount === 1 ? "" : "s"}, clears local screen assignments, and creates one empty playlist. This does not publish a change to the Pis.`
    );
    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/local-playlists", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resetLibrary: true })
      });
      const result = (await response.json()) as ResetPlaylistResponse;
      if (!response.ok || !result.nextPlaylistId) {
        throw new Error(result.error ?? "Could not reset playlists.");
      }

      startTransition(() => {
        router.push(`/?view=playlist&playlist=${encodeURIComponent(result.nextPlaylistId as string)}`);
        router.refresh();
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not reset playlists.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void resetLibrary()}
      disabled={isBusy}
      className="min-h-10 rounded-md border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
    >
      {isBusy ? "Resetting" : "Reset playlists"}
    </button>
  );
}
