"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "./dashboard-ui";

type ScreenRecord = {
  deviceId: string | null;
  group: string;
  id: string;
  location: string;
  name: string;
  playlistId: string | null;
};

type DeviceRecord = {
  group: string;
  host: string;
  id: string;
  location: string;
  name: string;
  playlistId: string | null;
  screenId: string | null;
};

type Tone = "good" | "muted" | "warn";

type FleetDeviceHealthPanelProps = {
  deviceStatuses: Record<string, DeviceLiveStatus>;
  devices: DeviceRecord[];
  screens: ScreenRecord[];
  liveHost: string | null;
  livePlayerUrl: string | null;
  livePlaylistId: string | null;
  livePlaybackHealthy: boolean;
  livePlaybackState: string;
  livePlaylistVersion: number | null;
  liveReachable: boolean;
  liveStatusStale: boolean;
  playlists: Array<{
    name: string;
    playlistId: string;
    version: number;
  }>;
  statusAgeLabel: string;
  statusUpdatedAt: string | null;
  statusTimestampLabel: string;
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

type FilterKey = "all" | "attention" | "offline" | "online" | "playing" | "stale" | "sync" | "waiting";

type RowState = {
  assignedPlaylistId: string | null;
  assignedPlaylistName: string;
  attentionReason: string;
  device: DeviceRecord;
  healthDetail: string;
  healthLabel: string;
  healthTone: Tone;
  isLive: boolean;
  lastSeenAge: string;
  lastSeenFull: string;
  linkedScreen: ScreenRecord | null;
  needsAttention: boolean;
  playbackDetail: string;
  playbackTone: Tone;
  playbackLabel: string;
  syncDetail: string;
  syncLabel: string;
  syncTone: Tone;
  syncVersionDetail: string;
};

type ActionResponse = {
  error?: string;
  message?: string;
  piPublish?: {
    message: string;
    ok: boolean;
  };
  playlistVersion?: number;
};

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function formatCount(count: number, label: string): string {
  return `${count} ${count === 1 ? label : `${label}s`}`;
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function deviceMatchesLiveHost(device: DeviceRecord, liveHost: string | null): boolean {
  return Boolean(liveHost && normalize(device.host) === normalize(liveHost));
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

function piLabel(device: DeviceRecord, linkedScreen: ScreenRecord | null): string {
  return linkedScreen ? `${linkedScreen.name} Pi` : device.name;
}

function playerUrlFor(row: RowState, liveHost: string | null, livePlayerUrl: string | null): string | null {
  const host = row.device.host.trim();
  if (!host) {
    return null;
  }

  return deviceMatchesLiveHost(row.device, liveHost) && livePlayerUrl
    ? livePlayerUrl
    : `http://${host}:5173/?playlist=/playlist.local.json`;
}

function sshUrlFor(row: RowState): string | null {
  const host = row.device.host.trim();
  return host ? `ssh://${host}` : null;
}

export function DeviceHealthFleetPanel({
  deviceStatuses,
  devices,
  screens,
  liveHost,
  livePlayerUrl,
  livePlaylistId,
  livePlaybackHealthy,
  livePlaybackState,
  livePlaylistVersion,
  liveReachable,
  liveStatusStale,
  playlists,
  statusAgeLabel,
  statusUpdatedAt,
  statusTimestampLabel
}: FleetDeviceHealthPanelProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(devices[0]?.id ?? null);
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState<"publish" | "reboot" | "recover" | "refresh" | "restart" | null>(null);
  const [rebootWatch, setRebootWatch] = useState<{
    baselineStatusUpdatedAt: string | null;
    deviceId: string;
    requestedAt: string;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  const isBusy = Boolean(busyAction) || isPending;

  const screensByDeviceId = useMemo(() => {
    const next = new Map<string, ScreenRecord>();
    for (const screen of screens) {
      if (screen.deviceId) {
        next.set(screen.deviceId, screen);
      }
    }
    for (const screen of screens) {
      const deviceId = devices.find((device) => device.screenId === screen.id)?.id;
      if (deviceId && !next.has(deviceId)) {
        next.set(deviceId, screen);
      }
    }
    return next;
  }, [devices, screens]);

  const playlistsById = useMemo(() => {
    return new Map(playlists.map((playlist) => [playlist.playlistId, playlist]));
  }, [playlists]);

  const rows = useMemo<RowState[]>(() => {
    return devices
      .filter((device) => screensByDeviceId.has(device.id))
      .slice()
      .sort(
        (a, b) =>
          compareText(a.group, b.group) ||
          compareText(a.location, b.location) ||
          compareText(a.name, b.name)
      )
      .map((device) => {
        const linkedScreen = screensByDeviceId.get(device.id) ?? null;
        const assignedPlaylistId = linkedScreen?.playlistId ?? device.playlistId;
        const assignedPlaylist = assignedPlaylistId ? playlistsById.get(assignedPlaylistId) : null;
        const status = deviceStatuses[device.id] ?? null;
        const isLive = Boolean(status) || deviceMatchesLiveHost(device, liveHost);
        const reachable = status?.reachable ?? liveReachable;
        const rowPlaybackHealthy = status?.playbackHealthy ?? livePlaybackHealthy;
        const rowPlaybackLabel = status?.playbackLabel ?? livePlaybackState;
        const rowStale = status?.stale ?? liveStatusStale;
        const reportedPlaylistId = status?.playerStatus?.playlistId ?? livePlaylistId;
        const reportedPlaylistVersion = status?.playerStatus?.playlistVersion ?? livePlaylistVersion;
        const hostConfigured = Boolean(device.host.trim()) && device.host !== "Not configured";
        let healthLabel = "Waiting";
        let healthDetail = "Saved in Beam, but this screen has not checked in yet.";
        let healthTone: Tone = "muted";

        if (!hostConfigured) {
          healthLabel = "Set up needed";
          healthDetail = "Add the Pi address before Beam can check this screen.";
          healthTone = "warn";
        } else if (isLive) {
          healthLabel = reachable ? "Online" : "Offline";
          healthDetail = reachable
            ? "Beam can reach this screen on the local network."
            : "Beam cannot reach this screen right now.";
          healthTone = reachable ? "good" : "warn";
        }

        let playbackLabel = "Not reported";
        let playbackDetail = "No live playback report is available for this saved screen.";
        let playbackTone: Tone = "muted";
        if (isLive && !reachable) {
          playbackLabel = "Not available";
          playbackDetail = "Playback may continue locally, but Beam cannot verify it until the screen is reachable.";
          playbackTone = "warn";
        } else if (isLive && rowPlaybackHealthy) {
          playbackLabel = "Playing";
          playbackDetail = "Beam has a fresh report that this screen is playing.";
          playbackTone = "good";
        } else if (isLive) {
          playbackLabel = plainPlaybackLabel(rowPlaybackLabel);
          playbackDetail = rowStale
            ? "The last playing report is old. Playback may still be running locally."
            : "Beam has not confirmed playback yet.";
          playbackTone = "warn";
        }

        let syncLabel = "Waiting";
        let syncDetail = "No playlist update report has been received from this screen yet.";
        let syncTone: Tone = "muted";

        if (!assignedPlaylistId) {
          syncLabel = "Choose playlist";
          syncDetail = "Assign a playlist before publishing to this screen.";
          syncTone = "warn";
        } else if (!assignedPlaylist) {
          syncLabel = "Review";
          syncDetail = "This screen points to a playlist Beam cannot find locally.";
          syncTone = "warn";
        } else if (isLive && reachable && reportedPlaylistVersion !== null && reportedPlaylistVersion !== undefined && reportedPlaylistId) {
          if (reportedPlaylistId !== assignedPlaylist.playlistId) {
            syncLabel = "Publish required";
            syncDetail = `Beam expects ${assignedPlaylist.name}; Pi reports another playlist. Publish required.`;
            syncTone = "warn";
          } else if (reportedPlaylistVersion === assignedPlaylist.version) {
            syncLabel = "Up to date";
            syncDetail = `${assignedPlaylist.name} is on the screen.`;
            syncTone = "good";
          } else {
            syncLabel = reportedPlaylistVersion < assignedPlaylist.version ? "Publish required" : "Review";
            syncDetail =
              reportedPlaylistVersion < assignedPlaylist.version
                ? publishRequiredDetail(assignedPlaylist.version, reportedPlaylistVersion)
                : `Beam v${assignedPlaylist.version}; Pi v${reportedPlaylistVersion}. Review required.`;
            syncTone = "warn";
          }
        }

        const isOffline = isLive && !reachable;
        const isStale = isLive && rowStale;
        const needsAttention =
          !hostConfigured ||
          isOffline ||
          isStale ||
          syncTone === "warn" ||
          (isLive && !rowPlaybackHealthy);
        const attentionReason = !hostConfigured
          ? "setup needed"
          : isOffline
            ? "screen offline"
            : isStale
              ? "stale report"
              : syncTone === "warn"
                ? "sync needed"
                : isLive && !rowPlaybackHealthy
                  ? "playback not confirmed"
                  : "no action needed";

        return {
          device,
          assignedPlaylistId: assignedPlaylistId ?? null,
          assignedPlaylistName: assignedPlaylist?.name ?? "No playlist assigned",
          attentionReason,
          healthDetail,
          healthLabel,
          healthTone,
          isLive,
          lastSeenAge: isLive ? status?.ageLabel ?? statusAgeLabel : "Not seen yet",
          lastSeenFull: isLive ? status?.timestampLabel ?? statusTimestampLabel : "No live report yet",
          linkedScreen,
          needsAttention,
          playbackDetail,
          playbackLabel,
          playbackTone,
          syncDetail,
          syncLabel,
          syncTone,
          syncVersionDetail: assignedPlaylist
            ? `Beam v${assignedPlaylist.version}; screen ${
                isLive && reportedPlaylistVersion !== null && reportedPlaylistVersion !== undefined ? `v${reportedPlaylistVersion}` : "unknown"
              }.`
            : "No playlist version is available."
        };
      });
  }, [
    devices,
    deviceStatuses,
    liveHost,
    livePlaylistId,
    livePlaybackHealthy,
    livePlaybackState,
    livePlaylistVersion,
    liveReachable,
    liveStatusStale,
    playlistsById,
    screensByDeviceId,
    statusAgeLabel,
    statusTimestampLabel
  ]);

  const visibleRows = rows.filter((row) => {
    const searchable = [
      row.device.name,
      row.device.host,
      row.device.location,
      row.device.group,
      row.linkedScreen?.name ?? "",
      row.linkedScreen?.location ?? ""
    ]
      .join(" ")
      .toLowerCase();
    const matchesQuery = searchable.includes(query.trim().toLowerCase());
    if (!matchesQuery) {
      return false;
    }

    if (filter === "attention") {
      return row.needsAttention;
    }
    if (filter === "online") {
      return row.healthLabel === "Online";
    }
    if (filter === "offline") {
      return row.healthLabel === "Offline";
    }
    if (filter === "playing") {
      return row.isLive && livePlaybackHealthy;
    }
    if (filter === "stale") {
      return row.isLive && liveStatusStale;
    }
    if (filter === "sync") {
      return row.syncTone === "warn";
    }
    if (filter === "waiting") {
      return row.healthLabel === "Waiting";
    }

    return true;
  });

  const selectedRow =
    visibleRows.find((row) => row.device.id === selectedDeviceId) ?? visibleRows[0] ?? rows[0] ?? null;
  const selectedPlayerUrl = selectedRow ? playerUrlFor(selectedRow, liveHost, livePlayerUrl) : null;
  const selectedSshUrl = selectedRow ? sshUrlFor(selectedRow) : null;
  const onlineCount = rows.filter((row) => row.healthLabel === "Online").length;
  const offlineCount = rows.filter((row) => row.healthLabel === "Offline").length;
  const staleCount = rows.filter((row) => row.isLive && liveStatusStale).length;
  const playingCount = rows.filter((row) => row.isLive && livePlaybackHealthy).length;
  const attentionCount = rows.filter((row) => row.needsAttention).length;
  const syncIssueCount = rows.filter((row) => row.syncTone === "warn").length;
  const waitingCount = rows.filter((row) => row.healthLabel === "Waiting").length;
  const rebootWatchApplies = Boolean(rebootWatch && selectedRow?.device.id === rebootWatch.deviceId);
  const rebootBaselineTimestamp = rebootWatch?.baselineStatusUpdatedAt ?? rebootWatch?.requestedAt ?? null;
  const hasNewerStatusAfterReboot =
    Boolean(rebootBaselineTimestamp && statusUpdatedAt) &&
    Date.parse(statusUpdatedAt ?? "") > Date.parse(rebootBaselineTimestamp ?? "");

  useEffect(() => {
    if (!rebootWatch) {
      return;
    }

    if (rebootWatchApplies && liveReachable && hasNewerStatusAfterReboot) {
      setMessage("Pi is back online with a fresh check-in after reboot.");
      setRebootWatch(null);
      return;
    }

    const timeout = window.setTimeout(() => {
      startTransition(() => router.refresh());
    }, 10_000);

    return () => window.clearTimeout(timeout);
  }, [hasNewerStatusAfterReboot, liveReachable, rebootWatch, rebootWatchApplies, router, startTransition]);

  function refreshStatus() {
    if (isBusy) {
      return;
    }

    setBusyAction("refresh");
    setMessage("Refreshing screen status...");
    startTransition(() => {
      router.refresh();
      setBusyAction(null);
      setMessage("Screen status refreshed.");
    });
  }

  async function postJson(path: string, body?: unknown): Promise<ActionResponse> {
    const response = await fetch(path, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const result = (await response.json()) as ActionResponse;
    if (!response.ok || result.error) {
      throw new Error(result.error ?? "Action failed.");
    }

    return result;
  }

  async function runAction(action: "publish" | "reboot" | "recover" | "restart", row: RowState) {
    if (!row.isLive || isBusy) {
      return;
    }

    if (
      action === "reboot" &&
      !window.confirm(
        `Reboot ${row.linkedScreen?.name ?? row.device.name} Pi?\n\nPlayback will stop while the Pi restarts. Beam will wait for a fresh check-in after reboot.`
      )
    ) {
      return;
    }

    setBusyAction(action);
    setMessage(
      action === "publish"
        ? `Retrying playlist update for ${row.linkedScreen?.name ?? row.device.name}...`
        : action === "restart"
          ? `Restarting playback for ${row.linkedScreen?.name ?? row.device.name}...`
          : action === "reboot"
            ? `Requesting reboot for ${row.linkedScreen?.name ?? row.device.name}...`
            : `Running full recovery for ${row.linkedScreen?.name ?? row.device.name}...`
    );
    try {
      const result =
        action === "publish"
            ? await postJson("/api/local-playlist/publish", {
              deviceId: row.device.id,
              playlistId: row.linkedScreen?.playlistId ?? row.device.playlistId ?? undefined,
              screenId: row.linkedScreen?.id ?? undefined
            })
          : await postJson("/api/local-player/actions", {
              action: action === "restart" ? "restart-vlc" : action === "reboot" ? "reboot-pi" : "recover",
              deviceId: row.device.id,
              screenId: row.linkedScreen?.id ?? undefined
            });
      const publishMessage = result.piPublish?.message ? ` ${result.piPublish.message}` : "";
      if (action === "reboot") {
        setRebootWatch({
          baselineStatusUpdatedAt: statusUpdatedAt,
          deviceId: row.device.id,
          requestedAt: new Date().toISOString()
        });
      }
      setMessage(
        result.message ??
          (action === "publish"
            ? `Playlist update retried.${publishMessage}`
            : `${row.device.name} action completed.`)
      );
      startTransition(() => router.refresh());
    } catch (error) {
      if (action === "reboot") {
        setRebootWatch(null);
      }
      setMessage(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusyAction(null);
    }
  }

  const summaryCardOptions: Array<{
    count: number;
    hideWhenZero?: boolean;
    key: FilterKey;
    label: string;
    toneClassName: string;
  }> = [
    {
      count: onlineCount,
      key: "online",
      label: "Online",
      toneClassName: "bg-emerald-50 text-emerald-800 ring-emerald-100 hover:bg-emerald-100"
    },
    {
      count: offlineCount,
      key: "offline",
      label: "Offline",
      toneClassName: "bg-rose-50 text-rose-800 ring-rose-100 hover:bg-rose-100"
    },
    {
      count: staleCount,
      key: "stale",
      label: "Stale report",
      toneClassName: "bg-amber-50 text-amber-900 ring-amber-100 hover:bg-amber-100"
    },
    {
      count: playingCount,
      key: "playing",
      label: "Playing now",
      toneClassName: "bg-sky-50 text-sky-800 ring-sky-100 hover:bg-sky-100"
    },
    {
      count: attentionCount,
      key: "attention",
      label: "Needs attention",
      toneClassName: "bg-orange-50 text-orange-800 ring-orange-100 hover:bg-orange-100"
    },
    {
      count: rows.length,
      key: "all",
      label: "Saved screens",
      toneClassName: "bg-zinc-50 text-zinc-700 ring-zinc-200 hover:bg-zinc-100"
    },
    {
      count: syncIssueCount,
      hideWhenZero: true,
      key: "sync",
      label: "Publish required",
      toneClassName: "bg-yellow-50 text-yellow-900 ring-yellow-100 hover:bg-yellow-100"
    },
    {
      count: waitingCount,
      hideWhenZero: true,
      key: "waiting",
      label: "Waiting",
      toneClassName: "bg-zinc-50 text-zinc-600 ring-zinc-200 hover:bg-zinc-100"
    }
  ];
  const summaryCards = summaryCardOptions.filter((item) => !item.hideWhenZero || item.count > 0);

  return (
    <section aria-labelledby="fleet-health-heading" className="mt-6 space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-5">
          <div>
            <h2 id="fleet-health-heading" className="text-xl font-semibold">Screen Health</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Check connection, playback, playlist update, and recovery actions for each screen.
            </p>
          </div>
        </div>

        <div className="p-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-2" aria-label="Screen status filters">
            {summaryCards.map((item) => {
              const isActive = filter === item.key;

              return (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={isActive}
                  aria-label={`${item.label}: ${item.count}. ${isActive ? "Filtering list." : "Filter screen list."}`}
                  onClick={() => setFilter(item.key)}
                  className={`min-h-24 w-full rounded-md p-3 text-left ring-1 transition focus:outline-none focus:ring-2 focus:ring-teal-700 ${
                    isActive ? "bg-teal-700 text-white ring-teal-700 hover:bg-teal-800" : item.toneClassName
                  }`}
                >
                  <span className="block text-xs font-semibold uppercase">{item.label}</span>
                  <span className="mt-1 block text-xl font-semibold">{item.count}</span>
                  <span className={`mt-2 block text-xs font-medium ${isActive ? "text-teal-50" : "text-zinc-500"}`}>
                    {isActive ? "Filtering list" : item.key === "all" ? "Show all" : "Filter list"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-zinc-200 p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <h3 className="text-base font-semibold text-zinc-950">Screens and devices</h3>
              <p className="mt-1 text-sm text-zinc-600">
                Select a row to inspect actions and evidence. The list scrolls independently for larger installs.
              </p>
            </div>
            <div className="w-full xl:max-w-md">
              <label htmlFor="device-health-search" className="text-xs font-semibold uppercase text-zinc-500">
                Search screens
              </label>
              <input
                id="device-health-search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Screen, Pi, address, location, or group"
                className="mt-2 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-100"
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-zinc-600">
            Showing {formatCount(visibleRows.length, "screen")} from {formatCount(rows.length, "screen")}.
          </p>

          <div className="mt-4 max-h-[520px] overflow-auto rounded-md border border-zinc-200">
            <ol className="divide-y divide-zinc-200">
              {visibleRows.map((row) => {
                const isSelected = selectedRow?.device.id === row.device.id;

                return (
                  <li key={row.device.id}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedDeviceId(row.device.id)}
                      className={`grid w-full gap-3 px-4 py-3 text-left text-sm lg:grid-cols-[minmax(0,1fr)_220px_minmax(0,1fr)] lg:items-center ${
                        isSelected ? "bg-teal-50" : "bg-white hover:bg-zinc-50"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-zinc-950">
                          {row.linkedScreen?.name ?? "No screen linked"}
                        </span>
                        <span className="mt-1 block truncate text-xs text-zinc-600">
                          {row.linkedScreen?.location ?? row.device.location} · {row.assignedPlaylistName}
                        </span>
                      </span>
                      <span className="min-w-0 text-left lg:w-full">
                        <span className="block truncate font-semibold text-zinc-800">{piLabel(row.device, row.linkedScreen)}</span>
                        <span className="mt-1 block truncate text-xs text-zinc-600">{row.device.host}</span>
                      </span>
                      <span className="flex flex-wrap items-center justify-end gap-2 lg:justify-self-end">
                        <StatusPill label={row.healthLabel} tone={row.healthTone} />
                        <StatusPill label={row.playbackLabel} tone={row.playbackTone} />
                        <StatusPill label={row.syncLabel} tone={row.syncTone} />
                      </span>
                    </button>
                  </li>
                );
              })}
              {visibleRows.length === 0 ? (
                <li className="px-4 py-6 text-sm text-zinc-600">No screens match this view.</li>
              ) : null}
            </ol>
          </div>
        </div>

        {selectedRow ? (
          <section className="border-t border-zinc-200 p-5" aria-label="Selected screen details">
            <div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-2xl font-semibold">{selectedRow.linkedScreen?.name ?? selectedRow.device.name}</h3>
                  <p className="mt-1 text-sm text-zinc-600">
                    Pi {selectedRow.device.host} / {selectedRow.linkedScreen?.location ?? selectedRow.device.location}
                  </p>
                </div>
                <StatusPill
                  label={selectedRow.needsAttention ? `Needs attention: ${selectedRow.attentionReason}` : "Looks good"}
                  tone={selectedRow.needsAttention ? "warn" : "good"}
                />
              </div>

              <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-md bg-zinc-50 p-4">
                  <dt className="text-xs font-semibold uppercase text-zinc-500">Screen status</dt>
                  <dd className="mt-2 font-semibold text-zinc-950">{selectedRow.healthLabel}</dd>
                  <dd className="mt-1 text-sm text-zinc-600">{selectedRow.healthDetail}</dd>
                </div>
                <div className="rounded-md bg-zinc-50 p-4">
                  <dt className="text-xs font-semibold uppercase text-zinc-500">Now playing</dt>
                  <dd className="mt-2 font-semibold text-zinc-950">{selectedRow.playbackLabel}</dd>
                  <dd className="mt-1 text-sm text-zinc-600">{selectedRow.playbackDetail}</dd>
                </div>
                <div
                  className={`rounded-md p-4 ${
                    selectedRow.syncTone === "warn" ? "bg-amber-50 ring-1 ring-amber-100" : "bg-zinc-50"
                  }`}
                >
                  <dt className={`text-xs font-semibold uppercase ${selectedRow.syncTone === "warn" ? "text-amber-800" : "text-zinc-500"}`}>Playlist update</dt>
                  <dd className="mt-2 font-semibold text-zinc-950">{selectedRow.syncLabel}</dd>
                  <dd className="mt-1 text-sm text-zinc-700">{selectedRow.syncDetail}</dd>
                </div>
                <div className="rounded-md bg-zinc-50 p-4">
                  <dt className="text-xs font-semibold uppercase text-zinc-500">Last check-in</dt>
                  <dd className="mt-2 font-semibold text-zinc-950">{selectedRow.lastSeenAge}</dd>
                  <dd className="mt-1 text-sm text-zinc-600">{selectedRow.isLive ? selectedRow.lastSeenFull : "No live report yet."}</dd>
                </div>
              </dl>

              <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-4">
                <h4 className="text-sm font-semibold text-zinc-950">Actions for this screen</h4>
                <p className="mt-1 text-sm text-zinc-600">
                  Retry sync sends the saved playlist again. Playback controls use the connected local Pi.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!selectedRow.isLive || !selectedRow.assignedPlaylistId || isBusy}
                    onClick={() => void runAction("publish", selectedRow)}
                    className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                  >
                    {busyAction === "publish" ? "Syncing..." : "Retry sync"}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={refreshStatus}
                    className="min-h-10 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyAction === "refresh" ? "Refreshing..." : "Refresh status"}
                  </button>
                  <button
                    type="button"
                    disabled={!selectedRow.isLive || isBusy}
                    onClick={() => void runAction("restart", selectedRow)}
                    className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyAction === "restart" ? "Restarting..." : "Restart playback"}
                  </button>
                  <button
                    type="button"
                    disabled={!selectedRow.isLive || isBusy}
                    onClick={() => void runAction("recover", selectedRow)}
                    className="min-h-10 rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyAction === "recover" ? "Recovering..." : "Run full recovery"}
                  </button>
                  {selectedPlayerUrl ? (
                    <a
                      href={selectedPlayerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-10 items-center rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-800"
                    >
                      Open Pi player
                    </a>
                  ) : null}
                  {selectedSshUrl ? (
                    <a
                      href={selectedSshUrl}
                      className="inline-flex min-h-10 items-center rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50"
                    >
                      Open SSH
                    </a>
                  ) : null}
                  <button
                    type="button"
                    disabled={!selectedRow.isLive || isBusy}
                    onClick={() => void runAction("reboot", selectedRow)}
                    className="min-h-10 rounded-md border border-amber-200 bg-white px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyAction === "reboot" ? "Rebooting..." : "Reboot Pi"}
                  </button>
                </div>
                {rebootWatchApplies ? (
                  <p className="mt-3 text-sm font-medium text-amber-800" role="status" aria-live="polite">
                    Waiting for a fresh check-in after reboot. Last check-in: {selectedRow.lastSeenAge}.
                  </p>
                ) : null}
              </div>

              <details className="mt-4 rounded-md border border-zinc-200 bg-white p-4">
                <summary className="cursor-pointer text-sm font-semibold text-zinc-900">More details</summary>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
                  <div>
                    <dt className="font-semibold text-zinc-500">Pi address</dt>
                    <dd className="mt-1 break-words text-zinc-800">{selectedRow.device.host}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-zinc-500">Group</dt>
                    <dd className="mt-1 break-words text-zinc-800">{selectedRow.linkedScreen?.group ?? selectedRow.device.group}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-zinc-500">Assigned playlist</dt>
                    <dd className="mt-1 break-words text-zinc-800">{selectedRow.assignedPlaylistName}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-zinc-500">Playlist versions</dt>
                    <dd className="mt-1 break-words text-zinc-800">{selectedRow.syncVersionDetail}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-zinc-500">Live target</dt>
                    <dd className="mt-1 break-words text-zinc-800">{selectedRow.isLive ? "Configured Pi" : "Inventory only"}</dd>
                  </div>
                </dl>
              </details>
            </div>
          </section>
        ) : null}

      </div>

      {message ? (
        <p className="text-sm font-medium text-zinc-700" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </section>
  );
}
