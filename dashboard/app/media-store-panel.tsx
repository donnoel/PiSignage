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

function mediaKind(item: MediaItem): "Still clip" | "Video" {
  return /\.still-\d+s(?:-\d+)?\.mp4$/i.test(item.playbackFileName) ? "Still clip" : "Video";
}

function statusTone(status: MediaItem["status"]): "good" | "warn" | "muted" {
  if (status === "ready") {
    return "good";
  }

  return status === "failed" ? "warn" : "muted";
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
  const [tagInput, setTagInput] = useState("");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [durationSeconds, setDurationSeconds] = useState("10");
  const [uploadMessage, setUploadMessage] = useState("Upload media into the shared local catalog.");
  const [uploadTone, setUploadTone] = useState<"idle" | "success" | "warning" | "error">("idle");
  const [listMessage, setListMessage] = useState("Loading media library...");
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [detailsTitle, setDetailsTitle] = useState("");
  const [detailsDescription, setDetailsDescription] = useState("");
  const [detailsTags, setDetailsTags] = useState("");
  const [detailsMessage, setDetailsMessage] = useState("Choose an item to review and edit metadata.");
  const [isPending, startTransition] = useTransition();
  const selectedItem = useMemo(
    () => items.find((candidate) => candidate.id === selectedId) ?? null,
    [items, selectedId]
  );
  const isBusy = isPending || isLoading || isUploading || isSaving;

  async function loadMedia(reset: boolean): Promise<void> {
    const cursor = reset ? "0" : nextCursor ?? "0";
    const params = new URLSearchParams({ limit: "50", cursor });

    if (query) {
      params.set("q", query);
    }
    if (tag) {
      params.set("tag", tag);
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

      setItems((current) => {
        const merged = reset ? result.items : [...current, ...result.items];
        return merged;
      });
      setTotalItems(result.pagination.total);
      setNextCursor(result.pagination.nextCursor);
      setHasMore(result.pagination.hasMore);
      setListMessage(result.pagination.total === 0 ? "No media found for this filter." : "Media library loaded.");
      if ((reset || !selectedId) && result.items.length > 0) {
        setSelectedId(result.items[0].id);
      }
      if (reset && result.items.length === 0) {
        setSelectedId(null);
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
  }, [query, tag]);

  useEffect(() => {
    if (!selectedItem) {
      setDetailsTitle("");
      setDetailsDescription("");
      setDetailsTags("");
      return;
    }

    setDetailsTitle(selectedItem.title);
    setDetailsDescription(selectedItem.description);
    setDetailsTags(selectedItem.tags.join(", "));
    setDetailsMessage(`Viewing ${selectedItem.playbackFileName}.`);
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
    formData.append("description", uploadDescription);
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

      setUploadTone("success");
      setUploadMessage(`Saved ${result.item.playbackFileName} to media store.`);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setUploadTitle("");
      setUploadDescription("");
      setUploadTags("");
      setSelectedId(result.item.id);
      await loadMedia(true);
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

  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="space-y-4">
        <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 p-5">
            <h2 className="text-xl font-semibold">Upload media</h2>
            <p className="mt-1 text-sm text-zinc-600">Add reusable media assets with descriptive metadata and tags.</p>
          </div>
          <form onSubmit={handleUpload} className="grid gap-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="media-file" className="text-sm font-semibold text-zinc-950">Media file</label>
                <input
                  ref={fileInputRef}
                  id="media-file"
                  name="media"
                  type="file"
                  accept="video/mp4,video/quicktime,image/jpeg,image/png,.mp4,.mov,.jpg,.jpeg,.png"
                  disabled={isBusy}
                  className="mt-2 block min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
                />
                <p className="mt-2 text-xs text-zinc-600">
                  MP4 and MOV upload directly. JPEG and PNG convert into Pi-safe MP4 still clips. MP3 remains disabled pending audio signage design.
                </p>
              </div>
              <div>
                <label htmlFor="media-title" className="text-sm font-semibold text-zinc-950">Title</label>
                <input
                  id="media-title"
                  name="title"
                  value={uploadTitle}
                  onChange={(event) => setUploadTitle(event.currentTarget.value)}
                  disabled={isBusy}
                  className="mt-2 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                  placeholder="Optional custom title"
                />
              </div>
              <div>
                <label htmlFor="media-duration" className="text-sm font-semibold text-zinc-950">Still duration (seconds)</label>
                <input
                  id="media-duration"
                  name="durationSeconds"
                  type="number"
                  min="1"
                  max="300"
                  value={durationSeconds}
                  onChange={(event) => setDurationSeconds(event.currentTarget.value)}
                  disabled={isBusy}
                  className="mt-2 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="media-tags" className="text-sm font-semibold text-zinc-950">Tags</label>
                <input
                  id="media-tags"
                  name="tags"
                  value={uploadTags}
                  onChange={(event) => setUploadTags(event.currentTarget.value)}
                  disabled={isBusy}
                  className="mt-2 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                  placeholder="menu, lobby, spring"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="media-description" className="text-sm font-semibold text-zinc-950">Description</label>
                <textarea
                  id="media-description"
                  name="description"
                  rows={3}
                  value={uploadDescription}
                  onChange={(event) => setUploadDescription(event.currentTarget.value)}
                  disabled={isBusy}
                  className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                  placeholder="Verbose notes about where this media should run and why."
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={isBusy}
                className="min-h-11 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                {isUploading ? "Uploading..." : "Upload to Media Store"}
              </button>
              <p
                className={`text-sm ${
                  uploadTone === "error"
                    ? "text-rose-700"
                    : uploadTone === "success"
                      ? "text-emerald-700"
                      : uploadTone === "warning"
                        ? "text-amber-800"
                        : "text-zinc-600"
                }`}
                role="status"
                aria-live="polite"
              >
                {uploadMessage}
              </p>
            </div>
          </form>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h3 className="text-lg font-semibold">Library</h3>
                <p className="mt-1 text-sm text-zinc-600">{totalItems} total matching assets.</p>
              </div>
              <StatusPill label={hasMore ? "Paged" : "Complete"} tone={hasMore ? "warn" : "good"} />
            </div>
            <form
              className="mt-4 grid gap-3 md:grid-cols-[1fr_220px_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                setQuery(queryInput.trim());
                setTag(tagInput.trim());
              }}
            >
              <input
                name="query"
                value={queryInput}
                onChange={(event) => setQueryInput(event.currentTarget.value)}
                placeholder="Search title, description, file, or tag"
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <input
                name="tag"
                value={tagInput}
                onChange={(event) => setTagInput(event.currentTarget.value)}
                placeholder="Tag filter"
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <button
                type="submit"
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900"
              >
                Apply
              </button>
            </form>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Duration</th>
                  <th className="px-4 py-3">Size</th>
                  <th className="px-4 py-3">Tags</th>
                  <th className="px-4 py-3">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {items.map((item) => {
                  const selected = item.id === selectedId;
                  return (
                    <tr
                      key={item.id}
                      className={selected ? "bg-teal-50/60" : "bg-white hover:bg-zinc-50"}
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setSelectedId(item.id)}
                          className="text-left"
                        >
                          <p className="font-semibold text-zinc-950">{item.title}</p>
                          <p className="mt-1 text-xs text-zinc-600">{item.playbackFileName}</p>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <StatusPill label={mediaKind(item)} tone={mediaKind(item) === "Still clip" ? "warn" : "good"} />
                          <StatusPill label={item.status} tone={statusTone(item.status)} />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-zinc-700">{item.durationSeconds ? `${item.durationSeconds}s` : "Unknown"}</td>
                      <td className="px-4 py-3 text-zinc-700">{formatBytes(item.sizeBytes)}</td>
                      <td className="px-4 py-3 text-zinc-700">{item.tags.length > 0 ? item.tags.join(", ") : "—"}</td>
                      <td className="px-4 py-3 text-zinc-700">{formatTimestamp(item.updatedAt)}</td>
                    </tr>
                  );
                })}
                {items.length === 0 ? (
                  <tr>
                    <td className="px-4 py-5 text-zinc-600" colSpan={6}>{listMessage}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-zinc-200 p-4">
            <p className="text-sm text-zinc-600">{listMessage}</p>
            <button
              type="button"
              disabled={!hasMore || isLoading}
              onClick={() => {
                void loadMedia(false);
              }}
              className="min-h-11 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
            >
              {isLoading ? "Loading..." : hasMore ? "Load more" : "No more items"}
            </button>
          </div>
        </section>
      </div>

      <section className="self-start rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold">Media Details</h3>
          {selectedItem ? <StatusPill label={selectedItem.status} tone={statusTone(selectedItem.status)} /> : null}
        </div>
        {selectedItem ? (
          <form onSubmit={handleSaveDetails} className="mt-4 grid gap-3">
            <div>
              <label htmlFor="details-title" className="text-sm font-semibold text-zinc-950">Title</label>
              <input
                id="details-title"
                value={detailsTitle}
                onChange={(event) => setDetailsTitle(event.currentTarget.value)}
                disabled={isBusy}
                className="mt-2 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
            </div>
            <div>
              <label htmlFor="details-tags" className="text-sm font-semibold text-zinc-950">Tags</label>
              <input
                id="details-tags"
                value={detailsTags}
                onChange={(event) => setDetailsTags(event.currentTarget.value)}
                disabled={isBusy}
                className="mt-2 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
            </div>
            <div>
              <label htmlFor="details-description" className="text-sm font-semibold text-zinc-950">Description</label>
              <textarea
                id="details-description"
                rows={8}
                value={detailsDescription}
                onChange={(event) => setDetailsDescription(event.currentTarget.value)}
                disabled={isBusy}
                className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
            </div>
            <dl className="grid gap-2 rounded-md bg-zinc-50 p-3 text-sm text-zinc-700">
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <dt className="font-semibold text-zinc-500">Playback</dt>
                <dd className="break-words">{selectedItem.playbackFileName}</dd>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <dt className="font-semibold text-zinc-500">Source</dt>
                <dd className="break-words">{selectedItem.sourceFileName}</dd>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <dt className="font-semibold text-zinc-500">Created</dt>
                <dd>{formatTimestamp(selectedItem.createdAt)}</dd>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <dt className="font-semibold text-zinc-500">Updated</dt>
                <dd>{formatTimestamp(selectedItem.updatedAt)}</dd>
              </div>
            </dl>
            <button
              type="submit"
              disabled={isBusy}
              className="min-h-11 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
            >
              {isSaving ? "Saving..." : "Save metadata"}
            </button>
            <p className="text-sm text-zinc-600" role="status" aria-live="polite">{detailsMessage}</p>
          </form>
        ) : (
          <p className="mt-3 text-sm text-zinc-600">No media selected.</p>
        )}
      </section>
    </div>
  );
}
