"use client";

import type { InputHTMLAttributes } from "react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "./dashboard-ui";
import { isPlaybackSafeVideoFileName, isStillClipFileName } from "./lib/playback-safety";

type MediaFolder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type MediaItem = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  sourceFileName: string;
  playbackFileName: string;
  mimeType: string;
  sizeBytes: number;
  sourceSizeBytes?: number;
  durationSeconds: number | null;
  checksumSha256?: string;
  playbackProfile?: string;
  preparedAt?: string;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  videoCodec?: string | null;
  videoProfile?: string | null;
  pixelFormat?: string | null;
  audioCodec?: string | null;
  bitRate?: number | null;
  status: "ready" | "processing" | "failed";
  createdAt: string;
  updatedAt: string;
  folderId?: string | null;
  folderName?: string | null;
  missingFile?: boolean;
  origin?: "media-store" | "playlist";
  playlistAssetIds?: string[];
  playlistUseCount?: number;
};

type MediaListResponse = {
  folders: MediaFolder[];
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

type MediaUpdateResponse = {
  error?: string;
  item?: MediaItem;
};

type FolderCreateResponse = {
  error?: string;
  folder?: MediaFolder;
};

type FolderDeleteResponse = {
  deleted?: boolean;
  error?: string;
  folder?: MediaFolder;
};

type FolderMoveResponse = {
  error?: string;
  moved?: number;
};

type StatusTone = "good" | "warn" | "muted";
type SafetyFilter = "all" | "ready" | "review";
type TypeFilter = "all" | "video" | "still" | "mov";
type UploadSource = "file" | "directory";

type PlaybackSafety = {
  canUseInPlaylist: boolean;
  detail: string;
  label: string;
  tone: StatusTone;
};

const folderFilterPrefix = "folder:";
const cannedTags = [
  "demo-ready",
  "pi-safe",
  "needs-review",
  "problem",
  "client",
  "still",
  "video"
];
const directoryInputAttributes: InputHTMLAttributes<HTMLInputElement> & {
  directory: string;
  webkitdirectory: string;
} = {
  directory: "",
  webkitdirectory: ""
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
    return "-";
  }

  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    style: "unit",
    unit: "megabyte"
  }).format(value / 1_000_000);
}

function formatDuration(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}s` : "-";
}

function isMp4FileName(fileName: string): boolean {
  return /\.mp4$/i.test(fileName);
}

function isSupportedUploadFile(fileName: string): boolean {
  return /\.(?:mp4|mov|jpe?g|png)$/i.test(fileName);
}

function uploadRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath?.trim() || file.name;
}

function isSkippedDirectoryEntry(file: File): boolean {
  const pathParts = uploadRelativePath(file).split(/[\\/]/).filter(Boolean);
  return pathParts.some((part) => part.startsWith(".") || part === "__MACOSX") || !isSupportedUploadFile(file.name);
}

function mediaKind(item: MediaItem): "Image" | "Video" | "MOV" | "File" {
  if (isStillClipFileName(item.playbackFileName)) {
    return "Image";
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
      detail: "The local file is missing.",
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
      detail: "Convert this media to MP4 before adding it to the playlist.",
      label: "Needs MP4",
      tone: "warn"
    };
  }

  if (!isPlaybackSafeVideoFileName(item.playbackFileName)) {
    return {
      canUseInPlaylist: false,
      detail: "This MP4 needs Pi-safe 720p preparation before playlist use.",
      label: "Needs prep",
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

function selectedCustomFolderId(folderFilter: string): string | null {
  return folderFilter.startsWith(folderFilterPrefix) ? folderFilter.slice(folderFilterPrefix.length) : null;
}

function folderLabel(item: MediaItem): string {
  return item.folderName ?? "Unfiled";
}

function matchesFolderFilter(item: MediaItem, folderFilter: string): boolean {
  if (folderFilter === "all") {
    return true;
  }
  if (folderFilter === "unfiled") {
    return !item.folderId;
  }

  const folderId = selectedCustomFolderId(folderFilter);
  return folderId ? item.folderId === folderId : true;
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
    return kind === "Image";
  }
  if (filter === "mov") {
    return kind === "MOV";
  }

  return kind === "Video";
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function tagString(tags: string[]): string {
  return tags.join(", ");
}

function tagsFromText(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.slice(0, 48))
    )
  );
}

function appendTagText(currentText: string, tag: string): string {
  return tagString(Array.from(new Set([...tagsFromText(currentText), tag])));
}

function removeTagText(currentText: string, tag: string): string {
  const normalized = normalizeTag(tag);
  return tagString(tagsFromText(currentText).filter((entry) => normalizeTag(entry) !== normalized));
}

function canDeleteMedia(item: MediaItem): boolean {
  return item.origin !== "playlist" && !isInPlaylist(item);
}

function canAddMediaToPlaylist(item: MediaItem): boolean {
  return playbackSafety(item).canUseInPlaylist && !isInPlaylist(item) && item.origin !== "playlist";
}

function sidebarButtonClass(selected: boolean): string {
  return selected
    ? "bg-teal-50 text-teal-950 ring-teal-200"
    : "bg-white text-zinc-700 ring-zinc-200 hover:bg-zinc-50";
}

export function MediaStorePanel() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("");
  const [safetyFilter, setSafetyFilter] = useState<SafetyFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [showUpload, setShowUpload] = useState(false);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [uploadFolderId, setUploadFolderId] = useState("");
  const [uploadSource, setUploadSource] = useState<UploadSource>("file");
  const [durationSeconds, setDurationSeconds] = useState("10");
  const [newFolderName, setNewFolderName] = useState("");
  const [targetFolderId, setTargetFolderId] = useState("");
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [message, setMessage] = useState("Loading media...");
  const [messageTone, setMessageTone] = useState<"idle" | "success" | "warning" | "error">("idle");
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [addingMediaId, setAddingMediaId] = useState<string | null>(null);
  const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null);
  const [editingTagMediaId, setEditingTagMediaId] = useState<string | null>(null);
  const [editingTags, setEditingTags] = useState("");
  const [updatingTagMediaId, setUpdatingTagMediaId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const selectedIds = useMemo(() => new Set(selectedMediaIds), [selectedMediaIds]);
  const visibleItems = useMemo(
    () =>
      items.filter(
        (item) =>
          matchesFolderFilter(item, folderFilter) &&
          (!tagFilter || item.tags.some((tag) => normalizeTag(tag) === normalizeTag(tagFilter))) &&
          matchesSafetyFilter(item, safetyFilter) &&
          matchesTypeFilter(item, typeFilter)
      ),
    [folderFilter, items, safetyFilter, tagFilter, typeFilter]
  );
  const hasVisibleActions = useMemo(
    () => visibleItems.length > 0,
    [visibleItems]
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
  const unfiledItemCount = items.filter((item) => !item.folderId).length;
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const folder of folders) {
      counts.set(folder.id, 0);
    }
    for (const item of items) {
      if (item.folderId) {
        counts.set(item.folderId, (counts.get(item.folderId) ?? 0) + 1);
      }
    }
    return counts;
  }, [folders, items]);
  const availableTags = useMemo(
    () =>
      Array.from(new Set([...cannedTags, ...items.flatMap((item) => item.tags)]))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })),
    [items]
  );
  const selectedFolderId = selectedCustomFolderId(folderFilter);
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const visibleIds = visibleItems.map((item) => item.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const isBusy =
    isPending ||
    isLoading ||
    isUploading ||
    isMoving ||
    isCreatingFolder ||
    deletingFolderId !== null ||
    addingMediaId !== null ||
    deletingMediaId !== null ||
    updatingTagMediaId !== null;

  useEffect(() => {
    if (selectedFolderId) {
      setUploadFolderId(selectedFolderId);
      setTargetFolderId(selectedFolderId);
    }
  }, [selectedFolderId]);

  async function loadMedia(reset: boolean, requestedQuery = query): Promise<void> {
    const cursor = reset ? "0" : nextCursor ?? "0";
    const params = new URLSearchParams({ limit: "200", cursor });

    if (requestedQuery) {
      params.set("q", requestedQuery);
    }

    if (tagFilter) {
      params.set("tag", tagFilter);
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
      setFolders(result.folders ?? []);
      setItems((current) => (reset ? result.items : [...current, ...result.items]));
      setSelectedMediaIds((current) =>
        current.filter((id) => (reset ? result.items : [...items, ...result.items]).some((item) => item.id === id))
      );
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
  }, [query, tagFilter]);

  async function handleCreateFolder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    const name = newFolderName.trim();
    if (!name) {
      setMessage("Name the folder first.");
      setMessageTone("error");
      return;
    }

    setIsCreatingFolder(true);
    setMessage(`Creating ${name}...`);
    setMessageTone("idle");
    try {
      const response = await fetch("/api/media-folders", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name })
      });
      const result = (await response.json()) as FolderCreateResponse;
      if (!response.ok || result.error || !result.folder) {
        throw new Error(result.error ?? "Could not create folder.");
      }

      setNewFolderName("");
      setFolderFilter(`${folderFilterPrefix}${result.folder.id}`);
      setUploadFolderId(result.folder.id);
      setTargetFolderId(result.folder.id);
      await loadMedia(true);
      setMessage(`${result.folder.name} created.`);
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create folder.");
      setMessageTone("error");
    } finally {
      setIsCreatingFolder(false);
    }
  }

  async function handleRemoveSelectedFolder() {
    if (!selectedFolder || isBusy) {
      return;
    }

    const confirmed = window.confirm(`Remove folder "${selectedFolder.name}"? Media will stay in Library.`);
    if (!confirmed) {
      return;
    }

    setDeletingFolderId(selectedFolder.id);
    setMessage(`Removing ${selectedFolder.name}...`);
    setMessageTone("idle");
    try {
      const response = await fetch(`/api/media-folders/${encodeURIComponent(selectedFolder.id)}`, {
        method: "DELETE",
        cache: "no-store"
      });
      const result = (await response.json()) as FolderDeleteResponse;
      if (!response.ok || result.error || !result.deleted) {
        throw new Error(result.error ?? "Could not remove folder.");
      }

      setFolderFilter("all");
      setTargetFolderId("");
      setUploadFolderId("");
      await loadMedia(true);
      setMessage(`${selectedFolder.name} removed.`);
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove folder.");
      setMessageTone("error");
    } finally {
      setDeletingFolderId(null);
    }
  }

  async function handleMoveSelected() {
    if (isBusy || selectedMediaIds.length === 0) {
      return;
    }

    setIsMoving(true);
    setMessage(`Moving ${selectedMediaIds.length} item${selectedMediaIds.length === 1 ? "" : "s"}...`);
    setMessageTone("idle");
    try {
      const response = await fetch("/api/media-folders", {
        method: "PATCH",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          folderId: targetFolderId || null,
          mediaIds: selectedMediaIds
        })
      });
      const result = (await response.json()) as FolderMoveResponse;
      if (!response.ok || result.error || typeof result.moved !== "number") {
        throw new Error(result.error ?? "Could not move media.");
      }

      setSelectedMediaIds([]);
      await loadMedia(true);
      setMessage(`${result.moved} item${result.moved === 1 ? "" : "s"} moved.`);
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not move media.");
      setMessageTone("error");
    } finally {
      setIsMoving(false);
    }
  }

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    const sourceInput = uploadSource === "directory" ? directoryInputRef.current : fileInputRef.current;
    const selectedFiles = Array.from(sourceInput?.files ?? []);
    const files =
      uploadSource === "directory"
        ? selectedFiles.filter((file) => !isSkippedDirectoryEntry(file))
        : selectedFiles.slice(0, 1);
    const skippedCount = selectedFiles.length - files.length;
    if (files.length === 0) {
      setMessage(uploadSource === "directory" ? "Choose a directory with MP4, MOV, JPG, or PNG files." : "Choose a file.");
      setMessageTone("error");
      return;
    }

    setIsUploading(true);
    setMessage(files.length === 1 ? `Uploading ${files[0].name}...` : `Uploading 1 of ${files.length}: ${files[0].name}...`);
    setMessageTone("idle");

    try {
      const uploadedItems: MediaItem[] = [];

      for (const [index, file] of files.entries()) {
        const formData = new FormData();
        formData.append("media", file);
        formData.append("title", files.length === 1 ? uploadTitle : "");
        formData.append("tags", uploadTags);
        formData.append("durationSeconds", durationSeconds);
        formData.append("folderId", uploadFolderId);

        if (files.length > 1) {
          setMessage(`Uploading ${index + 1} of ${files.length}: ${uploadRelativePath(file)}...`);
        }

        const response = await fetch("/api/media", {
          method: "POST",
          body: formData,
          cache: "no-store"
        });
        const result = (await response.json()) as UploadResponse;
        if (!response.ok || result.error || !result.item) {
          throw new Error(result.error ?? `Upload failed for ${file.name}.`);
        }

        uploadedItems.push(result.item);
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      if (directoryInputRef.current) {
        directoryInputRef.current.value = "";
      }
      setUploadTitle("");
      setUploadTags("");
      setQuery("");
      setQueryInput("");
      await loadMedia(true, "");
      const needsReviewCount = uploadedItems.filter((item) => !playbackSafety(item).canUseInPlaylist).length;
      const skippedSuffix = skippedCount > 0 ? ` ${skippedCount} unsupported or hidden file${skippedCount === 1 ? "" : "s"} skipped.` : "";
      if (uploadedItems.length === 1) {
        setMessage(`${uploadedItems[0].playbackFileName} saved.${skippedSuffix}`);
      } else {
        setMessage(`${uploadedItems.length} files saved.${skippedSuffix}`);
      }
      setMessageTone(needsReviewCount > 0 ? "warning" : "success");
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
      setSelectedMediaIds((current) => current.filter((id) => id !== item.id));
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

  function startEditingTags(item: MediaItem) {
    setEditingTagMediaId(item.id);
    setEditingTags(tagString(item.tags));
  }

  async function handleSaveTags(item: MediaItem) {
    if (isBusy) {
      return;
    }

    setUpdatingTagMediaId(item.id);
    setMessage(`Updating tags for ${item.title}...`);
    setMessageTone("idle");
    try {
      const response = await fetch(`/api/media/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tags: editingTags
        })
      });
      const result = (await response.json()) as MediaUpdateResponse;
      if (!response.ok || result.error || !result.item) {
        throw new Error(result.error ?? "Could not update tags.");
      }

      setEditingTagMediaId(null);
      setEditingTags("");
      await loadMedia(true);
      setMessage(`Updated tags for ${result.item.title}.`);
      setMessageTone("success");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update tags.");
      setMessageTone("error");
    } finally {
      setUpdatingTagMediaId(null);
    }
  }

  function toggleMediaSelection(mediaId: string, checked: boolean) {
    setSelectedMediaIds((current) =>
      checked ? Array.from(new Set([...current, mediaId])) : current.filter((id) => id !== mediaId)
    );
  }

  function toggleVisibleSelection(checked: boolean) {
    if (!checked) {
      setSelectedMediaIds((current) => current.filter((id) => !visibleIds.includes(id)));
      return;
    }

    setSelectedMediaIds((current) => Array.from(new Set([...current, ...visibleIds])));
  }

  function renderFolderButton(label: string, count: number, value: string) {
    const selected = folderFilter === value;
    return (
      <button
        key={value}
        type="button"
        onClick={() => setFolderFilter(value)}
        aria-pressed={selected}
        className={`flex min-h-10 max-w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-semibold ring-1 ${sidebarButtonClass(selected)}`}
      >
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-xs text-zinc-500">{count}</span>
      </button>
    );
  }

  function renderTagFilterButton(label: string) {
    const selected = normalizeTag(tagFilter) === normalizeTag(label);
    const count = items.filter((item) => item.tags.some((tag) => normalizeTag(tag) === normalizeTag(label))).length;
    return (
      <button
        key={label}
        type="button"
        onClick={() => setTagFilter(selected ? "" : label)}
        aria-pressed={selected}
        className={`flex min-h-9 max-w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm font-semibold ring-1 ${sidebarButtonClass(selected)}`}
      >
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-xs text-zinc-500">{count}</span>
      </button>
    );
  }

  return (
    <section className="min-w-0 rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-zinc-950">Library</h2>
              <p className="mt-1 text-sm text-zinc-600">
                {totalItems} assets · {readyItemCount} ready · {playlistItemCount} in playlist
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

          <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,380px)] xl:items-start">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-zinc-950">Folders</span>
                <StatusPill label={`${folders.length}`} tone="muted" />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {renderFolderButton("All media", items.length, "all")}
                {renderFolderButton("Unfiled", unfiledItemCount, "unfiled")}
                {folders.map((folder) =>
                  renderFolderButton(folder.name, folderCounts.get(folder.id) ?? 0, `${folderFilterPrefix}${folder.id}`)
                )}
                {reviewItemCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setSafetyFilter("review")}
                    aria-pressed={safetyFilter === "review"}
                    className="flex min-h-10 max-w-full items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-left text-sm font-semibold text-amber-950 ring-1 ring-amber-200"
                  >
                    <span className="truncate">Needs attention</span>
                    <span className="shrink-0 text-xs text-amber-700">{reviewItemCount}</span>
                  </button>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-zinc-950">Tags</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {availableTags.map(renderTagFilterButton)}
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-2 sm:flex-row xl:justify-end">
              <form onSubmit={handleCreateFolder} className="flex min-w-0 flex-1 gap-2 xl:max-w-[300px]">
                <label htmlFor="new-media-folder" className="sr-only">New folder name</label>
                <input
                  id="new-media-folder"
                  value={newFolderName}
                  onChange={(event) => setNewFolderName(event.currentTarget.value)}
                  placeholder="New folder"
                  disabled={isBusy}
                  className="min-h-10 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                />
                <button
                  type="submit"
                  disabled={isBusy}
                  className="min-h-10 shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100"
                >
                  {isCreatingFolder ? "Creating" : "Add"}
                </button>
              </form>

              {selectedFolder ? (
                <button
                  type="button"
                  onClick={() => void handleRemoveSelectedFolder()}
                  disabled={isBusy}
                  className="min-h-10 shrink-0 rounded-md border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-700 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
                >
                  {deletingFolderId === selectedFolder.id ? "Removing" : "Remove folder"}
                </button>
              ) : null}
            </div>
          </div>

          <form
            className="mt-4 grid gap-2 md:grid-cols-[minmax(0,1fr)_150px_130px_auto]"
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
              <option value="still">Images</option>
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
                disabled={isBusy || (!query && !queryInput && !tagFilter && safetyFilter === "all" && typeFilter === "all" && folderFilter === "all")}
                onClick={() => {
                  setQueryInput("");
                  setQuery("");
                  setTagFilter("");
                  setSafetyFilter("all");
                  setTypeFilter("all");
                  setFolderFilter("all");
                }}
                className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
              >
                Clear
              </button>
            </div>
          </form>

          <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-center">
            <p className="text-sm text-zinc-600">{selectedMediaIds.length} selected</p>
            <label className="sr-only" htmlFor="move-media-folder">Move selected to folder</label>
            <select
              id="move-media-folder"
              value={targetFolderId}
              onChange={(event) => setTargetFolderId(event.currentTarget.value)}
              disabled={isBusy || selectedMediaIds.length === 0}
              className="min-h-10 min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 disabled:bg-zinc-100"
            >
              <option value="">Unfiled</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleMoveSelected()}
              disabled={isBusy || selectedMediaIds.length === 0}
              className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
            >
              {isMoving ? "Moving" : "Move"}
            </button>
          </div>
        </div>

        {showUpload ? (
          <form
            onSubmit={handleUpload}
            encType="multipart/form-data"
            className="grid gap-3 border-b border-zinc-200 bg-zinc-50 p-4 xl:grid-cols-[140px_minmax(220px,1fr)_minmax(150px,0.5fr)_110px_minmax(150px,0.55fr)_minmax(150px,0.55fr)_auto] xl:items-end"
          >
            <fieldset>
              <legend className="text-sm font-semibold text-zinc-950">Upload</legend>
              <div className="mt-1 grid grid-cols-2 overflow-hidden rounded-md border border-zinc-300 bg-white text-sm font-semibold">
                <label className={uploadSource === "file" ? "bg-zinc-900 text-white" : "text-zinc-700"}>
                  <input
                    type="radio"
                    name="uploadSource"
                    value="file"
                    checked={uploadSource === "file"}
                    onChange={() => {
                      setUploadSource("file");
                      if (directoryInputRef.current) {
                        directoryInputRef.current.value = "";
                      }
                    }}
                    disabled={isBusy}
                    className="sr-only"
                  />
                  <span className="flex min-h-10 items-center justify-center px-3">File</span>
                </label>
                <label className={uploadSource === "directory" ? "bg-zinc-900 text-white" : "text-zinc-700"}>
                  <input
                    type="radio"
                    name="uploadSource"
                    value="directory"
                    checked={uploadSource === "directory"}
                    onChange={() => {
                      setUploadSource("directory");
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                    disabled={isBusy}
                    className="sr-only"
                  />
                  <span className="flex min-h-10 items-center justify-center px-3">Directory</span>
                </label>
              </div>
            </fieldset>
            <div>
              <label htmlFor={uploadSource === "directory" ? "media-directory" : "media-file"} className="text-sm font-semibold text-zinc-950">
                {uploadSource === "directory" ? "Directory" : "File"}
              </label>
              {uploadSource === "file" ? (
                <input
                  ref={fileInputRef}
                  id="media-file"
                  name="media"
                  type="file"
                  accept="video/mp4,video/quicktime,image/jpeg,image/png,.mp4,.mov,.jpg,.jpeg,.png"
                  disabled={isBusy}
                  className="mt-1 block min-h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-950 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white"
                />
              ) : (
                <input
                  {...directoryInputAttributes}
                  ref={directoryInputRef}
                  id="media-directory"
                  name="mediaDirectory"
                  type="file"
                  multiple
                  accept="video/mp4,video/quicktime,image/jpeg,image/png,.mp4,.mov,.jpg,.jpeg,.png"
                  disabled={isBusy}
                  className="mt-1 block min-h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-950 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white"
                />
              )}
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
              <label htmlFor="media-duration" className="text-sm font-semibold text-zinc-950">Image time</label>
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
              <div className="mt-2 flex flex-wrap gap-1.5">
                {cannedTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setUploadTags((current) => appendTagText(current, tag))}
                    disabled={isBusy}
                    className="min-h-8 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-semibold text-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-100"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor="upload-media-folder" className="text-sm font-semibold text-zinc-950">Folder</label>
              <select
                id="upload-media-folder"
                value={uploadFolderId}
                onChange={(event) => setUploadFolderId(event.currentTarget.value)}
                disabled={isBusy}
                className="mt-1 min-h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              >
                <option value="">Unfiled</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
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
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3">
                  <label className="sr-only" htmlFor="select-visible-media">Select visible media</label>
                  <input
                    id="select-visible-media"
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) => toggleVisibleSelection(event.currentTarget.checked)}
                    className="h-4 w-4 accent-teal-700"
                  />
                </th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Folder</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Updated</th>
                {hasVisibleActions ? <th className="min-w-[148px] px-4 py-3">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {visibleItems.map((item) => {
                const safety = playbackSafety(item);
                const canAdd = canAddMediaToPlaylist(item);
                const deleting = deletingMediaId === item.id;
                return (
                  <tr key={item.id} className="bg-white hover:bg-zinc-50">
                    <td className="px-4 py-3">
                      <label className="sr-only" htmlFor={`select-${item.id}`}>Select {item.title}</label>
                      <input
                        id={`select-${item.id}`}
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={(event) => toggleMediaSelection(item.id, event.currentTarget.checked)}
                        className="h-4 w-4 accent-teal-700"
                      />
                    </td>
                    <td className="max-w-[380px] px-4 py-3">
                      <p className="truncate font-semibold text-zinc-950" title={item.title}>{item.title}</p>
                      <p className="mt-1 truncate text-xs text-zinc-500" title={item.playbackFileName}>{item.playbackFileName}</p>
                      {editingTagMediaId === item.id ? (
                        <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                          <label className="sr-only" htmlFor={`tags-${item.id}`}>Tags for {item.title}</label>
                          <input
                            id={`tags-${item.id}`}
                            value={editingTags}
                            onChange={(event) => setEditingTags(event.currentTarget.value)}
                            disabled={isBusy}
                            className="min-h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
                          />
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {cannedTags.map((tag) => {
                              const selected = tagsFromText(editingTags).some((entry) => normalizeTag(entry) === normalizeTag(tag));
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() =>
                                    setEditingTags((current) => selected ? removeTagText(current, tag) : appendTagText(current, tag))
                                  }
                                  disabled={isBusy}
                                  aria-pressed={selected}
                                  className={`min-h-8 rounded-md px-2 py-1 text-xs font-semibold ring-1 disabled:cursor-not-allowed disabled:bg-zinc-100 ${
                                    selected ? "bg-teal-50 text-teal-950 ring-teal-200" : "bg-white text-zinc-700 ring-zinc-300"
                                  }`}
                                >
                                  {tag}
                                </button>
                              );
                            })}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void handleSaveTags(item)}
                              disabled={isBusy}
                              className="min-h-9 rounded-md bg-teal-700 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
                            >
                              {updatingTagMediaId === item.id ? "Saving" : "Save tags"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingTagMediaId(null);
                                setEditingTags("");
                              }}
                              disabled={isBusy}
                              className="min-h-9 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : item.tags.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {item.tags.map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => setTagFilter(tag)}
                              className="min-h-7 rounded-md bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-700 hover:bg-teal-50 hover:text-teal-900"
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span title={safety.detail}>
                        <StatusPill label={safety.label} tone={safety.tone} />
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">{mediaKind(item)}</td>
                    <td className="max-w-[160px] px-4 py-3 text-zinc-700">
                      <span className="block truncate" title={folderLabel(item)}>{folderLabel(item)}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-700">{formatDuration(item.durationSeconds)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-700">{formatBytes(item.sizeBytes)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-700">{formatTimestamp(item.updatedAt)}</td>
                    {hasVisibleActions ? (
                      <td className="px-4 py-3">
                        <div className="flex min-w-[124px] flex-nowrap gap-2">
                          {canAdd ? (
                            <button
                              type="button"
                              onClick={() => void handleAddToPlaylist(item)}
                              disabled={isBusy}
                              className="min-h-9 shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
                            >
                              {addingMediaId === item.id ? "Adding" : "Add"}
                            </button>
                          ) : null}
                          {canDeleteMedia(item) ? (
                            <button
                              type="button"
                              onClick={() => void handleDelete(item)}
                              disabled={isBusy}
                              className="min-h-9 shrink-0 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-sm font-semibold text-rose-700 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
                            >
                              {deleting ? "Deleting" : "Delete"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => startEditingTags(item)}
                            disabled={isBusy}
                            className="min-h-9 shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
                          >
                            Tags
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {visibleItems.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-zinc-600" colSpan={hasVisibleActions ? 9 : 8}>
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
