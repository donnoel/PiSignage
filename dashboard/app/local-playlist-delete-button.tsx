"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type DeletePlaylistResponse = {
  error?: string;
  nextPlaylistId?: string;
  playlistId?: string;
};

type LocalPlaylistDeleteButtonProps = {
  assignedScreenCount: number;
  isOnlyPlaylist: boolean;
  name: string;
  playlistId: string;
};

export function LocalPlaylistDeleteButton({
  assignedScreenCount,
  isOnlyPlaylist,
  name,
  playlistId
}: LocalPlaylistDeleteButtonProps) {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isSaving || isPending || isOnlyPlaylist;

  async function deletePlaylist() {
    if (isBusy) {
      return;
    }

    const assignmentText =
      assignedScreenCount === 0
        ? "It is not assigned to any screens."
        : `It is assigned to ${assignedScreenCount} ${assignedScreenCount === 1 ? "screen" : "screens"}; those screens will be unassigned locally.`;

    if (!window.confirm(`Delete playlist "${name}"?\n\n${assignmentText}\n\nThis does not publish a change to the Pi.`)) {
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/local-playlists", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ playlistId })
      });
      const result = (await response.json()) as DeletePlaylistResponse;

      if (!response.ok || !result.nextPlaylistId) {
        throw new Error(result.error ?? "Could not delete playlist.");
      }

      startTransition(() => {
        router.push(`/?view=playlist&playlist=${encodeURIComponent(result.nextPlaylistId as string)}`);
        router.refresh();
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not delete playlist.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void deletePlaylist()}
      disabled={isBusy}
      title={isOnlyPlaylist ? "Keep at least one playlist" : "Delete playlist"}
      aria-label={isOnlyPlaylist ? `Cannot delete ${name}; keep at least one playlist` : `Delete ${name}`}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-red-200 bg-white text-base font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      X
    </button>
  );
}
