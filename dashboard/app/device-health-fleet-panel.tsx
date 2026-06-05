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
  playlists: Array<{
    name: string;
    playlistId: string;
    version: number;
  }>;
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

type FilterKey = "all" | "attention" | "offline" | "online" | "stale" | "sync" | "waiting";
type SortDirection = "asc" | "desc";
type SortKey = "action" | "lastSeen" | "playlist" | "screen" | "status";

type RowState = {
  assignedPlaylistId: string | null;
  assignedPlaylistName: string;
  attentionReason: string;
  device: DeviceRecord;
  nextActionDetail: string;
  nextActionLabel: string;
  nextActionTone: Tone;
  healthDetail: string;
  healthLabel: string;
  healthTone: Tone;
  isLive: boolean;
  lastSeenAge: string;
  lastSeenFull: string;
  lastSeenSortValue: number;
  lastStatusUpdatedAt: string | null;
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

function compareNullableNumber(left: number, right: number): number {
  if (left === right) {
    return 0;
  }

  if (left === 0) {
    return 1;
  }

  if (right === 0) {
    return -1;
  }

  return left - right;
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

function screenName(row: RowState): string {
  return row.linkedScreen?.name ?? row.device.name;
}

function statusSortRank(row: RowState): number {
  if (row.healthLabel === "Offline") {
    return 0;
  }

  if (row.healthLabel === "Set up needed") {
    return 1;
  }

  if (row.healthLabel === "Waiting") {
    return 2;
  }

  return 3;
}

function actionSortRank(row: RowState): number {
  if (row.nextActionTone === "warn") {
    return 0;
  }

  if (row.nextActionTone === "muted") {
    return 1;
  }

  return 2;
}

function compareRows(left: RowState, right: RowState, sortKey: SortKey): number {
  if (sortKey === "status") {
    return (
      statusSortRank(left) - statusSortRank(right) ||
      compareText(left.healthLabel, right.healthLabel) ||
      compareText(screenName(left), screenName(right))
    );
  }

  if (sortKey === "playlist") {
    return (
      compareText(left.assignedPlaylistName, right.assignedPlaylistName) ||
      compareText(left.syncLabel, right.syncLabel) ||
      compareText(screenName(left), screenName(right))
    );
  }

  if (sortKey === "action") {
    return (
      actionSortRank(left) - actionSortRank(right) ||
      compareText(left.nextActionLabel, right.nextActionLabel) ||
      compareText(screenName(left), screenName(right))
    );
  }

  if (sortKey === "lastSeen") {
    return compareNullableNumber(left.lastSeenSortValue, right.lastSeenSortValue) || compareText(screenName(left), screenName(right));
  }

  return compareText(screenName(left), screenName(right));
}

function rowActionFor(input: {
  healthLabel: string;
  hostConfigured: boolean;
  isLive: boolean;
  isOffline: boolean;
  isStale: boolean;
  rowPlaybackHealthy: boolean;
  syncLabel: string;
  syncTone: Tone;
}): { detail: string; label: string; tone: Tone } {
  if (!input.hostConfigured) {
    return {
      detail: "Add the Pi address in Screens before Beam can check it.",
      label: "Add Pi address",
      tone: "warn"
    };
  }

  if (input.syncLabel === "Choose playlist") {
    return {
      detail: "Assign a playlist before publishing to this screen.",
      label: "Assign playlist",
      tone: "warn"
    };
  }

  if (input.isOffline) {
    return {
      detail: "Check power, local network, or wait for the Pi to report again.",
      label: "Check Pi",
      tone: "warn"
    };
  }

  if (input.syncTone === "warn") {
    return {
      detail: "Publish the saved playlist to bring this screen current.",
      label: "Publish playlist",
      tone: "warn"
    };
  }

  if (input.isStale) {
    return {
      detail: "Refresh status or inspect diagnostics before recovery.",
      label: "Refresh status",
      tone: "warn"
    };
  }

  if (input.isLive && !input.rowPlaybackHealthy) {
    return {
      detail: "Playback is not confirmed from the latest report.",
      label: "Check playback",
      tone: "warn"
    };
  }

  if (input.healthLabel === "Waiting") {
    return {
      detail: "Beam has inventory but no live report yet.",
      label: "Await report",
      tone: "muted"
    };
  }

  return {
    detail: "No operator action is needed from the latest evidence.",
    label: "No action",
    tone: "good"
  };
}

export function DeviceHealthFleetPanel({
  deviceStatuses,
  devices,
  screens,
  liveHost,
  livePlayerUrl,
  playlists
}: FleetDeviceHealthPanelProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [sortKey, setSortKey] = useState<SortKey>("screen");
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
        const isLive = Boolean(status);
        const reachable = status?.reachable ?? false;
        const rowPlaybackHealthy = status?.playbackHealthy ?? false;
        const rowPlaybackLabel = status?.playbackLabel ?? "unknown";
        const rowStale = status?.stale ?? false;
        const reportedPlaylistId = status?.playerStatus?.playlistId ?? null;
        const reportedPlaylistVersion = status?.playerStatus?.playlistVersion;
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

        const nextAction = rowActionFor({
          healthLabel,
          hostConfigured,
          isLive,
          isOffline,
          isStale,
          rowPlaybackHealthy,
          syncLabel,
          syncTone
        });

        return {
          device,
          assignedPlaylistId: assignedPlaylistId ?? null,
          assignedPlaylistName: assignedPlaylist?.name ?? "No playlist assigned",
          attentionReason,
          nextActionDetail: nextAction.detail,
          nextActionLabel: nextAction.label,
          nextActionTone: nextAction.tone,
          healthDetail,
          healthLabel,
          healthTone,
          isLive,
          lastSeenAge: isLive ? status?.ageLabel ?? "No timestamp" : "Not seen yet",
          lastSeenFull: isLive ? status?.timestampLabel ?? "No timestamp available" : "No live report yet",
          lastSeenSortValue: Date.parse(status?.playerStatus?.updatedAt ?? "") || 0,
          lastStatusUpdatedAt: status?.playerStatus?.updatedAt ?? null,
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
    playlistsById,
    screensByDeviceId,
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
    if (filter === "stale") {
      return row.playbackLabel === "Old report";
    }
    if (filter === "sync") {
      return row.syncTone === "warn";
    }
    if (filter === "waiting") {
      return row.healthLabel === "Waiting";
    }

    return true;
  });

  const sortedVisibleRows = visibleRows
    .slice()
    .sort((left, right) => {
      if (sortKey === "lastSeen") {
        const leftMissing = left.lastSeenSortValue === 0;
        const rightMissing = right.lastSeenSortValue === 0;
        if (leftMissing && rightMissing) {
          return compareText(screenName(left), screenName(right));
        }
        if (leftMissing) {
          return 1;
        }
        if (rightMissing) {
          return -1;
        }

        const result =
          sortDirection === "asc"
            ? right.lastSeenSortValue - left.lastSeenSortValue
            : left.lastSeenSortValue - right.lastSeenSortValue;
        return result || compareText(screenName(left), screenName(right));
      }

      const result = compareRows(left, right, sortKey);
      return sortDirection === "asc" ? result : -result;
    });

  const selectedRow =
    sortedVisibleRows.find((row) => row.device.id === selectedDeviceId) ?? sortedVisibleRows[0] ?? rows[0] ?? null;
  const selectedPlayerUrl = selectedRow ? playerUrlFor(selectedRow, liveHost, livePlayerUrl) : null;
  const selectedSshUrl = selectedRow ? sshUrlFor(selectedRow) : null;
  const onlineCount = rows.filter((row) => row.healthLabel === "Online").length;
  const offlineCount = rows.filter((row) => row.healthLabel === "Offline").length;
  const staleCount = rows.filter((row) => row.playbackLabel === "Old report").length;
  const attentionCount = rows.filter((row) => row.needsAttention).length;
  const syncIssueCount = rows.filter((row) => row.syncTone === "warn").length;
  const waitingCount = rows.filter((row) => row.healthLabel === "Waiting").length;
  const rebootWatchApplies = Boolean(rebootWatch && selectedRow?.device.id === rebootWatch.deviceId);
  const rebootBaselineTimestamp = rebootWatch?.baselineStatusUpdatedAt ?? rebootWatch?.requestedAt ?? null;
  const selectedStatusUpdatedAt = rebootWatchApplies ? selectedRow?.lastStatusUpdatedAt ?? null : null;
  const selectedReachable = rebootWatchApplies ? selectedRow?.healthLabel === "Online" : false;
  const hasNewerStatusAfterReboot =
    Boolean(rebootBaselineTimestamp && selectedStatusUpdatedAt) &&
    Date.parse(selectedStatusUpdatedAt ?? "") > Date.parse(rebootBaselineTimestamp ?? "");

  useEffect(() => {
    if (!rebootWatch) {
      return;
    }

    if (rebootWatchApplies && selectedReachable && hasNewerStatusAfterReboot) {
      setMessage("Pi is back online with a fresh check-in after reboot.");
      setRebootWatch(null);
      return;
    }

    const timeout = window.setTimeout(() => {
      startTransition(() => router.refresh());
    }, 10_000);

    return () => window.clearTimeout(timeout);
  }, [hasNewerStatusAfterReboot, rebootWatch, rebootWatchApplies, router, selectedReachable, startTransition]);

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
          baselineStatusUpdatedAt: row.lastStatusUpdatedAt,
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
      label: "Down",
      toneClassName: "bg-rose-50 text-rose-800 ring-rose-100 hover:bg-rose-100"
    },
    {
      count: attentionCount,
      key: "attention",
      label: "Needs attention",
      toneClassName: "bg-orange-50 text-orange-800 ring-orange-100 hover:bg-orange-100"
    },
    {
      count: syncIssueCount,
      hideWhenZero: true,
      key: "sync",
      label: "Playlist needed",
      toneClassName: "bg-yellow-50 text-yellow-900 ring-yellow-100 hover:bg-yellow-100"
    },
    {
      count: staleCount,
      hideWhenZero: true,
      key: "stale",
      label: "Stale report",
      toneClassName: "bg-amber-50 text-amber-900 ring-amber-100 hover:bg-amber-100"
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
  const sortOptions: Array<{ label: string; value: SortKey }> = [
    { label: "Screen", value: "screen" },
    { label: "Status", value: "status" },
    { label: "Playlist", value: "playlist" },
    { label: "Next action", value: "action" },
    { label: "Last check-in", value: "lastSeen" }
  ];
  const sortDirectionLabel =
    sortKey === "lastSeen"
      ? sortDirection === "asc"
        ? "Newest first"
        : "Oldest first"
      : sortDirection === "asc"
        ? "Ascending"
        : "Descending";

  return (
    <section aria-labelledby="fleet-health-heading" className="mt-6 space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-5">
          <div>
            <h2 id="fleet-health-heading" className="text-xl font-semibold">Screen Health</h2>
            <p className="mt-1 text-sm text-zinc-600">
              See which screens are up, which are down, and the next action for each Pi.
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
                    {isActive ? "Filtering list" : "Filter list"}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-col gap-2 text-sm text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
            <p>
              {filter === "all"
                ? `Showing all ${formatCount(rows.length, "screen")}.`
                : `Filtered to ${formatCount(visibleRows.length, "screen")}.`}
            </p>
            {filter !== "all" ? (
              <button
                type="button"
                onClick={() => setFilter("all")}
                className="self-start rounded-md px-2 py-1 text-sm font-semibold text-teal-800 hover:bg-teal-50 focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                Show all screens
              </button>
            ) : null}
          </div>
        </div>

        <div className="border-t border-zinc-200 p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <h3 className="text-base font-semibold text-zinc-950">Device list</h3>
              <p className="mt-1 text-sm text-zinc-600">
                Select a screen to see details and controls below.
              </p>
            </div>
            <div className="grid w-full gap-3 xl:max-w-3xl xl:grid-cols-[minmax(240px,1fr)_180px_auto] xl:items-end">
              <div>
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
              <div>
                <label htmlFor="device-health-sort" className="text-xs font-semibold uppercase text-zinc-500">
                  Sort by
                </label>
                <select
                  id="device-health-sort"
                  value={sortKey}
                  onChange={(event) => {
                    const nextSortKey = event.currentTarget.value as SortKey;
                    setSortKey(nextSortKey);
                    setSortDirection("asc");
                  }}
                  className="mt-2 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-950 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-100"
                >
                  {sortOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
                className="min-h-11 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {sortDirectionLabel}
              </button>
            </div>
          </div>
          <p className="mt-3 text-sm text-zinc-600">
            Showing {formatCount(sortedVisibleRows.length, "screen")} from {formatCount(rows.length, "screen")}.
          </p>

          <div className="mt-4 max-h-[520px] overflow-auto rounded-md border border-zinc-200">
            <ol className="divide-y divide-zinc-200">
              {sortedVisibleRows.map((row) => {
                const isSelected = selectedRow?.device.id === row.device.id;

                return (
                  <li key={row.device.id}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedDeviceId(row.device.id)}
                      className={`grid w-full gap-3 px-4 py-3 text-left text-sm lg:grid-cols-[minmax(0,1fr)_150px_90px_minmax(180px,1fr)_140px] lg:items-center ${
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
                      <span className="lg:justify-self-start">
                        <StatusPill label={row.healthLabel} tone={row.healthTone} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-zinc-900">{row.assignedPlaylistName}</span>
                        <span className="mt-1 block truncate text-xs text-zinc-600">{row.syncLabel}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2 lg:justify-self-end">
                        <StatusPill label={row.nextActionLabel} tone={row.nextActionTone} />
                      </span>
                    </button>
                  </li>
                );
              })}
              {sortedVisibleRows.length === 0 ? (
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
                  <dt className="text-xs font-semibold uppercase text-zinc-500">Playback</dt>
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
                  <dt className="text-xs font-semibold uppercase text-zinc-500">Next action</dt>
                  <dd className="mt-2 font-semibold text-zinc-950">{selectedRow.nextActionLabel}</dd>
                  <dd className="mt-1 text-sm text-zinc-600">{selectedRow.nextActionDetail}</dd>
                </div>
              </dl>

              <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-zinc-950">Actions for this screen</h4>
                    <p className="mt-1 text-sm text-zinc-600">
                      Safe checks are first. Recovery and reboot actions are grouped at the end.
                    </p>
                  </div>
                  <div className="text-sm text-zinc-600">
                    Last check-in: <span className="font-semibold text-zinc-900">{selectedRow.lastSeenAge}</span>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
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
                    disabled={!selectedRow.isLive || !selectedRow.assignedPlaylistId || isBusy}
                    onClick={() => void runAction("publish", selectedRow)}
                    className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                  >
                    {busyAction === "publish" ? "Publishing..." : "Retry publish"}
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
                </div>
                <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-200 pt-3">
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
