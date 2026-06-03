"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
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

type PlaylistScreenAssignmentProps = {
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
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<"title-asc" | "title-desc">("title-asc");
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isLoadingMedia || isSaving || isPending;
  const shouldShowHeaderMessage = mediaItems.length > 0;
  const availableTags = useMemo(
    () => Array.from(new Set(mediaItems.flatMap((item) => item.tags))).sort((left, right) => left.localeCompare(right)),
    [mediaItems]
  );
  const visibleMediaItems = useMemo(
    () =>
      mediaItems
        .filter((item) => tagFilter === "all" || item.tags.includes(tagFilter))
        .sort((left, right) => {
          const comparison = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
          return sortOrder === "title-asc" ? comparison : -comparison;
        }),
    [mediaItems, sortOrder, tagFilter]
  );
  const selectedVisibleCount = visibleMediaItems.filter((item) => selectedMediaIds.includes(item.id)).length;
  const selectedMediaItems = mediaItems.filter((item) => selectedMediaIds.includes(item.id));

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
      setSelectedMediaIds((current) => current.filter((id) => readyItems.some((item) => item.id === id)));
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

  useEffect(() => {
    void loadMedia("");
  }, [playlistAssetKey, playlistId]);

  function toggleMediaSelection(mediaId: string, selected: boolean) {
    setSelectedMediaIds((current) => {
      if (selected) {
        return current.includes(mediaId) ? current : [...current, mediaId];
      }

      return current.filter((id) => id !== mediaId);
    });
  }

  function toggleVisibleSelection(selected: boolean) {
    setSelectedMediaIds((current) => {
      const visibleIds = visibleMediaItems.map((item) => item.id);
      if (selected) {
        return Array.from(new Set([...current, ...visibleIds]));
      }

      return current.filter((id) => !visibleIds.includes(id));
    });
  }

  async function addMediaItemsToPlaylist(itemsToAdd: MediaItem[]) {
    if (isBusy) {
      return;
    }

    if (itemsToAdd.length === 0) {
      setMediaMessage("Select at least one media item.");
      return;
    }

    setIsSaving(true);
    setMediaMessage(itemsToAdd.length === 1 ? `Adding ${itemsToAdd[0].title}...` : `Adding ${itemsToAdd.length} media items...`);
    try {
      let lastResult: PlaylistActionResponse | null = null;
      for (const item of itemsToAdd) {
        const response = await fetch("/api/local-playlist/items", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            action: "add-media",
            mediaId: item.id,
            playlistId
          })
        });
        const result = (await response.json()) as PlaylistActionResponse;
        if (!response.ok) {
          throw new Error(result.error ?? `Could not add ${item.title} to playlist.`);
        }
        lastResult = result;
      }

      const addedIds = new Set(itemsToAdd.map((item) => item.id));
      setMediaItems((current) => current.filter((item) => !addedIds.has(item.id)));
      setSelectedMediaIds((current) => current.filter((id) => !addedIds.has(id)));
      setMediaMessage(itemsToAdd.length === 1 ? lastResult?.message ?? savedMessage(lastResult?.piPublish) : `Added ${itemsToAdd.length} media items.`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMediaMessage(error instanceof Error ? error.message : "Could not add media to playlist.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <details className="border-b border-zinc-200 bg-zinc-50">
      <summary className="flex cursor-pointer list-none flex-col gap-3 px-5 py-4 marker:hidden sm:flex-row sm:items-center sm:justify-between [&::-webkit-details-marker]:hidden">
        <div>
          <h3 className="text-lg font-semibold">Add media</h3>
          <p className="mt-1 text-sm text-zinc-600" aria-live="polite">
            {shouldShowHeaderMessage ? mediaMessage : "Open the media library only when you need to add something."}
          </p>
        </div>
        <span className="inline-flex min-h-10 items-center justify-center rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white">
          Open media chooser
        </span>
      </summary>

      <section aria-label="Add media to playlist" className="border-t border-zinc-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h4 className="text-base font-semibold">Media library</h4>
            <p className="mt-1 text-sm text-zinc-600">Search ready MP4 media, filter the list, then add one or many items.</p>
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
        <div className="grid gap-3 border-b border-zinc-200 bg-zinc-50 px-5 py-3 md:grid-cols-[minmax(0,1fr)_180px_160px] md:items-center">
          <label className="flex items-center gap-2 text-sm font-semibold text-zinc-800">
            <input
              type="checkbox"
              checked={visibleMediaItems.length > 0 && selectedVisibleCount === visibleMediaItems.length}
              disabled={isBusy || visibleMediaItems.length === 0}
              onChange={(event) => toggleVisibleSelection(event.currentTarget.checked)}
              className="h-4 w-4 accent-teal-700"
            />
            Select visible
            <span className="font-normal text-zinc-500">({visibleMediaItems.length})</span>
          </label>
          <label className="grid gap-1 text-xs font-semibold text-zinc-600">
            Tag
            <select
              value={tagFilter}
              onChange={(event) => setTagFilter(event.currentTarget.value)}
              className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-950"
            >
              <option value="all">All tags</option>
              {availableTags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold text-zinc-600">
            Sort
            <select
              value={sortOrder}
              onChange={(event) => setSortOrder(event.currentTarget.value as "title-asc" | "title-desc")}
              className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-950"
            >
              <option value="title-asc">Name A-Z</option>
              <option value="title-desc">Name Z-A</option>
            </select>
          </label>
        </div>
        <div className="max-h-[460px] divide-y divide-zinc-200 overflow-y-auto">
          {visibleMediaItems.map((item) => {
            const selected = selectedMediaIds.includes(item.id);
            return (
              <div key={item.id} className={`grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${selected ? "bg-teal-50" : ""}`}>
                <label className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={isBusy}
                    onChange={(event) => toggleMediaSelection(item.id, event.currentTarget.checked)}
                    className="mt-1 h-4 w-4 shrink-0 accent-teal-700"
                  />
                  <span className="min-w-0">
                    <span className="block break-words font-semibold text-zinc-950">{item.title}</span>
                    <span className="mt-1 flex min-w-0 items-center gap-1 text-sm text-zinc-600" title={`${item.durationSeconds ?? 30}s · ${item.playbackFileName}`}>
                      <span className="shrink-0">{item.durationSeconds ?? 30}s</span>
                      <span aria-hidden="true" className="shrink-0">·</span>
                      <span className="min-w-0 truncate">{item.playbackFileName}</span>
                    </span>
                    {item.tags.length > 0 ? (
                      <span className="mt-1 block text-xs font-medium text-zinc-500">{item.tags.join(", ")}</span>
                    ) : null}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => void addMediaItemsToPlaylist([item])}
                  disabled={isBusy}
                  className="min-h-10 shrink-0 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
                >
                  Add
                </button>
              </div>
            );
          })}
          {visibleMediaItems.length === 0 ? (
            <p className="px-5 py-4 text-sm text-zinc-600" aria-live="polite">{isLoadingMedia ? "Loading media..." : mediaMessage}</p>
          ) : null}
        </div>
        <div className="sticky bottom-0 flex flex-col gap-3 border-t border-zinc-200 bg-white/95 px-5 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium text-zinc-600" role="status" aria-live="polite">
            {selectedMediaIds.length === 0 ? mediaMessage : `${selectedMediaIds.length} selected`}
          </p>
          <button
            type="button"
            onClick={() => void addMediaItemsToPlaylist(selectedMediaItems)}
            disabled={isBusy || selectedMediaIds.length === 0}
            className="min-h-10 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
          >
            {isSaving ? "Adding..." : `Add ${selectedMediaIds.length || ""} selected`}
          </button>
        </div>
      </section>
    </details>
  );
}

export function LocalPlaylistScreenAssignment({ playlistId }: PlaylistScreenAssignmentProps) {
  const router = useRouter();
  const [assignments, setAssignments] = useState<AssignmentResponse | null>(null);
  const [assignmentMessage, setAssignmentMessage] = useState("Loading screens...");
  const [isLoadingAssignments, setIsLoadingAssignments] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isLoadingAssignments || isSaving || isPending;

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
    void loadAssignments();
  }, [playlistId]);

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
    <details
      id="playlist-screen-assignment"
      tabIndex={-1}
      className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 outline-none transition-shadow"
    >
      <summary className="flex cursor-pointer list-none flex-col gap-2 p-4 marker:hidden sm:flex-row sm:items-center sm:justify-between [&::-webkit-details-marker]:hidden">
        <div>
          <h3 className="text-lg font-semibold">Screens using this playlist</h3>
          <p className="mt-1 text-sm text-zinc-600">
            {isLoadingAssignments
              ? "Loading screens..."
              : `${(assignments?.screens ?? []).filter((screen) => screen.playlistId === playlistId).length} selected`}
          </p>
        </div>
        <span className="inline-flex min-h-10 items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900">
          Manage screens
        </span>
      </summary>

      <div className="grid gap-3 border-t border-zinc-200 p-4">
        {(assignments?.screens ?? []).map((screen) => {
          const assigned = screen.playlistId === playlistId;
          return (
            <label
              key={screen.id}
              className={`flex items-start gap-3 rounded-md border p-3 ${
                assigned ? "border-teal-200 bg-teal-50" : "border-zinc-200 bg-white"
              }`}
            >
              <input
                type="checkbox"
                checked={assigned}
                disabled={isBusy}
                onChange={(event) => {
                  void saveScreenAssignment(screen.id, event.currentTarget.checked);
                }}
                className="mt-1 h-4 w-4 accent-teal-700"
              />
              <span className="min-w-0">
                <span className="block break-words font-semibold text-zinc-950">{screen.name}</span>
                <span className="block text-sm text-zinc-600">{screen.location}</span>
              </span>
            </label>
          );
        })}
        {(assignments?.screens ?? []).length === 0 ? (
          <p className="rounded-md border border-zinc-200 bg-white p-3 text-sm text-zinc-600">
            {isLoadingAssignments ? "Loading screen assignments..." : "No screen recorded."}
          </p>
        ) : null}
      </div>

      {assignmentMessage ? (
        <p className="border-t border-zinc-200 px-4 py-3 text-sm text-zinc-600" role="status" aria-live="polite">{assignmentMessage}</p>
      ) : null}
    </details>
  );
}
