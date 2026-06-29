"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "./dashboard-ui";
import { assignedPlaylistIdForDevice } from "./lib/inventory-assignment";

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
  sshUser?: string;
  resetFinishedAt?: string | null;
  resetRequestedAt?: string | null;
  resetStartedAt?: string | null;
  resetStatus?: "failed" | "pending" | "running" | "succeeded" | null;
  resetStatusMessage?: string | null;
  resetUpdatedAt?: string | null;
  screenId: string | null;
};

type Tone = "good" | "muted" | "warn";

type FleetDeviceHealthPanelProps = {
  dashboardMode: "cloud" | "local";
  deviceStatuses: Record<string, DeviceLiveStatus>;
  devices: DeviceRecord[];
  screens: ScreenRecord[];
  liveHost: string | null;
  livePlayerUrl: string | null;
  playlists: Array<{
    assetCount?: number;
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
type SortKey = "action" | "device" | "lastSeen" | "playback" | "playlist" | "screen" | "status" | "sync";

type RowState = {
  addressChanged: boolean;
  addressDetail: string;
  addressLabel: string;
  addressValue: string;
  assignedPlaylistId: string | null;
  assignedPlaylistAssetCount: number | null;
  assignedPlaylistName: string;
  assignedPlaylistVersion: number | null;
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
  resetActive: boolean;
  resetDetail: string;
  resetLabel: string;
  resetTone: Tone;
  reportedAddress: string | null;
  savedAddress: string;
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

type InventoryResponse = {
  error?: string;
};

type PublishFeedback = {
  detail: string;
  status: "error" | "pending" | "success";
};

type ScreenActionTone = "danger" | "neutral" | "primary";

function displayedSyncState(row: RowState, publishFeedback: PublishFeedback | null): { detail: string; label: string; tone: Tone } {
  if (publishFeedback?.status === "pending") {
    return {
      detail: publishFeedback.detail,
      label: "Publishing...",
      tone: "warn"
    };
  }

  if (publishFeedback?.status === "success") {
    return {
      detail: publishFeedback.detail,
      label: "Published",
      tone: "good"
    };
  }

  if (publishFeedback?.status === "error") {
    return {
      detail: publishFeedback.detail,
      label: "Publish failed",
      tone: "warn"
    };
  }

  return {
    detail: row.syncDetail,
    label: row.syncLabel,
    tone: row.syncTone
  };
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

function ScreenActionIcon({ name }: { name: "details" | "link" | "playlist" | "remove" | "rename" }) {
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

  if (name === "link") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        <path d="M10 13a5 5 0 0 0 7.1 0l1.4-1.4a5 5 0 0 0-7.1-7.1L10.6 5.3" />
        <path d="M14 11a5 5 0 0 0-7.1 0l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8" />
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

function screenNameFromDeviceName(value: string): string {
  return value.trim().replace(/(?:\s+pi)+$/i, "").trim() || value.trim();
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

  if (sortKey === "device") {
    return compareText(left.addressValue, right.addressValue) || compareText(screenName(left), screenName(right));
  }

  if (sortKey === "playback") {
    return compareText(left.playbackLabel, right.playbackLabel) || compareText(screenName(left), screenName(right));
  }

  if (sortKey === "sync") {
    return compareText(left.syncLabel, right.syncLabel) || compareText(screenName(left), screenName(right));
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
  screenLinked: boolean;
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

  if (!input.screenLinked) {
    return {
      detail: "Link this called-home Pi to a screen name before field use.",
      label: "Link screen",
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

function resetStateFor(device: DeviceRecord): { active: boolean; detail: string; label: string; tone: Tone } {
  if (device.resetStatus === "pending") {
    return {
      active: true,
      detail: device.resetStatusMessage ?? "Reset is queued in Beam and will run on the next Pi check-in.",
      label: "Reset pending",
      tone: "warn"
    };
  }

  if (device.resetStatus === "running") {
    return {
      active: true,
      detail: device.resetStatusMessage ?? "Reset is running on the Pi.",
      label: "Reset running",
      tone: "warn"
    };
  }

  if (device.resetStatus === "succeeded") {
    return {
      active: false,
      detail: device.resetStatusMessage ?? "Reset completed. Device is ready to redeploy.",
      label: "Reset complete",
      tone: "good"
    };
  }

  if (device.resetStatus === "failed") {
    return {
      active: false,
      detail: device.resetStatusMessage ?? "Reset failed on the Pi.",
      label: "Reset failed",
      tone: "warn"
    };
  }

  return {
    active: false,
    detail: "No reset has been requested for this Pi.",
    label: "No reset",
    tone: "muted"
  };
}

export function DeviceHealthFleetPanel({
  dashboardMode,
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
  const [publishFeedbackByDeviceId, setPublishFeedbackByDeviceId] = useState<Record<string, PublishFeedback>>({});
  const [busyAction, setBusyAction] = useState<"assign" | "inventory" | "publish" | "reboot" | "recover" | "refresh" | "reset" | "restart" | null>(null);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
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
      .slice()
      .sort(
        (a, b) =>
          compareText(a.group, b.group) ||
          compareText(a.location, b.location) ||
          compareText(a.name, b.name)
      )
      .map((device) => {
        const linkedScreen = screensByDeviceId.get(device.id) ?? null;
        const assignedPlaylistId = assignedPlaylistIdForDevice(device, linkedScreen);
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
        const savedAddress = device.host.trim() || "Not configured";
        const reportedAddress = status?.host?.trim() || null;
        const addressChanged = Boolean(
          reportedAddress &&
          hostConfigured &&
          normalize(reportedAddress) !== normalize(device.host)
        );
        const addressLabel = reportedAddress
          ? dashboardMode === "cloud"
            ? "Call-home"
            : "Current"
          : "Saved";
        const addressValue = reportedAddress ?? savedAddress;
        const addressDetail = reportedAddress
          ? addressChanged
            ? `Latest ${dashboardMode === "cloud" ? "call-home" : "reported"} address is ${reportedAddress}; saved inventory address is ${savedAddress}.`
            : `${addressLabel} address is ${reportedAddress}.`
          : `Saved inventory address is ${savedAddress}.`;
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
            ? dashboardMode === "cloud"
              ? "This Pi called home recently and reports network online."
              : "Beam can reach this screen on the local network."
            : dashboardMode === "cloud"
              ? "This Pi has not sent a fresh online call-home report."
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
          !linkedScreen ||
          !hostConfigured ||
          isOffline ||
          isStale ||
          syncTone === "warn" ||
          (isLive && !rowPlaybackHealthy);
        const attentionReason = !hostConfigured
          ? "setup needed"
          : !linkedScreen
            ? "screen link needed"
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
          screenLinked: Boolean(linkedScreen),
          syncLabel,
          syncTone
        });
        const resetState = resetStateFor(device);

        return {
          device,
          addressChanged,
          addressDetail,
          addressLabel,
          addressValue,
          assignedPlaylistId: assignedPlaylistId ?? null,
          assignedPlaylistAssetCount: assignedPlaylist?.assetCount ?? null,
          assignedPlaylistName: assignedPlaylist?.name ?? "No playlist assigned",
          assignedPlaylistVersion: assignedPlaylist?.version ?? null,
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
          resetActive: resetState.active,
          resetDetail: resetState.detail,
          resetLabel: resetState.label,
          resetTone: resetState.tone,
          reportedAddress,
          savedAddress,
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
    dashboardMode,
    devices,
    deviceStatuses,
    playlistsById,
    screensByDeviceId,
  ]);

  const visibleRows = rows.filter((row) => {
    const searchable = [
      row.device.name,
      row.device.host,
      row.addressValue,
      row.reportedAddress ?? "",
      row.savedAddress,
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
  const selectedPublishFeedback = selectedRow ? publishFeedbackByDeviceId[selectedRow.device.id] ?? null : null;
  const selectedSyncState = selectedRow ? displayedSyncState(selectedRow, selectedPublishFeedback) : null;
  const selectedPublishPending = selectedPublishFeedback?.status === "pending";
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

  async function postInventory(body: unknown): Promise<void> {
    const response = await fetch("/api/local-inventory", {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json"
      },
      method: "POST"
    });
    const result = (await response.json()) as InventoryResponse;
    if (!response.ok || result.error) {
      throw new Error(result.error ?? "Inventory update failed.");
    }
  }

  async function savePlaylistAssignment(row: RowState, nextPlaylistId: string | null) {
    if (isBusy) {
      return;
    }

    const targetType = row.linkedScreen ? "screen" : "device";
    const targetId = row.linkedScreen?.id ?? row.device.id;
    setBusyAction("assign");
    setPublishFeedbackByDeviceId((current) => {
      const next = { ...current };
      delete next[row.device.id];
      return next;
    });
    setMessage(nextPlaylistId ? `Assigning playlist to ${screenName(row)}...` : `Removing playlist from ${screenName(row)}...`);
    try {
      const response = await fetch("/api/local-playlist/assign", {
        body: JSON.stringify({
          assigned: Boolean(nextPlaylistId),
          playlistId: nextPlaylistId,
          targetId,
          targetType
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });
      const result = (await response.json()) as InventoryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not save playlist assignment.");
      }
      setMessage("Playlist assignment saved.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save playlist assignment.");
    } finally {
      setBusyAction(null);
    }
  }

  async function editScreen(row: RowState) {
    const screen = row.linkedScreen;
    if (!screen || isBusy) {
      return;
    }

    const nameInput = window.prompt("Screen name", screen.name);
    if (nameInput === null) {
      return;
    }
    const nextName = nameInput.trim();
    if (!nextName) {
      setMessage("Screen name is required.");
      return;
    }

    const locationInput = window.prompt("Location", screen.location);
    if (locationInput === null) {
      return;
    }
    const nextLocation = locationInput.trim() || "Unassigned";

    const groupInput = window.prompt("Group", screen.group);
    if (groupInput === null) {
      return;
    }
    const nextGroup = groupInput.trim() || "General";

    if (nextName === screen.name && nextLocation === screen.location && nextGroup === screen.group) {
      setMessage("No screen changes to save.");
      return;
    }

    setBusyAction("inventory");
    setMessage(`Updating ${screen.name}...`);
    try {
      const response = await fetch("/api/local-inventory", {
        body: JSON.stringify({
          group: nextGroup,
          id: screen.id,
          location: nextLocation,
          name: nextName,
          targetType: "screen"
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "PATCH"
      });
      const result = (await response.json()) as InventoryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not update this screen.");
      }
      setMessage(`${nextName} updated.`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update this screen.");
    } finally {
      setBusyAction(null);
    }
  }

  async function linkDeviceToScreen(row: RowState) {
    if (row.linkedScreen || isBusy) {
      return;
    }

    const suggestedName = screenNameFromDeviceName(row.device.name.replace(/^Unassigned Pi\s+/i, "")) || row.device.id;
    const nextName = window.prompt("Screen name", suggestedName)?.trim();
    if (!nextName) {
      return;
    }

    const nextHost = window.prompt("Pi local address or IP", row.device.host)?.trim();
    if (!nextHost) {
      setMessage("Pi address is required to link this check-in.");
      return;
    }

    setBusyAction("inventory");
    setMessage(`Linking ${nextName} to ${row.device.name}...`);
    try {
      await postInventory({
        deviceId: row.device.id,
        group: row.device.group,
        host: nextHost,
        location: row.device.location,
        name: nextName,
        playlistId: row.assignedPlaylistId,
        sshUser: row.device.sshUser,
        targetType: "screen"
      });
      setMessage(`${nextName} linked to ${row.device.name}.`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not link this Pi.");
    } finally {
      setBusyAction(null);
    }
  }

  async function removeInventory(row: RowState) {
    if (isBusy) {
      return;
    }

    const targetType = row.linkedScreen ? "screen" : "device";
    const targetId = row.linkedScreen?.id ?? row.device.id;
    const label = row.linkedScreen?.name ?? row.device.name;
    const confirmed = window.confirm(
      targetType === "screen"
        ? `Remove ${label}? Its linked Pi record will be removed too. Media and playlists stay saved.`
        : `Remove ${label}? Screens, media, and playlists stay saved.`
    );
    if (!confirmed) {
      return;
    }

    setBusyAction("inventory");
    setMessage(`Removing ${label}...`);
    try {
      const response = await fetch("/api/local-inventory", {
        body: JSON.stringify({ id: targetId, targetType }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "DELETE"
      });
      const result = (await response.json()) as InventoryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not remove this item.");
      }
      setMessage(`${label} removed.`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove this item.");
    } finally {
      setBusyAction(null);
    }
  }

  async function runAction(action: "publish" | "reboot" | "recover" | "reset" | "restart", row: RowState) {
    if ((action !== "reset" && !row.isLive) || isBusy || (action === "reset" && row.resetActive)) {
      return;
    }

    const targetName = row.linkedScreen?.name ?? row.device.name;
    if (
      action === "reboot" &&
      !window.confirm(
        `Reboot ${targetName} Pi?\n\nPlayback will stop while the Pi restarts. Beam will wait for a fresh check-in after reboot.`
      )
    ) {
      return;
    }
    if (action === "reset" && dashboardMode !== "cloud") {
      setMessage("Remote Pi reset is available from the AWS dashboard after the device-agent is installed.");
      return;
    }
    if (
      action === "reset" &&
      !window.confirm(
        `Reset ${targetName} Pi for deployment?\n\nBeam will queue this in AWS. The Pi will run it on its next cloud check-in, restore the Beam first-run playlist, remove stale published media and schedules, clear runtime status/cache, reinstall managed services, and unassign this device/screen in Beam. Network, SSH, hostname, and device identity are preserved.`
      )
    ) {
      return;
    }

    setBusyAction(action);
    setBusyDeviceId(row.device.id);
    if (action === "publish") {
      setPublishFeedbackByDeviceId((current) => ({
        ...current,
        [row.device.id]: {
          detail: `Publishing ${row.assignedPlaylistName} to ${targetName}...`,
          status: "pending"
        }
      }));
    }
    setMessage(
      action === "publish"
        ? `Publishing ${row.assignedPlaylistName} to ${targetName}...`
        : action === "restart"
          ? `Restarting playback for ${targetName}...`
          : action === "reboot"
            ? `Requesting reboot for ${targetName}...`
            : action === "reset"
              ? `Queueing reset for ${targetName}...`
              : `Running full recovery for ${targetName}...`
    );
    try {
      const result =
        action === "publish"
          ? await postJson("/api/local-playlist/publish", {
              deviceId: row.device.id,
              playlistId: row.linkedScreen?.playlistId ?? row.device.playlistId ?? undefined,
              screenId: row.linkedScreen?.id ?? undefined
            })
          : action === "reset"
            ? await postJson(`/api/cloud/devices/${encodeURIComponent(row.device.id)}/reset`)
            : await postJson("/api/local-player/actions", {
                action:
                  action === "restart"
                    ? "restart-vlc"
                    : action === "reboot"
                      ? "reboot-pi"
                      : "recover",
                deviceId: row.device.id,
                screenId: row.linkedScreen?.id ?? undefined
              });
      const publishMessage = result.piPublish?.message ? ` ${result.piPublish.message}` : "";
      const actionMessage =
        result.message ??
        (action === "publish"
          ? `Publish sent for ${targetName}.${publishMessage}`
          : `${row.device.name} action completed.`);
      if (action === "reboot") {
        setRebootWatch({
          baselineStatusUpdatedAt: row.lastStatusUpdatedAt,
          deviceId: row.device.id,
          requestedAt: new Date().toISOString()
        });
      }
      if (action === "publish") {
        setPublishFeedbackByDeviceId((current) => ({
          ...current,
          [row.device.id]: {
            detail: `${row.assignedPlaylistName} was published to ${targetName}.`,
            status: "success"
          }
        }));
      }
      setMessage(action === "publish" ? `${row.assignedPlaylistName} was published to ${targetName}.` : actionMessage);
      startTransition(() => router.refresh());
    } catch (error) {
      if (action === "reboot") {
        setRebootWatch(null);
      }
      const failureMessage = error instanceof Error ? error.message : "Action failed.";
      if (action === "publish") {
        setPublishFeedbackByDeviceId((current) => ({
          ...current,
          [row.device.id]: {
            detail: failureMessage,
            status: "error"
          }
        }));
      }
      setMessage(failureMessage);
    } finally {
      setBusyAction(null);
      setBusyDeviceId(null);
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
    { label: "Device", value: "device" },
    { label: "Status", value: "status" },
    { label: "Playback", value: "playback" },
    { label: "Playlist", value: "playlist" },
    { label: "Sync", value: "sync" },
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
            <h2 id="fleet-health-heading" className="text-xl font-semibold">Device list</h2>
            <p className="mt-1 text-sm text-zinc-600">
              One row per called-home Pi or linked screen, with playlist, recovery, reset, and inventory controls.
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
              <h3 className="text-base font-semibold text-zinc-950">Screens and Pis</h3>
              <p className="mt-1 text-sm text-zinc-600">
                Select details, assign playlists, publish updates, rename or link screens, and remove stale records.
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

          <div className="mt-4 max-h-[620px] overflow-auto rounded-md border border-zinc-200">
            <div className="grid min-w-[1320px] grid-cols-[minmax(170px,1fr)_260px_110px_120px_150px_210px_270px] gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-xs font-semibold uppercase text-zinc-500">
              <span>Screen</span>
              <span>Playlist</span>
              <span>Status</span>
              <span>Playback</span>
              <span>Sync</span>
              <span>Device</span>
              <span>Actions</span>
            </div>
            <ol className="divide-y divide-zinc-200">
              {sortedVisibleRows.map((row) => {
                const isSelected = selectedRow?.device.id === row.device.id;
                const publishFeedback = publishFeedbackByDeviceId[row.device.id] ?? null;
                const publishPending = publishFeedback?.status === "pending";
                const syncState = displayedSyncState(row, publishFeedback);
                const publishPillClass =
                  publishFeedback?.status === "success"
                    ? "bg-emerald-100 text-emerald-800 ring-emerald-200 hover:bg-emerald-100 focus:ring-emerald-400"
                    : publishFeedback?.status === "error"
                      ? "bg-rose-100 text-rose-800 ring-rose-200 hover:bg-rose-100 focus:ring-rose-400"
                      : "bg-amber-100 text-amber-900 ring-amber-200 hover:bg-amber-200 focus:ring-amber-400";

                return (
                  <li key={row.device.id}>
                    <div
                      className={`grid min-w-[1320px] gap-3 px-4 py-3 text-left text-sm lg:grid-cols-[minmax(170px,1fr)_260px_110px_120px_150px_210px_270px] lg:items-center ${
                        isSelected ? "bg-teal-50" : "bg-white hover:bg-zinc-50"
                      }`}
                    >
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedDeviceId(row.device.id)}
                        className="min-w-0 rounded-md text-left focus:outline-none focus:ring-2 focus:ring-teal-600"
                      >
                        <span className="block truncate font-semibold text-zinc-950">
                          {row.linkedScreen?.name ?? "No screen linked"}
                        </span>
                        <span className="mt-1 block truncate text-xs text-zinc-600">
                          {row.linkedScreen?.location ?? row.device.location} · {row.linkedScreen?.group ?? row.device.group}
                        </span>
                      </button>
                      <span className="min-w-0 text-left lg:w-full">
                        <label htmlFor={`device-playlist-${row.device.id}`} className="sr-only">
                          Playlist for {screenName(row)}
                        </label>
                        <select
                          id={`device-playlist-${row.device.id}`}
                          value={row.assignedPlaylistId ?? ""}
                          disabled={isBusy}
                          onChange={(event) => {
                            void savePlaylistAssignment(row, event.currentTarget.value || null);
                          }}
                          className="min-h-10 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-100"
                        >
                          <option value="">No playlist</option>
                          {row.assignedPlaylistId && !playlistsById.has(row.assignedPlaylistId) ? (
                            <option value={row.assignedPlaylistId}>Playlist not found</option>
                          ) : null}
                          {playlists.map((option) => (
                            <option key={option.playlistId} value={option.playlistId}>
                              {option.name}
                            </option>
                          ))}
                        </select>
                        <span className="mt-1 block truncate text-xs text-zinc-600">
                          {row.assignedPlaylistAssetCount !== null && row.assignedPlaylistVersion !== null
                            ? `${formatCount(row.assignedPlaylistAssetCount, "item")} · update ${row.assignedPlaylistVersion}`
                            : "Choose a saved playlist."}
                        </span>
                      </span>
                      <span className="lg:justify-self-start">
                        <StatusPill label={row.healthLabel} tone={row.healthTone} />
                      </span>
                      <span className="lg:justify-self-start" title={row.playbackDetail}>
                        <StatusPill label={row.playbackLabel} tone={row.playbackTone} />
                      </span>
                      <span className="lg:justify-self-start">
                        <span className="block">
                          {(row.syncLabel === "Publish required" || publishFeedback) && row.assignedPlaylistId ? (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void runAction("publish", row)}
                              title={syncState.detail}
                              aria-label={`Publish ${row.assignedPlaylistName} to ${screenName(row)}`}
                              aria-busy={publishPending}
                              className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50 ${publishPillClass}`}
                            >
                              {syncState.label}
                            </button>
                          ) : (
                            <span title={syncState.detail}>
                              <StatusPill label={syncState.label} tone={syncState.tone} />
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="min-w-0 text-left lg:w-full">
                        <span className="block truncate font-semibold text-zinc-800">{piLabel(row.device, row.linkedScreen)}</span>
                        <span className="mt-1 block truncate text-xs text-zinc-700" title={row.addressDetail}>
                          <span className="font-semibold">{row.addressLabel}:</span> {row.addressValue}
                        </span>
                        {row.addressChanged ? (
                          <span className="mt-0.5 block truncate text-xs text-zinc-500" title={`Saved inventory address: ${row.savedAddress}`}>
                            Saved: {row.savedAddress}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex min-w-[260px] flex-nowrap gap-2">
                        <button
                          type="button"
                          onClick={() => void runAction("publish", row)}
                          disabled={!row.isLive || !row.assignedPlaylistId || isBusy}
                          title={`Publish ${row.assignedPlaylistName} to ${screenName(row)}`}
                          aria-label={`Publish ${row.assignedPlaylistName} to ${screenName(row)}`}
                          aria-busy={publishPending}
                          className={`inline-flex h-9 min-w-[92px] items-center justify-center gap-1.5 rounded-md border bg-white px-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${screenActionClass("primary")}`}
                        >
                          <ScreenActionIcon name="playlist" />
                          <span>{publishPending ? "Publishing" : "Publish"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedDeviceId(row.device.id)}
                          title="Details"
                          aria-label={`Show details for ${screenName(row)}`}
                          className={`inline-flex h-9 w-9 items-center justify-center rounded-md border bg-white text-base font-semibold ${screenActionClass("neutral")}`}
                        >
                          <ScreenActionIcon name="details" />
                        </button>
                        {row.assignedPlaylistId ? (
                          <a
                            href={`/?view=playlist&playlist=${encodeURIComponent(row.assignedPlaylistId)}`}
                            title="Playlist"
                            aria-label={`Open playlist for ${screenName(row)}`}
                            className={`inline-flex h-9 w-9 items-center justify-center rounded-md border bg-white text-base font-semibold ${screenActionClass("primary")}`}
                          >
                            <ScreenActionIcon name="playlist" />
                          </a>
                        ) : null}
                        {row.linkedScreen ? (
                          <button
                            type="button"
                            onClick={() => void editScreen(row)}
                            disabled={isBusy}
                            title="Edit screen"
                            aria-label={`Edit name, group, and location for ${screenName(row)}`}
                            className={`inline-flex h-9 w-9 items-center justify-center rounded-md border bg-white text-base font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${screenActionClass("neutral")}`}
                          >
                            <ScreenActionIcon name="rename" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void linkDeviceToScreen(row)}
                            disabled={isBusy}
                            title="Link screen"
                            aria-label={`Link ${row.device.name} to a screen`}
                            className={`inline-flex h-9 w-9 items-center justify-center rounded-md border bg-white text-base font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${screenActionClass("primary")}`}
                          >
                            <ScreenActionIcon name="link" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void removeInventory(row)}
                          disabled={isBusy}
                          title="Remove"
                          aria-label={`Remove ${screenName(row)}`}
                          className={`inline-flex h-9 w-9 items-center justify-center rounded-md border bg-white text-lg font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${screenActionClass("danger")}`}
                        >
                          <ScreenActionIcon name="remove" />
                        </button>
                      </span>
                    </div>
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
                    Pi address: {selectedRow.addressLabel} {selectedRow.addressValue} / {selectedRow.linkedScreen?.location ?? selectedRow.device.location}
                  </p>
                  {selectedRow.addressChanged ? (
                    <p className="mt-1 text-sm text-zinc-500">Saved inventory address: {selectedRow.savedAddress}</p>
                  ) : null}
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
                    selectedSyncState?.tone === "warn" ? "bg-amber-50 ring-1 ring-amber-100" : "bg-zinc-50"
                  }`}
                >
                  <dt className={`text-xs font-semibold uppercase ${selectedSyncState?.tone === "warn" ? "text-amber-800" : "text-zinc-500"}`}>Playlist update</dt>
                  <dd className="mt-2 font-semibold text-zinc-950">{selectedSyncState?.label ?? selectedRow.syncLabel}</dd>
                  <dd className="mt-1 text-sm text-zinc-700">{selectedSyncState?.detail ?? selectedRow.syncDetail}</dd>
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
                {selectedRow.resetLabel !== "No reset" ? (
                  <div className="mt-3 flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-zinc-950">Remote reset</p>
                      <p className="mt-1 text-sm text-zinc-600">{selectedRow.resetDetail}</p>
                    </div>
                    <StatusPill label={selectedRow.resetLabel} tone={selectedRow.resetTone} />
                  </div>
                ) : null}
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
                    aria-busy={selectedPublishPending}
                    className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                  >
                    {selectedPublishPending ? "Publishing..." : "Publish playlist"}
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
                  <button
                    type="button"
                    disabled={isBusy || selectedRow.resetActive}
                    onClick={() => void runAction("reset", selectedRow)}
                    className="min-h-10 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyAction === "reset"
                      ? "Queueing reset..."
                      : selectedRow.resetActive
                        ? selectedRow.resetLabel
                        : "Reset for deployment"}
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
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-6">
                  <div>
                    <dt className="font-semibold text-zinc-500">{selectedRow.addressLabel} address</dt>
                    <dd className="mt-1 break-words text-zinc-800">{selectedRow.addressValue}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-zinc-500">Saved inventory</dt>
                    <dd className="mt-1 break-words text-zinc-800">{selectedRow.savedAddress}</dd>
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
                    <dd className="mt-1 break-words text-zinc-800">
                      {selectedRow.isLive ? (dashboardMode === "cloud" ? "Calling home" : "Configured Pi") : "Inventory only"}
                    </dd>
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
