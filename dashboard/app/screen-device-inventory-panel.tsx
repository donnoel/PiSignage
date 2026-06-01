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

type InventoryPanelProps = {
  liveHost: string | null;
  livePlaybackHealthy: boolean;
  livePlaybackState: string;
  livePlaylistId: string | null;
  livePlaylistVersion: number | null;
  liveReachable: boolean;
  liveStatusStale: boolean;
  playlistId: string;
  playlists: PlaylistOption[];
  statusAgeLabel: string;
  statusTimestampLabel: string;
};

type ScreenActionTone = "danger" | "neutral" | "primary";

type ScreenRow = {
  assignedPlaylist: PlaylistOption | null;
  assignedPlaylistId: string | null;
  currentPlaylistLine: string;
  device: DeviceRecord | null;
  devicePlaylistLine: string | null;
  isLive: boolean;
  lastSeenAge: string;
  lastSeenFull: string;
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

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
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
  liveHost,
  livePlaybackHealthy,
  livePlaybackState,
  livePlaylistId,
  livePlaylistVersion,
  liveReachable,
  liveStatusStale,
  playlistId,
  playlists,
  statusAgeLabel,
  statusTimestampLabel
}: InventoryPanelProps) {
  const router = useRouter();
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [message, setMessage] = useState("Loading screens...");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [screenName, setScreenName] = useState("");
  const [screenLocation, setScreenLocation] = useState("");
  const [screenGroup, setScreenGroup] = useState("");
  const [deviceHost, setDeviceHost] = useState("");
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
    return Boolean(liveHost && normalized(device.host) === normalized(liveHost));
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

    if (deviceIsLive(device)) {
      return liveReachable
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
    if (!device || !deviceIsLive(device)) {
      return {
        detail: "No live playback report is available for this saved screen.",
        label: "Not reported",
        tone: "muted"
      };
    }

    if (!liveReachable) {
      return {
        detail: "Playback may continue locally, but Beam cannot verify it until the screen is reachable.",
        label: "Not available",
        tone: "warn"
      };
    }

    if (livePlaybackHealthy) {
      return {
        detail: "Latest local report says playback is running.",
        label: "Playing",
        tone: "good"
      };
    }

    return {
      detail: liveStatusStale
        ? "The last playing report is old. Playback may still be running locally."
        : "Beam has not confirmed playback yet.",
      label: plainPlaybackLabel(livePlaybackState),
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

    if (!liveReachable) {
      return {
        detail: "Beam cannot reach this screen to confirm the playlist.",
        label: "Waiting",
        tone: "muted"
      };
    }

    if (!livePlaylistId || livePlaylistVersion === null) {
      return {
        detail: "The screen has not reported a playlist update yet.",
        label: "Unknown",
        tone: "warn"
      };
    }

    if (livePlaylistId !== assignedPlaylist.playlistId) {
      return {
        detail: `Assigned to ${assignedPlaylist.name}, but the screen reports ${playlistName(livePlaylistId)}.`,
        label: "Sync needed",
        tone: "warn"
      };
    }

    if (livePlaylistVersion === assignedPlaylist.version) {
      return {
        detail: `${assignedPlaylist.name} update ${assignedPlaylist.version} is on this screen.`,
        label: "Up to date",
        tone: "good"
      };
    }

    if (livePlaylistVersion < assignedPlaylist.version) {
      return {
        detail: `Beam has update ${assignedPlaylist.version}; the screen reports update ${livePlaylistVersion}.`,
        label: "Sync needed",
        tone: "warn"
      };
    }

    return {
      detail: `The screen reports update ${livePlaylistVersion}; Beam has update ${assignedPlaylist.version}.`,
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

    if (deviceIsLive(device)) {
      return liveReachable
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
      const devicePlaylistLine =
        device?.playlistId && device.playlistId !== screen.playlistId
          ? `Pi saved as ${playlistName(device.playlistId)}.`
          : null;
      const currentPlaylistLine =
        isLive && livePlaylistId
          ? `Screen reports ${playlistName(livePlaylistId)}${
              livePlaylistVersion === null ? "" : ` update ${livePlaylistVersion}`
            }.`
          : "No current playlist report.";

      return {
        assignedPlaylist,
        assignedPlaylistId: screen.playlistId ?? null,
        currentPlaylistLine,
        device,
        devicePlaylistLine,
        isLive,
        lastSeenAge: isLive ? statusAgeLabel : "Not seen yet",
        lastSeenFull: isLive ? statusTimestampLabel : "No live report yet",
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
    liveHost,
    livePlaylistId,
    livePlaylistVersion,
    livePlaybackHealthy,
    livePlaybackState,
    liveReachable,
    liveStatusStale,
    playlistsById,
    screens,
    statusAgeLabel,
    statusTimestampLabel
  ]);

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
      setMessage("Screens loaded.");
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
        targetType: "screen"
      });
      setScreenName("");
      setScreenLocation("");
      setScreenGroup("");
      setDeviceHost("");
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

        <div className="overflow-x-auto p-4">
          <dl className="grid min-w-[520px] grid-cols-5 gap-2">
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
                <th className="px-4 py-3">Screen</th>
                <th className="px-4 py-3">Playlist</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Now playing</th>
                <th className="px-4 py-3">Sync</th>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Last seen</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {screenRows.map((row) => (
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
                    <span title={row.syncDetail}>
                      <StatusPill label={row.syncLabel} tone={row.syncTone} />
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <p className="break-words font-semibold text-zinc-950" title={piLabel(row.device, row.screen)}>
                      {row.device?.host ?? "Add device"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-zinc-950" title={row.lastSeenFull}>{row.lastSeenAge}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={`/?view=device-health&screen=${encodeURIComponent(row.screen.id)}`}
                        title="Status"
                        aria-label={`Open status for ${row.screen.name}`}
                        className={`inline-flex h-10 w-10 items-center justify-center rounded-md border bg-white text-base font-semibold ${screenActionClass("neutral")}`}
                      >
                        i
                      </a>
                      {row.assignedPlaylistId ? (
                        <a
                          href={`/?view=playlist&playlist=${encodeURIComponent(row.assignedPlaylistId)}`}
                          title="Playlist"
                          aria-label={`Open playlist for ${row.screen.name}`}
                          className={`inline-flex h-10 w-10 items-center justify-center rounded-md border bg-white text-base font-semibold ${screenActionClass("primary")}`}
                        >
                          ≡
                        </a>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void renameScreen(row.screen)}
                        disabled={isBusy}
                        title="Rename"
                        aria-label={`Rename ${row.screen.name}`}
                        className={`inline-flex h-10 w-10 items-center justify-center rounded-md border bg-white text-base font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${screenActionClass("neutral")}`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeInventory("screen", row.screen.id, row.screen.name)}
                        disabled={isBusy}
                        title="Remove"
                        aria-label={`Remove ${row.screen.name}`}
                        className={`inline-flex h-10 w-10 items-center justify-center rounded-md border bg-white text-lg font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${screenActionClass("danger")}`}
                      >
                        ×
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
