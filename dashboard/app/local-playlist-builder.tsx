"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type MediaItem = {
  id: string;
  title: string;
  playbackFileName: string;
  durationSeconds: number | null;
  origin?: "media-store" | "playlist";
  playlistUseCount?: number;
  status: "ready" | "processing" | "failed";
  tags: string[];
};

type ScreenRecord = {
  id: string;
  name: string;
  location: string;
  playlistId: string | null;
};

type DeviceRecord = {
  host: string;
  id: string;
  name: string;
  playlistId?: string | null;
  screenId: string | null;
};

type MediaListResponse = {
  error?: string;
  items: MediaItem[];
  pagination: {
    hasMore: boolean;
  };
};

type AssignmentResponse = {
  devices: DeviceRecord[];
  error?: string;
  playlistId: string;
  screens: ScreenRecord[];
};

type PlaylistActionResponse = {
  error?: string;
  message?: string;
  piPublish?: {
    message: string;
    ok: boolean;
  };
  playlistVersion?: number;
};

type PlaylistBuilderProps = {
  playlistAssetFileNames: string[];
  playlistId: string;
};

function isPlaylistSafeMedia(item: MediaItem, selectedFileNames: Set<string>): boolean {
  return item.status === "ready" && !selectedFileNames.has(item.playbackFileName) && /\.mp4$/i.test(item.playbackFileName);
}

function savedMessage(piPublish: PlaylistActionResponse["piPublish"]): string {
  if (!piPublish) {
    return "Added to playlist.";
  }

  if (piPublish.ok) {
    return "Added to playlist and sent to the assigned Pi.";
  }

  return `Added to playlist. ${piPublish.message}`;
}

export function LocalPlaylistBuilder({ playlistAssetFileNames, playlistId }: PlaylistBuilderProps) {
  const router = useRouter();
  const selectedFileNames = new Set(playlistAssetFileNames);
  const playlistAssetKey = playlistAssetFileNames.join("\n");
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaQuery, setMediaQuery] = useState("");
  const [mediaMessage, setMediaMessage] = useState("Loading media library...");
  const [assignments, setAssignments] = useState<AssignmentResponse | null>(null);
  const [assignmentMessage, setAssignmentMessage] = useState("Loading assignments...");
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [isLoadingAssignments, setIsLoadingAssignments] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isLoadingMedia || isLoadingAssignments || isSaving || isPending;

  async function loadMedia(query = "") {
    setIsLoadingMedia(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (query.trim()) {
        params.set("q", query.trim());
      }

      const response = await fetch(`/api/media?${params.toString()}`, {
        cache: "no-store",
        method: "GET"
      });
      const result = (await response.json()) as MediaListResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not load media.");
      }

      const readyItems = result.items.filter((item) => isPlaylistSafeMedia(item, selectedFileNames));
      setMediaItems(readyItems);
      setMediaMessage(
        readyItems.length === 0
          ? "No available media for this playlist."
          : `${readyItems.length} ready item${readyItems.length === 1 ? "" : "s"} available.`
      );
    } catch (error) {
      setMediaMessage(error instanceof Error ? error.message : "Could not load media.");
      setMediaItems([]);
    } finally {
      setIsLoadingMedia(false);
    }
  }

  async function loadAssignments() {
    setIsLoadingAssignments(true);
    try {
      const params = new URLSearchParams({ playlistId });
      const response = await fetch(`/api/local-playlist/assign?${params.toString()}`, {
        cache: "no-store",
        method: "GET"
      });
      const result = (await response.json()) as AssignmentResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not load playlist assignments.");
      }

      setAssignments(result);
      setAssignmentMessage("Assignments loaded.");
    } catch (error) {
      setAssignments(null);
      setAssignmentMessage(error instanceof Error ? error.message : "Could not load playlist assignments.");
    } finally {
      setIsLoadingAssignments(false);
    }
  }

  useEffect(() => {
    void loadMedia("");
    void loadAssignments();
  }, [playlistAssetKey, playlistId]);

  async function addMediaToPlaylist(mediaId: string, mediaLabel: string) {
    if (isBusy) {
      return;
    }

    setIsSaving(true);
    setMediaMessage(`Adding ${mediaLabel}...`);
    try {
      const response = await fetch("/api/local-playlist/items", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "add-media",
          mediaId,
          playlistId
        })
      });
      const result = (await response.json()) as PlaylistActionResponse;
      if (!response.ok) {
        throw new Error(result.error ?? "Could not add media to playlist.");
      }

      setMediaMessage(result.message ?? savedMessage(result.piPublish));
      startTransition(() => router.refresh());
    } catch (error) {
      setMediaMessage(error instanceof Error ? error.message : "Could not add media to playlist.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveAssignment(targetType: "screen" | "device", targetId: string, assigned: boolean) {
    if (isBusy) {
      return;
    }

    setIsSaving(true);
    setAssignmentMessage(`Saving ${targetType} assignment...`);
    try {
      const response = await fetch("/api/local-playlist/assign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          assigned,
          playlistId,
          targetId,
          targetType
        })
      });
      const result = (await response.json()) as AssignmentResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not save playlist assignment.");
      }

      setAssignments(result);
      setAssignmentMessage("Assignment saved.");
      startTransition(() => router.refresh());
    } catch (error) {
      setAssignmentMessage(error instanceof Error ? error.message : "Could not save playlist assignment.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-5">
          <h3 className="text-lg font-semibold">Add media</h3>
          <p className="mt-1 text-sm text-zinc-600">Choose ready local media for this playlist.</p>
          <form
            className="mt-3 flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void loadMedia(mediaQuery);
            }}
          >
            <input
              value={mediaQuery}
              onChange={(event) => setMediaQuery(event.currentTarget.value)}
              placeholder="Search media by title, file, or tag"
              className="min-h-11 min-w-72 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
            />
            <button
              type="submit"
              disabled={isBusy}
              className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100"
            >
              {isLoadingMedia ? "Searching..." : "Search"}
            </button>
          </form>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3">Media</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Tags</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {mediaItems.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-zinc-950">{item.title}</p>
                    <p className="mt-1 text-xs text-zinc-600">{item.playbackFileName}</p>
                  </td>
                  <td className="px-4 py-3 text-zinc-700">{item.durationSeconds ?? 30}s</td>
                  <td className="px-4 py-3 text-zinc-700">
                    {item.tags.length > 0 ? item.tags.join(", ") : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => void addMediaToPlaylist(item.id, item.title)}
                      disabled={isBusy}
                      className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
                    >
                      Add
                    </button>
                  </td>
                </tr>
              ))}
              {mediaItems.length === 0 ? (
                <tr>
                  <td className="px-4 py-4 text-zinc-600" colSpan={4}>{mediaMessage}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="border-t border-zinc-200 px-4 py-3 text-sm text-zinc-600">{mediaMessage}</p>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">Plays on</h3>
        </div>
        <p className="mt-1 text-sm text-zinc-600">Screens are the client-facing targets. Devices are the local playback hardware behind them.</p>

        <div className="mt-4 space-y-3">
          <h4 className="text-sm font-semibold uppercase text-zinc-500">Screens</h4>
          {(assignments?.screens ?? []).map((screen) => {
            const assigned = screen.playlistId === playlistId;
            return (
              <label key={screen.id} className="flex items-start gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                <input
                  type="checkbox"
                  checked={assigned}
                  disabled={isBusy}
                  onChange={(event) => {
                    void saveAssignment("screen", screen.id, event.currentTarget.checked);
                  }}
                  className="mt-1 h-4 w-4 accent-teal-700"
                />
                <span>
                  <span className="block font-semibold text-zinc-950">{screen.name}</span>
                  <span className="block text-sm text-zinc-600">{screen.location}</span>
                </span>
              </label>
            );
          })}
          {(assignments?.screens ?? []).length === 0 ? (
            <p className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">No screens recorded.</p>
          ) : null}
        </div>

        <div className="mt-5 space-y-3">
          <h4 className="text-sm font-semibold uppercase text-zinc-500">Devices</h4>
          {(assignments?.devices ?? []).map((device) => {
            const assigned = (device.playlistId ?? null) === playlistId;
            return (
              <label key={device.id} className="flex items-start gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                <input
                  type="checkbox"
                  checked={assigned}
                  disabled={isBusy}
                  onChange={(event) => {
                    void saveAssignment("device", device.id, event.currentTarget.checked);
                  }}
                  className="mt-1 h-4 w-4 accent-teal-700"
                />
                <span>
                  <span className="block font-semibold text-zinc-950">{device.name}</span>
                  <span className="block text-sm text-zinc-600">{device.host}</span>
                </span>
              </label>
            );
          })}
          {(assignments?.devices ?? []).length === 0 ? (
            <p className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">No devices recorded.</p>
          ) : null}
        </div>

        <p className="mt-4 text-sm text-zinc-600">{assignmentMessage}</p>
      </section>
    </div>
  );
}
