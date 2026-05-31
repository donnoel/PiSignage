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

type UpdateResponse = {
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

type StatusTone = "good" | "warn" | "muted";
type SafetyFilter = "all" | "safe" | "review";

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

  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatBytes(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    style: "unit",
    unit: "megabyte"
  }).format(value / 1_000_000);
}

function formatDuration(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}s` : "Unknown";
}

function formatTags(tags: string[]): string {
  return tags.length > 0 ? tags.join(", ") : "No tags";
}

function isMp4FileName(fileName: string): boolean {
  return /\.mp4$/i.test(fileName);
}

function isStillClipFileName(fileName: string): boolean {
  return /\.still-\d+s(?:-\d+)?\.mp4$/i.test(fileName);
}

function mediaKind(item: MediaItem): "Still clip" | "MP4 video" | "MOV source" | "Media file" {
  if (isStillClipFileName(item.playbackFileName)) {
    return "Still clip";
  }

  if (/\.mp4$/i.test(item.playbackFileName)) {
    return "MP4 video";
  }

  if (/\.mov$/i.test(item.playbackFileName)) {
    return "MOV source";
  }

  return "Media file";
}

function playbackSafety(item: MediaItem): PlaybackSafety {
  if (item.status === "failed") {
    return {
      canUseInPlaylist: false,
      detail: "The local media record is marked failed. Re-upload or replace it before using it in a playlist.",
      label: "Failed",
      tone: "warn"
    };
  }

  if (item.status === "processing") {
    return {
      canUseInPlaylist: false,
      detail: "Beam is still preparing this media. Wait for it to become ready before adding it to a playlist.",
      label: "Processing",
      tone: "muted"
    };
  }

  if (!isMp4FileName(item.playbackFileName)) {
    return {
      canUseInPlaylist: false,
      detail: "Stored locally for review. Convert this asset to MP4 before sending it to the Pi playlist.",
      label: "Needs MP4",
      tone: "warn"
    };
  }

  if (isStillClipFileName(item.playbackFileName)) {
    return {
      canUseInPlaylist: true,
      detail: "Converted still image clip stored as a local MP4 for VLC playback.",
      label: "Pi-safe still",
      tone: "good"
    };
  }

  return {
    canUseInPlaylist: true,
    detail: "Local MP4 playback file is ready to append to the playlist.",
    label: "Pi-safe MP4",
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

function matchesSafetyFilter(item: MediaItem, filter: SafetyFilter): boolean {
  if (filter === "all") {
    return true;
  }

  const safety = playbackSafety(item);
  return filter === "safe" ? safety.canUseInPlaylist : !safety.canUseInPlaylist;
}

export function MediaStorePanel() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [totalItems, setTotalItems] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [safetyFilter, setSafetyFilter] = useState<SafetyFilter>("all");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [durationSeconds, setDurationSeconds] = useState("10");
  const [uploadMessage, setUploadMessage] = useState("Uploads stay local. Playlist-ready files are MP4 videos or converted still clips.");
  const [uploadTone, setUploadTone] = useState<"idle" | "success" | "warning" | "error">("idle");
  const [listMessage, setListMessage] = useState("Loading media library...");
  const [playlistMessage, setPlaylistMessage] = useState("Playlist-ready media can be appended from this page.");
  const [playlistTone, setPlaylistTone] = useState<"idle" | "success" | "warning" | "error">("idle");
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [addingMediaId, setAddingMediaId] = useState<string | null>(null);
  const [detailsTitle, setDetailsTitle] = useState("");
  const [detailsDescription, setDetailsDescription] = useState("");
  const [detailsTags, setDetailsTags] = useState("");
  const [detailsMessage, setDetailsMessage] = useState("Choose an item to review and edit metadata.");
  const [isPending, startTransition] = useTransition();
  const visibleItems = useMemo(
    () => items.filter((item) => matchesSafetyFilter(item, safetyFilter)),
    [items, safetyFilter]
  );
  const selectedItem = useMemo(
    () => items.find((candidate) => candidate.id === selectedId) ?? null,
    [items, selectedId]
  );
  const safeItemCount = useMemo(
    () => items.filter((item) => playbackSafety(item).canUseInPlaylist).length,
    [items]
  );
  const reviewItemCount = items.length - safeItemCount;
  const isBusy = isPending || isLoading || isUploading || isSaving || addingMediaId !== null;

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
        throw new Error(result.error ?? "Could not load media library.");
      }

      setItems((current) => (reset ? result.items : [...current, ...result.items]));
      setTotalItems(result.pagination.total);
      setNextCursor(result.pagination.nextCursor);
      setHasMore(result.pagination.hasMore);
      setListMessage(
        result.pagination.total === 0
          ? "No local media matches this search."
          : `Showing ${reset ? result.items.length : Math.min(cursorAsNumber(cursor) + result.items.length, result.pagination.total)} of ${result.pagination.total} stored asset${result.pagination.total === 1 ? "" : "s"}.`
      );
      if (reset && result.items.length === 0) {
        setSelectedId(null);
      }
      if (reset && result.items.length > 0) {
        setSelectedId((current) =>
          current && result.items.some((item) => item.id === current) ? current : result.items[0].id
        );
      }
    } catch (error) {
      setListMessage(error instanceof Error ? error.message : "Could not load media library.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadMedia(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (selectedId && visibleItems.some((item) => item.id === selectedId)) {
      return;
    }

    setSelectedId(visibleItems[0]?.id ?? null);
  }, [selectedId, visibleItems]);

  useEffect(() => {
    if (!selectedItem) {
      setDetailsTitle("");
      setDetailsDescription("");
      setDetailsTags("");
      setDetailsMessage("Choose an item to review and edit metadata.");
      return;
    }

    setDetailsTitle(selectedItem.title);
    setDetailsDescription(selectedItem.description);
    setDetailsTags(selectedItem.tags.join(", "));
    setDetailsMessage(`Inspecting ${selectedItem.playbackFileName}.`);
  }, [selectedItem]);

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setUploadTone("error");
      setUploadMessage("Choose an MP4, MOV, JPEG, or PNG file.");
      return;
    }

    const formData = new FormData();
    formData.append("media", file);
    formData.append("title", uploadTitle);
    formData.append("tags", uploadTags);
    formData.append("durationSeconds", durationSeconds);
    setIsUploading(true);
    setUploadTone("idle");
    setUploadMessage(`Uploading ${file.name}...`);

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
      setUploadTone(safety.canUseInPlaylist ? "success" : "warning");
      setUploadMessage(`${result.item.playbackFileName} saved locally. ${safety.detail}`);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setUploadTitle("");
      setUploadTags("");
      setQuery("");
      setQueryInput("");
      setSafetyFilter("all");
      await loadMedia(true, "");
      setSelectedId(result.item.id);
      startTransition(() => router.refresh());
    } catch (error) {
      setUploadTone("error");
      setUploadMessage(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleSaveDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedItem || isBusy) {
      return;
    }

    setIsSaving(true);
    setDetailsMessage("Saving media metadata...");
    try {
      const response = await fetch(`/api/media/${selectedItem.id}`, {
        method: "PATCH",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: detailsTitle,
          description: detailsDescription,
          tags: detailsTags
        })
      });
      const result = (await response.json()) as UpdateResponse;
      if (!response.ok || result.error || !result.item) {
        throw new Error(result.error ?? "Could not save media details.");
      }

      setItems((current) =>
        current.map((item) => (item.id === result.item?.id ? result.item : item))
      );
      setDetailsMessage(`Saved updates for ${result.item.playbackFileName}.`);
      startTransition(() => router.refresh());
    } catch (error) {
      setDetailsMessage(error instanceof Error ? error.message : "Could not save media details.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAddToPlaylist(item: MediaItem) {
    if (isBusy) {
      return;
    }

    const safety = playbackSafety(item);
    if (!safety.canUseInPlaylist) {
      setPlaylistTone("warning");
      setPlaylistMessage(`${item.playbackFileName} is not playlist-ready. ${safety.detail}`);
      setSelectedId(item.id);
      return;
    }

    setAddingMediaId(item.id);
    setPlaylistTone("idle");
    setPlaylistMessage(`Adding ${item.title} to the local playlist...`);
    setSelectedId(item.id);
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
        throw new Error(result.error ?? "Could not add media to playlist.");
      }

      const publishMessage = result.piPublish?.message ? ` ${result.piPublish.message}` : "";
      const versionLabel = typeof result.playlistVersion === "number" ? ` v${result.playlistVersion}` : "";
      setPlaylistTone(result.piPublish && !result.piPublish.ok ? "warning" : "success");
      setPlaylistMessage(`Added ${item.title} to playlist${versionLabel}.${publishMessage}`);
      startTransition(() => router.refresh());
    } catch (error) {
      setPlaylistTone("error");
      setPlaylistMessage(error instanceof Error ? error.message : "Could not add media to playlist.");
    } finally {
      setAddingMediaId(null);
    }
  }

  const selectedSafety = selectedItem ? playbackSafety(selectedItem) : null;

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,390px)]">
      <div className="min-w-0 space-y-4">
        <section className="min-w-0 rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase text-zinc-500">Local catalog</p>
              <h2 className="mt-1 text-xl font-semibold">Upload media</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-600">
                MP4 is playlist-ready. JPEG and PNG uploads become Pi-safe MP4 still clips. MOV is stored for review until converted.
              </p>
            </div>
            <div className="self-start">
              <StatusPill label="Local only" tone="muted" />
            </div>
          </div>
          <form onSubmit={handleUpload} className="grid min-w-0 gap-4 p-5">
            <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(180px,0.45fr)]">
              <div className="lg:col-span-2">
                <label htmlFor="media-file" className="text-sm font-semibold text-zinc-950">Media file</label>
                <input
                  ref={fileInputRef}
                  id="media-file"
                  name="media"
                  type="file"
                  accept="video/mp4,video/quicktime,image/jpeg,image/png,.mp4,.mov,.jpg,.jpeg,.png"
                  disabled={isBusy}
                  className="mt-2 block min-h-11 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
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
                  className="mt-2 min-h-11 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                  placeholder="Optional display name"
                />
              </div>
              <div>
                <label htmlFor="media-duration" className="text-sm font-semibold text-zinc-950">Still seconds</label>
                <input
                  id="media-duration"
                  name="durationSeconds"
                  type="number"
                  min="1"
                  max="300"
                  value={durationSeconds}
                  onChange={(event) => setDurationSeconds(event.currentTarget.value)}
                  disabled={isBusy}
                  className="mt-2 min-h-11 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                />
              </div>
              <div className="lg:col-span-2">
                <label htmlFor="media-tags" className="text-sm font-semibold text-zinc-950">Tags</label>
                <input
                  id="media-tags"
                  name="tags"
                  value={uploadTags}
                  onChange={(event) => setUploadTags(event.currentTarget.value)}
                  disabled={isBusy}
                  className="mt-2 min-h-11 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                  placeholder="lobby, menu, campaign"
                />
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="submit"
                disabled={isBusy}
                className="min-h-11 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                {isUploading ? "Uploading..." : "Upload media"}
              </button>
              <p className={`text-sm ${messageClass(uploadTone)}`} role="status" aria-live="polite">
                {uploadMessage}
              </p>
            </div>
          </form>
        </section>

        <section className="min-w-0 rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h3 className="text-lg font-semibold">Stored media</h3>
                <p className="mt-1 text-sm text-zinc-600">
                  {totalItems} matching asset{totalItems === 1 ? "" : "s"}. {safeItemCount} playlist-ready, {reviewItemCount} needing review in the loaded set.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill label={`${safeItemCount} ready`} tone={safeItemCount > 0 ? "good" : "muted"} />
                <StatusPill label={`${reviewItemCount} review`} tone={reviewItemCount > 0 ? "warn" : "muted"} />
              </div>
            </div>
            <form
              className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_190px_auto_auto]"
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
                placeholder="Search title, notes, file, or tag"
                className="min-h-11 min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <label className="sr-only" htmlFor="media-safety-filter">Playback safety filter</label>
              <select
                id="media-safety-filter"
                value={safetyFilter}
                onChange={(event) => setSafetyFilter(event.currentTarget.value as SafetyFilter)}
                className="min-h-11 min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              >
                <option value="all">All media</option>
                <option value="safe">Playlist-ready</option>
                <option value="review">Needs review</option>
              </select>
              <button
                type="submit"
                disabled={isBusy}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100"
              >
                {isLoading ? "Searching..." : "Search"}
              </button>
              <button
                type="button"
                disabled={isBusy || (!query && !queryInput && safetyFilter === "all")}
                onClick={() => {
                  setQueryInput("");
                  setQuery("");
                  setSafetyFilter("all");
                }}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
              >
                Clear
              </button>
            </form>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-4 py-3">Media</th>
                  <th className="px-4 py-3">Playback safety</th>
                  <th className="px-4 py-3">Duration</th>
                  <th className="px-4 py-3">Tags</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="px-4 py-3">Use</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {visibleItems.map((item) => {
                  const safety = playbackSafety(item);
                  const selected = item.id === selectedId;
                  const adding = addingMediaId === item.id;
                  return (
                    <tr
                      key={item.id}
                      className={selected ? "bg-teal-50/60" : "bg-white hover:bg-zinc-50"}
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setSelectedId(item.id)}
                          className="min-w-0 text-left"
                          aria-current={selected ? "true" : undefined}
                        >
                          <span className="block break-words font-semibold text-zinc-950">{item.title}</span>
                          <span className="mt-1 block break-words text-xs text-zinc-600">{item.playbackFileName}</span>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusPill label={safety.label} tone={safety.tone} />
                            <StatusPill label={mediaKind(item)} tone={safety.canUseInPlaylist ? "good" : "muted"} />
                          </div>
                          <p className="max-w-xs text-xs leading-5 text-zinc-600">{safety.detail}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-zinc-700">{formatDuration(item.durationSeconds)}</td>
                      <td className="px-4 py-3 text-zinc-700">{formatTags(item.tags)}</td>
                      <td className="px-4 py-3 text-zinc-700">{formatTimestamp(item.updatedAt)}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void handleAddToPlaylist(item)}
                          disabled={isBusy || !safety.canUseInPlaylist}
                          className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
                        >
                          {adding ? "Adding..." : safety.canUseInPlaylist ? "Add" : "Review"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {visibleItems.length === 0 ? (
                  <tr>
                    <td className="px-4 py-5 text-zinc-600" colSpan={6}>
                      {items.length === 0 ? listMessage : "No media matches this playback-safety filter."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-3 border-t border-zinc-200 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm text-zinc-600">{listMessage}</p>
              <p className={`text-sm ${messageClass(playlistTone)}`} role="status" aria-live="polite">{playlistMessage}</p>
            </div>
            <button
              type="button"
              disabled={!hasMore || isLoading}
              onClick={() => {
                void loadMedia(false);
              }}
              className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
            >
              {isLoading ? "Loading..." : hasMore ? "Load more" : "All loaded"}
            </button>
          </div>
        </section>
      </div>

      <section className="min-w-0 self-start rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-500">Inspect</p>
            <h3 className="mt-1 text-lg font-semibold">Media details</h3>
          </div>
          {selectedSafety ? <StatusPill label={selectedSafety.label} tone={selectedSafety.tone} /> : null}
        </div>
        {selectedItem && selectedSafety ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <p className="break-words text-base font-semibold text-zinc-950">{selectedItem.title}</p>
              <p className="mt-1 break-words text-sm text-zinc-600">{selectedItem.playbackFileName}</p>
              <p className="mt-3 text-sm leading-6 text-zinc-700">{selectedSafety.detail}</p>
              <button
                type="button"
                onClick={() => void handleAddToPlaylist(selectedItem)}
                disabled={isBusy || !selectedSafety.canUseInPlaylist}
                className="mt-4 min-h-11 w-full rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
              >
                {addingMediaId === selectedItem.id ? "Adding to playlist..." : selectedSafety.canUseInPlaylist ? "Add to playlist" : "Needs MP4 before playlist"}
              </button>
            </div>

            <form onSubmit={handleSaveDetails} className="grid min-w-0 gap-3">
              <div>
                <label htmlFor="details-title" className="text-sm font-semibold text-zinc-950">Title</label>
                <input
                  id="details-title"
                  value={detailsTitle}
                  onChange={(event) => setDetailsTitle(event.currentTarget.value)}
                  disabled={isBusy}
                  className="mt-2 min-h-11 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                />
              </div>
              <div>
                <label htmlFor="details-tags" className="text-sm font-semibold text-zinc-950">Tags</label>
                <input
                  id="details-tags"
                  value={detailsTags}
                  onChange={(event) => setDetailsTags(event.currentTarget.value)}
                  disabled={isBusy}
                  className="mt-2 min-h-11 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                />
              </div>
              <div>
                <label htmlFor="details-description" className="text-sm font-semibold text-zinc-950">Notes</label>
                <textarea
                  id="details-description"
                  rows={5}
                  value={detailsDescription}
                  onChange={(event) => setDetailsDescription(event.currentTarget.value)}
                  disabled={isBusy}
                  className="mt-2 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                />
              </div>
              <button
                type="submit"
                disabled={isBusy}
                className="min-h-11 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                {isSaving ? "Saving..." : "Save metadata"}
              </button>
              <p className="text-sm text-zinc-600" role="status" aria-live="polite">{detailsMessage}</p>
            </form>

            <dl className="grid min-w-0 gap-2 border-t border-zinc-200 pt-4 text-sm text-zinc-700">
              <div className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2">
                <dt className="font-semibold text-zinc-500">Playback</dt>
                <dd className="min-w-0 break-words">sample-content/assets/{selectedItem.playbackFileName}</dd>
              </div>
              <div className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2">
                <dt className="font-semibold text-zinc-500">Source</dt>
                <dd className="min-w-0 break-words">{selectedItem.sourceFileName}</dd>
              </div>
              <div className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2">
                <dt className="font-semibold text-zinc-500">Type</dt>
                <dd className="min-w-0 break-words">{mediaKind(selectedItem)}</dd>
              </div>
              <div className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2">
                <dt className="font-semibold text-zinc-500">Duration</dt>
                <dd className="min-w-0 break-words">{formatDuration(selectedItem.durationSeconds)}</dd>
              </div>
              <div className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2">
                <dt className="font-semibold text-zinc-500">Size</dt>
                <dd className="min-w-0 break-words">{formatBytes(selectedItem.sizeBytes)}</dd>
              </div>
              <div className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2">
                <dt className="font-semibold text-zinc-500">MIME</dt>
                <dd className="min-w-0 break-words">{selectedItem.mimeType}</dd>
              </div>
              <div className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2">
                <dt className="font-semibold text-zinc-500">Created</dt>
                <dd className="min-w-0 break-words">{formatTimestamp(selectedItem.createdAt)}</dd>
              </div>
              <div className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] gap-2">
                <dt className="font-semibold text-zinc-500">Updated</dt>
                <dd className="min-w-0 break-words">{formatTimestamp(selectedItem.updatedAt)}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-600">No media selected.</p>
        )}
      </section>
    </div>
  );
}

function cursorAsNumber(cursor: string): number {
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
