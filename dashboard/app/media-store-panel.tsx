"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "./dashboard-ui";

type MediaItem = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  sourceFileName: string;
  playbackFileName: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  status: "ready" | "processing" | "failed";
  createdAt: string;
  updatedAt: string;
  missingFile?: boolean;
  origin?: "media-store" | "playlist";
  playlistAssetIds?: string[];
  playlistUseCount?: number;
};

type MediaListResponse = {
  items: MediaItem[];
  pagination: {
    cursor: number;
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
    total: number;
  };
};

type UploadResponse = {
  error?: string;
  item?: MediaItem;
};

type PlaylistActionResponse = {
  assetCount?: number;
  error?: string;
  piPublish?: {
    message: string;
    ok: boolean;
  };
  playlistVersion?: number;
};

type DeleteResponse = {
  deleted?: boolean;
  error?: string;
};

type StatusTone = "good" | "warn" | "muted";
type SafetyFilter = "all" | "ready" | "review";
type TypeFilter = "all" | "video" | "still" | "mov";

type PlaybackSafety = {
  canUseInPlaylist: boolean;
  detail: string;
  label: string;
  tone: StatusTone;
};

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

function formatBytes(value: number): string {
  if (value <= 0) {
    return "—";
  }

  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    style: "unit",
    unit: "megabyte"
  }).format(value / 1_000_000);
}

function formatDuration(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}s` : "—";
}

function formatTags(tags: string[]): string {
  return tags.length > 0 ? tags.join(", ") : "—";
}

function isMp4FileName(fileName: string): boolean {
  return /\.mp4$/i.test(fileName);
}

function isStillClipFileName(fileName: string): boolean {
  return /\.still-\d+s(?:-\d+)?\.mp4$/i.test(fileName);
}

function mediaKind(item: MediaItem): "Still" | "Video" | "MOV" | "File" {
  if (isStillClipFileName(item.playbackFileName)) {
    return "Still";
  }

  if (/\.mov$/i.test(item.playbackFileName)) {
    return "MOV";
  }

  return isMp4FileName(item.playbackFileName) ? "Video" : "File";
}

function playbackSafety(item: MediaItem): PlaybackSafety {
  if (item.missingFile) {
    return {
      canUseInPlaylist: false,
      detail: "The local asset file is missing.",
      label: "Missing",
      tone: "warn"
    };
  }

  if (item.status === "failed") {
    return {
      canUseInPlaylist: false,
      detail: "This media needs attention before playback.",
      label: "Failed",
      tone: "warn"
    };
  }

  if (item.status === "processing") {
    return {
      canUseInPlaylist: false,
      detail: "This media is still being prepared.",
      label: "Processing",
      tone: "muted"
    };
  }

  if (!isMp4FileName(item.playbackFileName)) {
    return {
      canUseInPlaylist: false,
      detail: "Convert this media to MP4 before adding it to the Pi playlist.",
      label: "Needs MP4",
      tone: "warn"
    };
  }

  return {
    canUseInPlaylist: true,
    detail: "Ready for the Pi playlist.",
    label: "Ready",
    tone: "good"
  };
}

function messageClass(tone: "idle" | "success" | "warning" | "error"): string {
  if (tone === "error") {
    return "text-rose-700";
  }
  if (tone === "success") {
    return "text-emerald-700";
  }
  if (tone === "warning") {
    return "text-amber-800";
  }
  return "text-zinc-600";
}

function isInPlaylist(item: MediaItem): boolean {
  return (item.playlistUseCount ?? 0) > 0;
}

function matchesSafetyFilter(item: MediaItem, filter: SafetyFilter): boolean {
  if (filter === "all") {
    return true;
  }

  const ready = playbackSafety(item).canUseInPlaylist;
  return filter === "ready" ? ready : !ready;
}

function matchesTypeFilter(item: MediaItem, filter: TypeFilter): boolean {
  if (filter === "all") {
    return true;
  }

  const kind = mediaKind(item);
  if (filter === "still") {
    return kind === "Still";
  }
  if (filter === "mov") {
    return kind === "MOV";
  }

  return kind === "Video";
}

function actionLabel(item: MediaItem, addingMediaId: string | null): string {
  if (addingMediaId === item.id) {
    return "Adding";
  }
  if (isInPlaylist(item)) {
    return "In playlist";
  }
  return playbackSafety(item).canUseInPlaylist ? "Add" : "Review";
}

function canDeleteMedia(item: MediaItem): boolean {
  return item.origin !== "playlist" && !isInPlaylist(item);
}

export function MediaStorePanel() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [safetyFilter, setSafetyFilter] = useState<SafetyFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [showUpload, setShowUpload] = useState(false);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [durationSeconds, setDurationSeconds] = useState("10");
  const [message, setMessage] = useState("Loading media...");
  const [messageTone, setMessageTone] = useState<"idle" | "success" | "warning" | "error">("idle");
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [addingMediaId, setAddingMediaId] = useState<string | null>(null);
  const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const visibleItems = useMemo(
    () => items.filter((item) => matchesSafetyFilter(item, safetyFilter) && matchesTypeFilter(item, typeFilter)),
    [items, safetyFilter, typeFilter]
  );
  const readyItemCount = useMemo(
    () => items.filter((item) => playbackSafety(item).canUseInPlaylist).length,
    [items]
  );
  const playlistItemCount = useMemo(
    () => items.filter(isInPlaylist).length,
    [items]
  );
  const reviewItemCount = items.length - readyItemCount;
  const isBusy = isPending || isLoading || isUploading || addingMediaId !== null || deletingMediaId !== null;

  async function loadMedia(reset: boolean, requestedQuery = query): Promise<void> {
    const cursor = reset ? "0" : nextCursor ?? "0";
    const params = new URLSearchParams({ limit: "200", cursor });

    if (requestedQuery) {
      params.set("q", requestedQuery);
    }

    setIsLoading(true);
    try {
      const response = await fetch(`/api/media?${params.toString()}`, {
        method: "GET",
        cache: "no-store"
      });
      const result = (await response.json()) as MediaListResponse & { error?: string };

      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not load media.");
      }

      const loadedCount = reset ? result.items.length : Math.min(cursorAsNumber(cursor) + result.items.length, result.pagination.total);
      setItems((current) => (reset ? result.items : [...current, ...result.items]));
      setTotalItems(result.pagination.total);
      setNextCursor(result.pagination.nextCursor);
      setHasMore(result.pagination.hasMore);
      setMessage(result.pagination.total === 0 ? "No media found." : `${loadedCount} loaded.`);
      setMessageTone("idle");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load media.");
      setMessageTone("error");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadMedia(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setMessage("Choose a file.");
      setMessageTone("error");
      return;
    }

    const formData = new FormData();
    formData.append("media", file);
    formData.append("title", uploadTitle);
    formData.append("tags", uploadTags);
    formData.append("durationSeconds", durationSeconds);
    setIsUploading(true);
    setMessage(`Uploading ${file.name}...`);
    setMessageTone("idle");

    try {
      const response = await fetch("/api/media", {
        method: "POST",
        body: formData,
        cache: "no-store"
      });
      const result = (await response.json()) as UploadResponse;
      if (!response.ok || result.error || !result.item) {
        throw new Error(result.error ?? "Upload failed.");
      }

      const safety = playbackSafety(result.item);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setUploadTitle("");
      setUploadTags("");
      setQuery("");
      setQueryInput("");
      await loadMedia(true, "");
      setMessage(`${result.item.playbackFileName} saved.`);
      setMessageTone(safety.canUseInPlaylist ? "success" : "warning");
      setShowUpload(false);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed.");
      setMessageTone("error");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleAddToPlaylist(item: MediaItem) {
    if (isBusy) {
      return;
    }

    const safety = playbackSafety(item);
    if (isInPlaylist(item)) {
      setMessage(`${item.title} is already in the playlist.`);
      setMessageTone("idle");
      return;
    }
    if (!safety.canUseInPlaylist) {
      setMessage(safety.detail);
      setMessageTone("warning");
      return;
    }
    if (item.origin === "playlist") {
      setMessage("This playlist asset is already available locally.");
      setMessageTone("idle");
      return;
    }

    setAddingMediaId(item.id);
    setMessage(`Adding ${item.title}...`);
    setMessageTone("idle");
    try {
      const response = await fetch("/api/local-playlist/items", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "add-media",
          mediaId: item.id
        })
      });
      const result = (await response.json()) as PlaylistActionResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not add media.");
      }

      const publishMessage = result.piPublish?.message ? ` ${result.piPublish.message}` : "";
      await loadMedia(true);
      setMessage(`Added to playlist.${publishMessage}`);
      setMessageTone(result.piPublish && !result.piPublish.ok ? "warning" : "success");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add media.");
      setMessageTone("error");
    } finally {
      setAddingMediaId(null);
    }
  }

  async function handleDelete(item: MediaItem) {
    if (isBusy) {
      return;
    }
    if (!canDeleteMedia(item)) {
      setMessage(isInPlaylist(item) ? "Remove this media from the playlist before deleting it." : "Playlist assets are managed from the Playlist view.");
      setMessageTone("warning");
      return;
    }

    const confirmed = window.confirm(`Delete "${item.title}" from Media Store?`);
    if (!confirmed) {
      return;
    }

    setDeletingMediaId(item.id);
    setMessage(`Deleting ${item.title}...`);
    setMessageTone("idle");
    try {
      const response = await fetch(`/api/media/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        cache: "no-store"
      });
      const result = (await response.json()) as DeleteResponse;
      if (!response.ok || result.error || !result.deleted) {
        throw new Error(result.error ?? "Could not delete media.");
      }

      await loadMedia(true);
      setMessage(`${item.title} deleted.`);
      setMessageTone("success");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not delete media.");
      setMessageTone("error");
    } finally {
      setDeletingMediaId(null);
    }
  }

  return (
    <section className="min-w-0 rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-200 p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-zinc-950">Library</h2>
            <p className="mt-1 text-sm text-zinc-600">
              {totalItems} assets · {readyItemCount} ready · {playlistItemCount} in playlist · {reviewItemCount} review
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={`${visibleItems.length} shown`} tone="muted" />
            <button
              type="button"
              onClick={() => setShowUpload((current) => !current)}
              className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white"
            >
              {showUpload ? "Close upload" : "Upload"}
            </button>
          </div>
        </div>

        <form
          className="mt-4 grid gap-2 md:grid-cols-[minmax(0,1fr)_160px_140px_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(queryInput.trim());
          }}
        >
          <label className="sr-only" htmlFor="media-search">Search media</label>
          <input
            id="media-search"
            name="query"
            value={queryInput}
            onChange={(event) => setQueryInput(event.currentTarget.value)}
            placeholder="Search media"
            className="min-h-10 min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
          />
          <label className="sr-only" htmlFor="media-safety-filter">Status</label>
          <select
            id="media-safety-filter"
            value={safetyFilter}
            onChange={(event) => setSafetyFilter(event.currentTarget.value as SafetyFilter)}
            className="min-h-10 min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
          >
            <option value="all">All status</option>
            <option value="ready">Ready</option>
            <option value="review">Review</option>
          </select>
          <label className="sr-only" htmlFor="media-type-filter">Type</label>
          <select
            id="media-type-filter"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.currentTarget.value as TypeFilter)}
            className="min-h-10 min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
          >
            <option value="all">All types</option>
            <option value="video">Video</option>
            <option value="still">Still</option>
            <option value="mov">MOV</option>
          </select>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isBusy}
              className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100"
            >
              {isLoading ? "Searching" : "Search"}
            </button>
            <button
              type="button"
              disabled={isBusy || (!query && !queryInput && safetyFilter === "all" && typeFilter === "all")}
              onClick={() => {
                setQueryInput("");
                setQuery("");
                setSafetyFilter("all");
                setTypeFilter("all");
              }}
              className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
            >
              Clear
            </button>
          </div>
        </form>
      </div>

      {showUpload ? (
        <form onSubmit={handleUpload} className="grid gap-3 border-b border-zinc-200 bg-zinc-50 p-4 lg:grid-cols-[minmax(240px,1fr)_minmax(160px,0.5fr)_minmax(140px,0.4fr)_minmax(180px,0.6fr)_auto] lg:items-end">
          <div>
            <label htmlFor="media-file" className="text-sm font-semibold text-zinc-950">File</label>
            <input
              ref={fileInputRef}
              id="media-file"
              name="media"
              type="file"
              accept="video/mp4,video/quicktime,image/jpeg,image/png,.mp4,.mov,.jpg,.jpeg,.png"
              disabled={isBusy}
              className="mt-1 block min-h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-950 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white"
            />
          </div>
          <div>
            <label htmlFor="media-title" className="text-sm font-semibold text-zinc-950">Title</label>
            <input
              id="media-title"
              name="title"
              value={uploadTitle}
              onChange={(event) => setUploadTitle(event.currentTarget.value)}
              disabled={isBusy}
              className="mt-1 min-h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
            />
          </div>
          <div>
            <label htmlFor="media-duration" className="text-sm font-semibold text-zinc-950">Still sec</label>
            <input
              id="media-duration"
              name="durationSeconds"
              type="number"
              min="1"
              max="300"
              value={durationSeconds}
              onChange={(event) => setDurationSeconds(event.currentTarget.value)}
              disabled={isBusy}
              className="mt-1 min-h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
            />
          </div>
          <div>
            <label htmlFor="media-tags" className="text-sm font-semibold text-zinc-950">Tags</label>
            <input
              id="media-tags"
              name="tags"
              value={uploadTags}
              onChange={(event) => setUploadTags(event.currentTarget.value)}
              disabled={isBusy}
              className="mt-1 min-h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
            />
          </div>
          <button
            type="submit"
            disabled={isBusy}
            className="min-h-10 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
          >
            {isUploading ? "Uploading" : "Save"}
          </button>
        </form>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3">Tags</th>
              <th className="px-4 py-3">Updated</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200">
            {visibleItems.map((item) => {
              const safety = playbackSafety(item);
              const inPlaylist = isInPlaylist(item);
              const canAdd = safety.canUseInPlaylist && !inPlaylist && item.origin !== "playlist";
              const deleting = deletingMediaId === item.id;
              return (
                <tr key={item.id} className="bg-white hover:bg-zinc-50">
                  <td className="max-w-[300px] px-4 py-3">
                    <p className="truncate font-semibold text-zinc-950" title={item.title}>{item.title}</p>
                    <p className="mt-1 truncate text-xs text-zinc-500" title={item.playbackFileName}>{item.playbackFileName}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span title={safety.detail}>
                      <StatusPill label={safety.label} tone={safety.tone} />
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-700">{mediaKind(item)}</td>
                  <td className="px-4 py-3 text-zinc-700">{formatDuration(item.durationSeconds)}</td>
                  <td className="px-4 py-3 text-zinc-700">{formatBytes(item.sizeBytes)}</td>
                  <td className="max-w-[160px] px-4 py-3 text-zinc-700">
                    <span className="block truncate" title={formatTags(item.tags)}>{formatTags(item.tags)}</span>
                  </td>
                  <td className="px-4 py-3 text-zinc-700">{formatTimestamp(item.updatedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleAddToPlaylist(item)}
                        disabled={isBusy || !canAdd}
                        className="min-h-9 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
                      >
                        {actionLabel(item, addingMediaId)}
                      </button>
                      {canDeleteMedia(item) ? (
                        <button
                          type="button"
                          onClick={() => void handleDelete(item)}
                          disabled={isBusy}
                          className="min-h-9 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-sm font-semibold text-rose-700 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
                        >
                          {deleting ? "Deleting" : "Delete"}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visibleItems.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-zinc-600" colSpan={8}>
                  {items.length === 0 ? message : "No media matches these filters."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 border-t border-zinc-200 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className={`text-sm ${messageClass(messageTone)}`} role="status" aria-live="polite">{message}</p>
        <button
          type="button"
          disabled={!hasMore || isLoading}
          onClick={() => {
            void loadMedia(false);
          }}
          className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
        >
          {isLoading ? "Loading" : hasMore ? "Load more" : "All loaded"}
        </button>
      </div>
    </section>
  );
}

function cursorAsNumber(cursor: string): number {
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
