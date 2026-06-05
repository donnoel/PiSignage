"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "./dashboard-ui";

type Tone = "good" | "muted" | "warn";

type ScreenRecord = {
  deviceId: string | null;
  group: string;
  id: string;
  location: string;
  name: string;
  playlistId: string | null;
  updatedAt?: string;
};

type DeviceRecord = {
  group: string;
  host: string;
  id: string;
  location: string;
  name: string;
  playlistId: string | null;
  playerType?: "vlc";
  rootPath?: string;
  screenId: string | null;
  sshUser?: string;
  updatedAt?: string;
};

type PlaylistOption = {
  assetCount: number;
  name: string;
  playlistId: string;
  version: number;
};

type InventoryResponse = {
  devices: DeviceRecord[];
  error?: string;
  playlistId: string;
  playlistName?: string;
  screens: ScreenRecord[];
};

type PublishResponse = {
  error?: string;
  message?: string;
  piPublish?: {
    message: string;
    ok: boolean;
  };
  playlistVersion?: number;
};

type InventoryPanelProps = {
  deviceStatuses: Record<string, DeviceLiveStatus>;
  playlistId: string;
  playlists: PlaylistOption[];
};

type DeviceLiveStatus = {
  ageLabel: string;
  host: string | null;
  playbackHealthy: boolean;
  playbackLabel: string;
  playerStatus: {
    playlistId?: string;
    playlistVersion?: number;
    updatedAt?: string;
  } | null;
  reachable: boolean;
  stale: boolean;
  timestampLabel: string;
};

type ScreenActionTone = "danger" | "neutral" | "primary";
type ScreenSortKey = "device" | "lastSeen" | "playback" | "playlist" | "screen" | "status" | "sync";
type SortDirection = "asc" | "desc";

type ScreenRow = {
  assignedPlaylist: PlaylistOption | null;
  assignedPlaylistId: string | null;
  currentPlaylistLine: string;
  device: DeviceRecord | null;
  devicePlaylistLine: string | null;
  isLive: boolean;
  lastSeenAge: string;
  lastSeenFull: string;
  lastSeenSort: number;
  needsAttention: boolean;
  playbackDetail: string;
  playbackLabel: string;
  playbackTone: Tone;
  screen: ScreenRecord;
  statusDetail: string;
  statusLabel: string;
  statusTone: Tone;
  syncDetail: string;
  syncLabel: string;
  syncTone: Tone;
};

type ScreenSort = {
  direction: SortDirection;
  key: ScreenSortKey;
};

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function sortableTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function screenRowSortValue(row: ScreenRow, key: ScreenSortKey): string | number {
  switch (key) {
    case "device":
      return row.device?.host ?? "";
    case "lastSeen":
      return row.lastSeenSort;
    case "playback":
      return row.playbackLabel;
    case "playlist":
      return row.assignedPlaylist?.name ?? "";
    case "status":
      return row.statusLabel;
    case "sync":
      return row.syncLabel;
    case "screen":
    default:
      return `${row.screen.name}\n${row.screen.location}\n${row.screen.group}`;
  }
}

function compareSortValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return compareText(String(left), String(right));
}

function sortScreenRows(rows: ScreenRow[], sort: ScreenSort): ScreenRow[] {
  const direction = sort.direction === "asc" ? 1 : -1;

  return rows
    .slice()
    .sort((left, right) => {
      const primary = compareSortValues(screenRowSortValue(left, sort.key), screenRowSortValue(right, sort.key));
      const fallback =
        compareText(left.screen.group, right.screen.group) ||
        compareText(left.screen.location, right.screen.location) ||
        compareText(left.screen.name, right.screen.name);

      return (primary || fallback) * direction;
    });
}

function formatCount(count: number, label: string): string {
  return `${count} ${count === 1 ? label : `${label}s`}`;
}

function screenActionClass(tone: ScreenActionTone): string {
  if (tone === "danger") {
    return "border-rose-200 text-rose-700 hover:bg-rose-50";
  }
  if (tone === "primary") {
    return "border-teal-200 text-teal-800 hover:bg-teal-50";
  }

  return "border-zinc-200 text-zinc-800 hover:bg-zinc-50";
}

function ScreenActionIcon({ name }: { name: "playlist" | "remove" | "rename" | "status" }) {
  if (name === "playlist") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        <rect x="4" y="5" width="16" height="14" rx="3" />
        <path d="M8 9.5h8M8 13h8M8 16.5h5" />
      </svg>
    );
  }

  if (name === "rename") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        <path d="M5 18.5 6.2 14 15.8 4.4a2 2 0 0 1 2.8 2.8L9 16.8 4.5 18l.5.5Z" />
        <path d="m14.5 5.8 3.7 3.7" />
      </svg>
    );
  }

  if (name === "remove") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        <path d="M5 7h14M10 11v6M14 11v6M8 7l.6 12a2 2 0 0 0 2 1.9h2.8a2 2 0 0 0 2-1.9L16 7M9.5 7l.4-2h4.2l.4 2" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function sortScreens(screens: ScreenRecord[]): ScreenRecord[] {
  return screens
    .slice()
    .sort(
      (a, b) =>
        compareText(a.group, b.group) ||
        compareText(a.location, b.location) ||
        compareText(a.name, b.name)
    );
}

function sortDevices(devices: DeviceRecord[]): DeviceRecord[] {
  return devices
    .slice()
    .sort(
      (a, b) =>
        compareText(a.group, b.group) ||
        compareText(a.location, b.location) ||
        compareText(a.name, b.name)
    );
}

function hasLocalAddress(device: DeviceRecord): boolean {
  return Boolean(device.host.trim()) && normalized(device.host) !== "not configured";
}

function publishRequiredDetail(localVersion: number, reportedVersion: number): string {
  return `Beam v${localVersion}; Pi v${reportedVersion}. Publish required.`;
}

function plainPlaybackLabel(value: string): string {
  if (value === "Stale") {
    return "Old report";
  }
  if (value === "unreachable") {
    return "Not available";
  }
  if (value === "unknown") {
    return "Not confirmed";
  }

  return value || "Not reported";
}

function piLabel(device: DeviceRecord | null, screen?: ScreenRecord): string {
  if (!device) {
    return "No Pi linked";
  }

  return screen ? `${screen.name} Pi` : device.name;
}

export function ScreenDeviceInventoryPanel({
  deviceStatuses,
  playlistId,
  playlists
}: InventoryPanelProps) {
  const router = useRouter();
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [publishingScreenId, setPublishingScreenId] = useState<string | null>(null);
  const [screenSort, setScreenSort] = useState<ScreenSort>({ direction: "asc", key: "screen" });
  const [screenName, setScreenName] = useState("");
  const [screenLocation, setScreenLocation] = useState("");
  const [screenGroup, setScreenGroup] = useState("");
  const [deviceHost, setDeviceHost] = useState("");
  const [deviceSshUser, setDeviceSshUser] = useState("donnoel");
  const [isPending, startTransition] = useTransition();
  const isBusy = isLoading || isSaving || isPending;

  const screens = useMemo(() => sortScreens(inventory?.screens ?? []), [inventory?.screens]);
  const devices = useMemo(() => sortDevices(inventory?.devices ?? []), [inventory?.devices]);

  const playlistsById = useMemo(() => {
    return new Map(playlists.map((playlist) => [playlist.playlistId, playlist]));
  }, [playlists]);

  const devicesById = useMemo(() => {
    return new Map(devices.map((device) => [device.id, device]));
  }, [devices]);

  const devicesByScreenId = useMemo(() => {
    const next = new Map<string, DeviceRecord>();
    for (const device of devices) {
      if (device.screenId) {
        next.set(device.screenId, device);
      }
    }
    return next;
  }, [devices]);

  function playlistName(playlistIdValue: string | null | undefined): string {
    if (!playlistIdValue) {
      return "No playlist";
    }

    return playlistsById.get(playlistIdValue)?.name ?? "Playlist not found";
  }

  function deviceIsLive(device: DeviceRecord): boolean {
    return Boolean(deviceStatuses[device.id]);
  }

  function statusFor(device: DeviceRecord | null): DeviceLiveStatus | null {
    if (!device) {
      return null;
    }
    return deviceStatuses[device.id] ?? null;
  }

  function linkedDeviceForScreen(screen: ScreenRecord): DeviceRecord | null {
    if (screen.deviceId) {
      return devicesById.get(screen.deviceId) ?? devicesByScreenId.get(screen.id) ?? null;
    }

    return devicesByScreenId.get(screen.id) ?? null;
  }

  function screenStatus(device: DeviceRecord | null): {
    detail: string;
    label: string;
    tone: Tone;
  } {
    if (!device) {
      return {
        detail: "No local Pi is linked to this screen yet.",
        label: "Needs setup",
        tone: "warn"
      };
    }

    if (!hasLocalAddress(device)) {
      return {
        detail: "Add the local address before Beam can check this screen.",
        label: "Needs setup",
        tone: "warn"
      };
    }

    const status = statusFor(device);
    if (deviceIsLive(device)) {
      const reachable = status?.reachable ?? false;
      return reachable
        ? {
            detail: "Beam can reach this screen on the local network.",
            label: "Online",
            tone: "good"
          }
        : {
            detail: "Beam cannot reach this screen right now.",
            label: "Offline",
            tone: "warn"
          };
    }

    return {
      detail: "Saved locally, but no check-in has been seen for this address.",
      label: "Not reporting",
      tone: "muted"
    };
  }

  function playbackStatus(device: DeviceRecord | null): {
    detail: string;
    label: string;
    tone: Tone;
  } {
    const status = statusFor(device);
    if (!device || !deviceIsLive(device)) {
      return {
        detail: "No live playback report is available for this saved screen.",
        label: "Not reported",
        tone: "muted"
      };
    }

    const reachable = status?.reachable ?? false;
    const playbackHealthy = status?.playbackHealthy ?? false;
    const playbackLabel = status?.playbackLabel ?? "unknown";
    const stale = status?.stale ?? false;
    if (!reachable) {
      return {
        detail: "Playback may continue locally, but Beam cannot verify it until the screen is reachable.",
        label: "Not available",
        tone: "warn"
      };
    }

    if (playbackHealthy) {
      return {
        detail: "Latest local report says playback is running.",
        label: "Playing",
        tone: "good"
      };
    }

    return {
      detail: stale
        ? "The last playing report is old. Playback may still be running locally."
        : "Beam has not confirmed playback yet.",
      label: plainPlaybackLabel(playbackLabel),
      tone: "warn"
    };
  }

  function syncStatus(screen: ScreenRecord, device: DeviceRecord | null): {
    detail: string;
    label: string;
    tone: Tone;
  } {
    const assignedPlaylist = screen.playlistId ? playlistsById.get(screen.playlistId) : null;

    if (!screen.playlistId) {
      return {
        detail: "Choose a playlist for this screen before publishing.",
        label: "Choose playlist",
        tone: "warn"
      };
    }

    if (!assignedPlaylist) {
      return {
        detail: "This screen points to a playlist Beam cannot find locally.",
        label: "Review",
        tone: "warn"
      };
    }

    if (!device || !hasLocalAddress(device)) {
      return {
        detail: "Link a local Pi before Beam can check the screen playlist.",
        label: "Waiting",
        tone: "muted"
      };
    }

    if (!deviceIsLive(device)) {
      return {
        detail: "No live playlist report has been received for this saved screen.",
        label: "Waiting",
        tone: "muted"
      };
    }

    const status = statusFor(device);
    const reachable = status?.reachable ?? false;
    const reportedPlaylistId = status?.playerStatus?.playlistId ?? null;
    const reportedPlaylistVersion = status?.playerStatus?.playlistVersion;
    if (!reachable) {
      return {
        detail: "Beam cannot reach this screen to confirm the playlist.",
        label: "Waiting",
        tone: "muted"
      };
    }

    if (!reportedPlaylistId || reportedPlaylistVersion === undefined || reportedPlaylistVersion === null) {
      return {
        detail: "The screen has not reported a playlist update yet.",
        label: "Unknown",
        tone: "warn"
      };
    }

    if (reportedPlaylistId !== assignedPlaylist.playlistId) {
      return {
        detail: `Beam expects ${assignedPlaylist.name}; Pi reports ${playlistName(reportedPlaylistId)}. Publish required.`,
        label: "Publish required",
        tone: "warn"
      };
    }

    if (reportedPlaylistVersion === assignedPlaylist.version) {
      return {
        detail: `${assignedPlaylist.name} update ${assignedPlaylist.version} is on this screen.`,
        label: "Up to date",
        tone: "good"
      };
    }

    if (reportedPlaylistVersion < assignedPlaylist.version) {
      return {
        detail: publishRequiredDetail(assignedPlaylist.version, reportedPlaylistVersion),
        label: "Publish required",
        tone: "warn"
      };
    }

    return {
      detail: `Beam v${assignedPlaylist.version}; Pi v${reportedPlaylistVersion}. Review required.`,
      label: "Review",
      tone: "warn"
    };
  }

  function statusForDevice(device: DeviceRecord): {
    detail: string;
    label: string;
    tone: Tone;
  } {
    if (!hasLocalAddress(device)) {
      return {
        detail: "No local address saved.",
        label: "Needs setup",
        tone: "warn"
      };
    }

    const status = statusFor(device);
    if (deviceIsLive(device)) {
      const reachable = status?.reachable ?? false;
      return reachable
        ? {
            detail: "Reachable on the local network.",
            label: "Online",
            tone: "good"
          }
        : {
            detail: "Not reachable right now.",
            label: "Offline",
            tone: "warn"
          };
    }

    return {
      detail: "No live check-in for this saved Pi.",
      label: "Not reporting",
      tone: "muted"
    };
  }

  const screenRows = useMemo<ScreenRow[]>(() => {
    return screens.map((screen) => {
      const device = linkedDeviceForScreen(screen);
      const status = screenStatus(device);
      const playback = playbackStatus(device);
      const sync = syncStatus(screen, device);
      const assignedPlaylist = screen.playlistId ? playlistsById.get(screen.playlistId) ?? null : null;
      const isLive = Boolean(device && deviceIsLive(device));
      const liveStatus = statusFor(device);
      const reportedPlaylistId = liveStatus?.playerStatus?.playlistId ?? null;
      const reportedPlaylistVersion = liveStatus?.playerStatus?.playlistVersion ?? null;
      const devicePlaylistLine =
        device?.playlistId && device.playlistId !== screen.playlistId
          ? `Pi saved as ${playlistName(device.playlistId)}.`
          : null;
      const currentPlaylistLine =
        isLive && reportedPlaylistId
          ? `Screen reports ${playlistName(reportedPlaylistId)}${
              reportedPlaylistVersion === null || reportedPlaylistVersion === undefined ? "" : ` update ${reportedPlaylistVersion}`
            }.`
          : "No current playlist report.";

      return {
        assignedPlaylist,
        assignedPlaylistId: screen.playlistId ?? null,
        currentPlaylistLine,
        device,
        devicePlaylistLine,
        isLive,
        lastSeenAge: isLive ? liveStatus?.ageLabel ?? "No timestamp" : "Not seen yet",
        lastSeenFull: isLive ? liveStatus?.timestampLabel ?? "No timestamp available" : "No live report yet",
        lastSeenSort: sortableTimestamp(liveStatus?.playerStatus?.updatedAt),
        needsAttention:
          status.tone === "warn" ||
          playback.tone === "warn" ||
          sync.tone === "warn",
        playbackDetail: playback.detail,
        playbackLabel: playback.label,
        playbackTone: playback.tone,
        screen,
        statusDetail: status.detail,
        statusLabel: status.label,
        statusTone: status.tone,
        syncDetail: sync.detail,
        syncLabel: sync.label,
        syncTone: sync.tone
      };
    });
  }, [
    devicesById,
    devicesByScreenId,
    playlistsById,
    screens,
  ]);
  const sortedScreenRows = useMemo(() => sortScreenRows(screenRows, screenSort), [screenRows, screenSort]);

  const linkedDeviceIds = useMemo(() => {
    const next = new Set<string>();
    for (const screen of screens) {
      const device = linkedDeviceForScreen(screen);
      if (device) {
        next.add(device.id);
      }
    }
    return next;
  }, [screens, devicesById, devicesByScreenId]);

  const unlinkedDevices = devices.filter((device) => !linkedDeviceIds.has(device.id));
  const onlineCount = screenRows.filter((row) => row.statusLabel === "Online").length;
  const playingCount = screenRows.filter((row) => row.playbackLabel === "Playing").length;
  const assignedCount = screenRows.filter((row) => row.assignedPlaylistId).length;
  const upToDateCount = screenRows.filter((row) => row.syncLabel === "Up to date").length;
  const attentionCount = screenRows.filter((row) => row.needsAttention).length;

  function changeScreenSort(key: ScreenSortKey) {
    setScreenSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "lastSeen" ? "desc" : "asc" }
    );
  }

  function screenSortLabel(key: ScreenSortKey): string {
    if (screenSort.key !== key) {
      return "sortable";
    }

    return screenSort.direction === "asc" ? "sorted ascending" : "sorted descending";
  }

  function renderScreenSortHeader(key: ScreenSortKey, label: string, className = "px-4 py-3") {
    const active = screenSort.key === key;
    const directionLabel = screenSort.direction === "asc" ? "A-Z" : "Z-A";

    return (
      <th className={className} aria-sort={active ? (screenSort.direction === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          onClick={() => changeScreenSort(key)}
          className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-left font-semibold uppercase text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-teal-500"
          aria-label={`Sort by ${label}, ${screenSortLabel(key)}`}
        >
          <span>{label}</span>
          <span className={active ? "text-[10px] text-teal-800" : "text-[10px] text-zinc-400"}>
            {active ? directionLabel : "Sort"}
          </span>
        </button>
      </th>
    );
  }

  async function publishPlaylistForScreen(row: ScreenRow) {
    if (isBusy || !row.assignedPlaylistId) {
      return;
    }

    setIsSaving(true);
    setPublishingScreenId(row.screen.id);
    setMessage(`Publishing ${row.assignedPlaylist?.name ?? "playlist"} to ${row.screen.name}...`);
    try {
      const response = await fetch("/api/local-playlist/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ playlistId: row.assignedPlaylistId, screenId: row.screen.id })
      });
      const result = (await response.json()) as PublishResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Publish failed.");
      }

      setMessage(result.piPublish?.message ?? result.message ?? "Publish sent.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Publish failed.");
    } finally {
      setPublishingScreenId(null);
      setIsSaving(false);
    }
  }

  async function loadInventory() {
    setIsLoading(true);
    try {
      const response = await fetch("/api/local-inventory", {
        cache: "no-store",
        method: "GET"
      });
      const result = (await response.json()) as InventoryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not load screens.");
      }
      setInventory(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load screens.");
      setInventory(null);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadInventory();
  }, []);

  async function postInventory(body: unknown) {
    const response = await fetch("/api/local-inventory", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const result = (await response.json()) as InventoryResponse;
    if (!response.ok || result.error) {
      throw new Error(result.error ?? "Inventory update failed.");
    }
    setInventory(result);
  }

  async function removeInventory(targetType: "screen" | "device", id: string, label: string) {
    if (isBusy) {
      return;
    }

    const confirmed = window.confirm(
      targetType === "screen"
        ? `Remove ${label}? Its linked Pi record will be removed too. Media and playlists stay saved.`
        : `Remove ${label}? Screens, media, and playlists stay saved.`
    );
    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    setMessage(`Removing ${label}...`);
    try {
      const response = await fetch("/api/local-inventory", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ id, targetType })
      });
      const result = (await response.json()) as InventoryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not remove this item.");
      }
      setInventory(result);
      setMessage(`${label} removed.`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove this item.");
    } finally {
      setIsSaving(false);
    }
  }

  async function renameScreen(screen: ScreenRecord) {
    if (isBusy) {
      return;
    }

    const nextName = window.prompt("Rename screen", screen.name)?.trim();
    if (!nextName || nextName === screen.name) {
      return;
    }

    setIsSaving(true);
    setMessage(`Renaming ${screen.name}...`);
    try {
      const response = await fetch("/api/local-inventory", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: screen.id,
          name: nextName,
          targetType: "screen"
        })
      });
      const result = (await response.json()) as InventoryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not rename this screen.");
      }
      setInventory(result);
      setMessage(`${nextName} renamed.`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not rename this screen.");
    } finally {
      setIsSaving(false);
    }
  }

  async function savePlaylistAssignment(
    targetType: "screen" | "device",
    targetId: string,
    nextPlaylistId: string | null
  ) {
    if (isBusy) {
      return;
    }

    setIsSaving(true);
    setMessage(nextPlaylistId ? "Saving playlist assignment..." : "Removing playlist assignment...");
    try {
      const response = await fetch("/api/local-playlist/assign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          assigned: Boolean(nextPlaylistId),
          playlistId: nextPlaylistId ?? playlistId,
          targetId,
          targetType
        })
      });
      const result = (await response.json()) as InventoryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not save playlist assignment.");
      }
      setInventory(result);
      setMessage("Playlist assignment saved.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save playlist assignment.");
    } finally {
      setIsSaving(false);
    }
  }

  async function addScreen(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }
    if (!screenName.trim() || !deviceHost.trim()) {
      setMessage("Screen name and Pi address are required.");
      return;
    }

    setIsSaving(true);
    setMessage("Adding screen...");
    try {
      await postInventory({
        group: screenGroup,
        host: deviceHost,
        location: screenLocation,
        name: screenName,
        playlistId,
        sshUser: deviceSshUser,
        targetType: "screen"
      });
      setScreenName("");
      setScreenLocation("");
      setScreenGroup("");
      setDeviceHost("");
      setDeviceSshUser("donnoel");
      setMessage("Screen added with its linked Pi.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add screen.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-xl font-semibold">Screen operations</h3>
            <p className="mt-1 text-sm text-zinc-600">
              {formatCount(screenRows.length, "screen")} saved locally.
            </p>
          </div>
          <div className="self-start">
            <StatusPill
              label={attentionCount === 0 ? "No open issues" : `${attentionCount} need attention`}
              tone={attentionCount === 0 ? "good" : "warn"}
            />
          </div>
        </div>

        <div className="p-4">
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-2">
            <div className="rounded-md bg-emerald-50 p-3 ring-1 ring-emerald-100">
              <dt className="text-xs font-semibold uppercase text-emerald-800">Online</dt>
              <dd className="mt-1 text-xl font-semibold">{onlineCount}</dd>
            </div>
            <div className="rounded-md bg-sky-50 p-3 ring-1 ring-sky-100">
              <dt className="text-xs font-semibold uppercase text-sky-800">Playing</dt>
              <dd className="mt-1 text-xl font-semibold">{playingCount}</dd>
            </div>
            <div className="rounded-md bg-teal-50 p-3 ring-1 ring-teal-100">
              <dt className="text-xs font-semibold uppercase text-teal-800">Assigned</dt>
              <dd className="mt-1 text-xl font-semibold">{assignedCount}</dd>
            </div>
            <div className="rounded-md bg-indigo-50 p-3 ring-1 ring-indigo-100">
              <dt className="text-xs font-semibold uppercase text-indigo-800">Up to date</dt>
              <dd className="mt-1 text-xl font-semibold">{upToDateCount}</dd>
            </div>
            <div className="rounded-md bg-amber-50 p-3 ring-1 ring-amber-100">
              <dt className="text-xs font-semibold uppercase text-amber-900">Needs attention</dt>
              <dd className="mt-1 text-xl font-semibold">{attentionCount}</dd>
            </div>
          </dl>
        </div>

        <div className="max-w-full overflow-x-auto border-t border-zinc-200">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                {renderScreenSortHeader("screen", "Screen")}
                {renderScreenSortHeader("playlist", "Playlist")}
                {renderScreenSortHeader("status", "Status")}
                {renderScreenSortHeader("playback", "Now playing")}
                {renderScreenSortHeader("sync", "Sync")}
                {renderScreenSortHeader("device", "Device")}
                {renderScreenSortHeader("lastSeen", "Last seen")}
                <th className="px-4 py-3 min-w-[168px]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {sortedScreenRows.map((row) => (
                <tr key={row.screen.id} className={row.needsAttention ? "bg-amber-50/35" : undefined}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-zinc-950">{row.screen.name}</p>
                    <p className="mt-1 text-xs text-zinc-600">
                      {row.screen.location} · {row.screen.group}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <label htmlFor={`screen-playlist-${row.screen.id}`} className="sr-only">
                      Playlist for {row.screen.name}
                    </label>
                    <select
                      id={`screen-playlist-${row.screen.id}`}
                      value={row.assignedPlaylistId ?? ""}
                      disabled={isBusy}
                      onChange={(event) => {
                        void savePlaylistAssignment("screen", row.screen.id, event.currentTarget.value || null);
                      }}
                      className="min-h-10 w-full min-w-48 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-100"
                    >
                      <option value="">No playlist</option>
                      {row.assignedPlaylistId && !row.assignedPlaylist ? (
                        <option value={row.assignedPlaylistId}>Playlist not found</option>
                      ) : null}
                      {playlists.map((option) => (
                        <option key={option.playlistId} value={option.playlistId}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-zinc-600">
                      {row.assignedPlaylist
                        ? `${formatCount(row.assignedPlaylist.assetCount, "item")} · update ${row.assignedPlaylist.version}`
                        : "Choose a saved playlist."}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span title={row.statusDetail}>
                      <StatusPill label={row.statusLabel} tone={row.statusTone} />
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span title={row.playbackDetail}>
                      <StatusPill label={row.playbackLabel} tone={row.playbackTone} />
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {row.syncLabel === "Publish required" && row.assignedPlaylistId ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void publishPlaylistForScreen(row)}
                        title={row.syncDetail}
                        aria-label={`Publish ${row.assignedPlaylist?.name ?? "playlist"} to ${row.screen.name}`}
                        className="inline-flex whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-200 hover:bg-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {publishingScreenId === row.screen.id ? "Publishing..." : row.syncLabel}
                      </button>
                    ) : (
                      <span title={row.syncDetail}>
                        <StatusPill label={row.syncLabel} tone={row.syncTone} />
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <p className="break-words font-semibold text-zinc-950" title={piLabel(row.device, row.screen)}>
                      {row.device?.host ?? "Add device"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="whitespace-nowrap font-semibold text-zinc-950" title={row.lastSeenFull}>{row.lastSeenAge}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex min-w-[152px] flex-nowrap gap-2">
                      <a
                        href={`/?view=device-health&screen=${encodeURIComponent(row.screen.id)}`}
                        title="Status"
                        aria-label={`Open status for ${row.screen.name}`}
                        className={`inline-flex h-9 w-9 items-center justify-center rounded-md border bg-white text-base font-semibold ${screenActionClass("neutral")}`}
                      >
                        <ScreenActionIcon name="status" />
                      </a>
                      {row.assignedPlaylistId ? (
                        <a
                          href={`/?view=playlist&playlist=${encodeURIComponent(row.assignedPlaylistId)}`}
                          title="Playlist"
                          aria-label={`Open playlist for ${row.screen.name}`}
                          className={`inline-flex h-9 w-9 items-center justify-center rounded-md border bg-white text-base font-semibold ${screenActionClass("primary")}`}
                        >
                          <ScreenActionIcon name="playlist" />
                        </a>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void renameScreen(row.screen)}
                        disabled={isBusy}
                        title="Rename"
                        aria-label={`Rename ${row.screen.name}`}
                        className={`inline-flex h-9 w-9 items-center justify-center rounded-md border bg-white text-base font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${screenActionClass("neutral")}`}
                      >
                        <ScreenActionIcon name="rename" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeInventory("screen", row.screen.id, row.screen.name)}
                        disabled={isBusy}
                        title="Remove"
                        aria-label={`Remove ${row.screen.name}`}
                        className={`inline-flex h-9 w-9 items-center justify-center rounded-md border bg-white text-lg font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${screenActionClass("danger")}`}
                      >
                        <ScreenActionIcon name="remove" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {screenRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-5 text-zinc-600" colSpan={8}>
                    No screens saved yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <details className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <summary className="cursor-pointer border-b border-zinc-200 p-5 text-lg font-semibold">
          Add screen
        </summary>
        <div className="p-5">
          <form onSubmit={addScreen} className="grid gap-4 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <h3 className="text-base font-semibold">Add a screen and linked Pi</h3>
              <p className="mt-1 text-sm text-zinc-600">
                Beam saves one screen record and one linked local Pi record for health checks.
              </p>
            </div>
            <label className="block text-sm font-semibold text-zinc-700">
              Screen name
              <input
                value={screenName}
                onChange={(event) => setScreenName(event.currentTarget.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
            </label>
            <label className="block text-sm font-semibold text-zinc-700">
              Pi local address or IP
              <input
                value={deviceHost}
                onChange={(event) => setDeviceHost(event.currentTarget.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
            </label>
            <label className="block text-sm font-semibold text-zinc-700">
              SSH user
              <input
                value={deviceSshUser}
                onChange={(event) => setDeviceSshUser(event.currentTarget.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
            </label>
            <label className="block text-sm font-semibold text-zinc-700">
              Location
              <input
                value={screenLocation}
                onChange={(event) => setScreenLocation(event.currentTarget.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
            </label>
            <label className="block text-sm font-semibold text-zinc-700">
              Group
              <input
                value={screenGroup}
                onChange={(event) => setScreenGroup(event.currentTarget.value)}
                className="mt-1 min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
            </label>
            <div className="lg:col-span-2">
              <button
                type="submit"
                disabled={isBusy}
                className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                Add screen
              </button>
            </div>
          </form>
        </div>
      </details>

      <details className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <summary className="cursor-pointer border-b border-zinc-200 p-5 text-lg font-semibold">
          Pi details
        </summary>
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3">Pi</th>
                <th className="px-4 py-3">Linked screen</th>
                <th className="px-4 py-3">Local address</th>
                <th className="px-4 py-3">Saved playlist</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {devices.map((device) => {
                const linkedScreen = screens.find(
                  (screen) => screen.deviceId === device.id || device.screenId === screen.id
                );
                const status = statusForDevice(device);
                return (
                  <tr key={device.id}>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-zinc-950">{piLabel(device, linkedScreen)}</p>
                      <p className="mt-1 text-xs text-zinc-600">
                        {device.location} · {device.group}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {linkedScreen?.name ?? (unlinkedDevices.some((item) => item.id === device.id) ? "No screen linked" : "Linked")}
                    </td>
                    <td className="px-4 py-3">
                      <p className="break-words text-zinc-700">{device.host}</p>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">{playlistName(device.playlistId)}</td>
                    <td className="px-4 py-3">
                      <StatusPill label={status.label} tone={status.tone} />
                      <p className="mt-1 text-xs text-zinc-600">{status.detail}</p>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void removeInventory("device", device.id, device.name)}
                        disabled={isBusy}
                        className="min-h-9 rounded-md border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {devices.length === 0 ? (
                <tr>
                  <td className="px-4 py-5 text-zinc-600" colSpan={6}>
                    No Pi records saved yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </details>

      {message ? (
        <p className="text-sm font-medium text-zinc-700" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
