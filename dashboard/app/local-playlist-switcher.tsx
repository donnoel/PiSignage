"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

type PlaylistOption = {
  assetCount: number;
  durationLabel: string;
  name: string;
  playlistId: string;
};

type LocalPlaylistSwitcherProps = {
  currentPlaylistId: string;
  playlists: PlaylistOption[];
};

export function LocalPlaylistSwitcher({ currentPlaylistId, playlists }: LocalPlaylistSwitcherProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="grid gap-1 text-xs font-semibold uppercase text-zinc-500">
      Switch playlist
      <select
        value={currentPlaylistId}
        disabled={isPending}
        onChange={(event) => {
          const playlistId = event.currentTarget.value;
          startTransition(() => {
            router.push(`/?view=playlist&playlist=${encodeURIComponent(playlistId)}`);
            router.refresh();
          });
        }}
        className="min-h-11 min-w-[240px] rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold normal-case text-zinc-950 shadow-sm focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:cursor-not-allowed disabled:bg-zinc-100"
      >
        {playlists.map((playlist) => (
          <option key={playlist.playlistId} value={playlist.playlistId}>
            {playlist.name} - {playlist.assetCount} items - {playlist.durationLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
