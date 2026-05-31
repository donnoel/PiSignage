"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type CreatePlaylistResponse = {
  error?: string;
  playlist?: {
    playlistId: string;
    name: string;
  };
};

export function LocalPlaylistCreateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isSaving || isPending;

  async function createPlaylist(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    setIsSaving(true);
    setMessage("Creating playlist...");

    try {
      const response = await fetch("/api/local-playlists", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name })
      });
      const result = (await response.json()) as CreatePlaylistResponse;

      if (!response.ok || !result.playlist) {
        throw new Error(result.error ?? "Could not create playlist.");
      }

      const playlistId = result.playlist.playlistId;
      setName("");
      setMessage("Playlist created.");
      startTransition(() => {
        router.push(`/?view=playlist&playlist=${encodeURIComponent(playlistId)}`);
        router.refresh();
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create playlist.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={createPlaylist} className="grid gap-2 sm:grid-cols-[minmax(180px,1fr)_auto]">
      <label htmlFor="new-playlist-name" className="sr-only">Playlist name</label>
      <input
        id="new-playlist-name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder="New playlist name"
        className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
        disabled={isBusy}
      />
      <button
        type="submit"
        disabled={isBusy}
        className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
      >
        {isBusy ? "Creating..." : "Create"}
      </button>
      {message ? (
        <p className="text-xs font-medium text-zinc-600 sm:col-span-2" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </form>
  );
}
