"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type RenamePlaylistResponse = {
  error?: string;
  playlist?: {
    name: string;
    playlistId: string;
  };
};

type LocalPlaylistRenameButtonProps = {
  name: string;
  playlistId: string;
};

export function LocalPlaylistRenameButton({ name, playlistId }: LocalPlaylistRenameButtonProps) {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isSaving || isPending;

  async function renamePlaylist() {
    if (isBusy) {
      return;
    }

    const nextName = window.prompt("Rename playlist", name)?.trim();
    if (!nextName || nextName === name) {
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/local-playlists", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: nextName,
          playlistId
        })
      });
      const result = (await response.json()) as RenamePlaylistResponse;

      if (!response.ok || !result.playlist) {
        throw new Error(result.error ?? "Could not rename playlist.");
      }

      startTransition(() => {
        router.refresh();
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not rename playlist.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void renamePlaylist()}
      disabled={isBusy}
      title="Rename playlist"
      aria-label={`Rename ${name}`}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 bg-white text-base font-semibold text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      ✎
    </button>
  );
}
