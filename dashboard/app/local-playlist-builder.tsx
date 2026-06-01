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

type MediaListResponse = {
  error?: string;
  items: MediaItem[];
  pagination: {
    hasMore: boolean;
  };
};

type AssignmentResponse = {
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

  return piPublish.message;
}

export function LocalPlaylistBuilder({ playlistAssetFileNames, playlistId }: PlaylistBuilderProps) {
  const router = useRouter();
  const selectedFileNames = new Set(playlistAssetFileNames);
  const playlistAssetKey = playlistAssetFileNames.join("\n");
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaQuery, setMediaQuery] = useState("");
  const [mediaMessage, setMediaMessage] = useState("Loading media...");
  const [assignments, setAssignments] = useState<AssignmentResponse | null>(null);
  const [assignmentMessage, setAssignmentMessage] = useState("");
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
          ? "Everything available is already in this playlist."
          : `${readyItems.length} available`
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
      setAssignmentMessage("");
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

  async function saveScreenAssignment(targetId: string, assigned: boolean) {
    if (isBusy) {
      return;
    }

    setIsSaving(true);
    setAssignmentMessage("Saving screen...");
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
          targetType: "screen"
        })
      });
      const result = (await response.json()) as AssignmentResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not save playlist assignment.");
      }

      setAssignments(result);
      setAssignmentMessage("Saved.");
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
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Add media</h3>
            <p className="mt-1 text-sm text-zinc-600">Pick from ready local media.</p>
          </div>
          <form
            className="flex w-full flex-col gap-2 sm:flex-row sm:items-center lg:w-auto lg:justify-end"
            onSubmit={(event) => {
              event.preventDefault();
              void loadMedia(mediaQuery);
            }}
          >
            <input
              value={mediaQuery}
              onChange={(event) => setMediaQuery(event.currentTarget.value)}
              placeholder="Search media"
              className="min-h-10 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 sm:min-w-48 lg:w-64"
            />
            <button
              type="submit"
              disabled={isBusy}
              className="min-h-10 shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100"
            >
              {isLoadingMedia ? "Searching..." : "Search"}
            </button>
          </form>
        </div>
        <div className="divide-y divide-zinc-200">
          {mediaItems.map((item) => (
            <div key={item.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <p className="break-words font-semibold text-zinc-950">{item.title}</p>
                <p className="mt-1 flex min-w-0 items-center gap-1 text-sm text-zinc-600" title={`${item.durationSeconds ?? 30}s · ${item.playbackFileName}`}>
                  <span className="shrink-0">{item.durationSeconds ?? 30}s</span>
                  <span aria-hidden="true" className="shrink-0">·</span>
                  <span className="min-w-0 truncate">{item.playbackFileName}</span>
                </p>
                {item.tags.length > 0 ? (
                  <p className="mt-1 text-xs font-medium text-zinc-500">{item.tags.join(", ")}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void addMediaToPlaylist(item.id, item.title)}
                disabled={isBusy}
                className="min-h-10 shrink-0 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                Add
              </button>
            </div>
          ))}
          {mediaItems.length === 0 ? (
            <p className="px-5 py-4 text-sm text-zinc-600">{isLoadingMedia ? "Loading media..." : mediaMessage}</p>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">Screen</h3>
        </div>

        <div className="mt-4 space-y-3">
          {(assignments?.screens ?? []).map((screen) => {
            const assigned = screen.playlistId === playlistId;
            return (
              <label key={screen.id} className="flex items-start gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                <input
                  type="checkbox"
                  checked={assigned}
                  disabled={isBusy}
                  onChange={(event) => {
                    void saveScreenAssignment(screen.id, event.currentTarget.checked);
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
            <p className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">No screen recorded.</p>
          ) : null}
        </div>

        {assignmentMessage ? (
          <p className="mt-4 text-sm text-zinc-600" role="status" aria-live="polite">{assignmentMessage}</p>
        ) : null}
      </section>
    </div>
  );
}
