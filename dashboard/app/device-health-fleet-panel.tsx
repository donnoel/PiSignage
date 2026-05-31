"use client";

import { useMemo, useState, useTransition } from "react";
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
  devices: DeviceRecord[];
  screens: ScreenRecord[];
  liveHost: string | null;
  livePlaybackHealthy: boolean;
  livePlaybackState: string;
  livePlaylistVersion: number | null;
  liveReachable: boolean;
  liveStatusStale: boolean;
  playlistId: string;
  playlistVersion: number;
  statusAgeLabel: string;
  statusTimestampLabel: string;
};

type FilterKey = "all" | "attention" | "offline" | "stale" | "sync" | "unknown";

type RowState = {
  device: DeviceRecord;
  healthDetail: string;
  healthLabel: string;
  healthTone: Tone;
  isLive: boolean;
  lastSeen: string;
  linkedScreen: ScreenRecord | null;
  needsAttention: boolean;
  playbackLabel: string;
  syncDetail: string;
  syncLabel: string;
  syncTone: Tone;
};

type RecoveryResponse = {
  error?: string;
  message?: string;
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

export function DeviceHealthFleetPanel({
  devices,
  screens,
  liveHost,
  livePlaybackHealthy,
  livePlaybackState,
  livePlaylistVersion,
  liveReachable,
  liveStatusStale,
  playlistId,
  playlistVersion,
  statusAgeLabel,
  statusTimestampLabel
}: FleetDeviceHealthPanelProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(devices[0]?.id ?? null);
  const [message, setMessage] = useState("");
  const [recoveringDeviceId, setRecoveringDeviceId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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
        const isLive = deviceMatchesLiveHost(device, liveHost);
        const hostConfigured = Boolean(device.host.trim()) && device.host !== "Not configured";
        let healthLabel = "Unknown";
        let healthDetail = "No live probe for this host";
        let healthTone: Tone = "muted";

        if (!hostConfigured) {
          healthLabel = "Not configured";
          healthDetail = "Host not configured";
        } else if (isLive) {
          healthLabel = liveReachable ? "Online" : "Offline";
          healthDetail = liveReachable ? "Live probe reachable" : "Live probe unavailable";
          healthTone = liveReachable ? "good" : "warn";
        }

        const playbackLabel = isLive ? livePlaybackState : "Unknown";
        let syncLabel = "Unknown";
        let syncDetail = "No playlist version has been reported for this device";
        let syncTone: Tone = "muted";

        if (device.playlistId !== playlistId) {
          syncLabel = "Unassigned";
          syncDetail = "No active playlist is assigned";
          syncTone = "warn";
        } else if (isLive && liveReachable && livePlaylistVersion !== null) {
          if (livePlaylistVersion === playlistVersion) {
            syncLabel = "In sync";
            syncDetail = `Local v${playlistVersion}; Pi v${livePlaylistVersion}`;
            syncTone = "good";
          } else {
            syncLabel = livePlaylistVersion < playlistVersion ? "Pi behind" : "Mismatch";
            syncDetail = `Local v${playlistVersion}; Pi v${livePlaylistVersion}`;
            syncTone = "warn";
          }
        }

        const isOffline = isLive && !liveReachable;
        const isStale = isLive && liveStatusStale;
        const needsAttention =
          !hostConfigured ||
          isOffline ||
          isStale ||
          syncTone === "warn" ||
          (isLive && !livePlaybackHealthy);

        return {
          device,
          healthDetail,
          healthLabel,
          healthTone,
          isLive,
          lastSeen: isLive ? `${statusAgeLabel} (${statusTimestampLabel})` : "Not seen yet",
          linkedScreen,
          needsAttention,
          playbackLabel,
          syncDetail,
          syncLabel,
          syncTone
        };
      });
  }, [
    devices,
    liveHost,
    livePlaybackHealthy,
    livePlaybackState,
    livePlaylistVersion,
    liveReachable,
    liveStatusStale,
    playlistId,
    playlistVersion,
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
    if (filter === "offline") {
      return row.healthLabel === "Offline";
    }
    if (filter === "stale") {
      return row.isLive && liveStatusStale;
    }
    if (filter === "sync") {
      return row.syncTone === "warn";
    }
    if (filter === "unknown") {
      return row.healthLabel === "Unknown";
    }

    return true;
  });

  const selectedRow = rows.find((row) => row.device.id === selectedDeviceId) ?? visibleRows[0] ?? null;
  const onlineCount = rows.filter((row) => row.healthLabel === "Online").length;
  const offlineCount = rows.filter((row) => row.healthLabel === "Offline").length;
  const staleCount = rows.filter((row) => row.isLive && liveStatusStale).length;
  const playingCount = rows.filter((row) => row.isLive && livePlaybackHealthy).length;
  const attentionCount = rows.filter((row) => row.needsAttention).length;
  const syncIssueCount = rows.filter((row) => row.syncTone === "warn").length;
  const unknownCount = rows.filter((row) => row.healthLabel === "Unknown").length;
  const isRecovering = Boolean(recoveringDeviceId) || isPending;

  async function recoverDevice(row: RowState) {
    if (!row.isLive || isRecovering) {
      return;
    }

    setRecoveringDeviceId(row.device.id);
    setMessage(`Recovering ${row.device.name}...`);
    try {
      const response = await fetch("/api/local-player/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action: "recover" })
      });
      const result = (await response.json()) as RecoveryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Recover failed.");
      }
      setMessage(result.message ?? `${row.device.name} recovery completed.`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Recover failed.");
    } finally {
      setRecoveringDeviceId(null);
    }
  }

  const filters: Array<{ count: number; key: FilterKey; label: string }> = [
    { count: rows.length, key: "all", label: "All" },
    { count: attentionCount, key: "attention", label: "Needs attention" },
    { count: offlineCount, key: "offline", label: "Offline" },
    { count: staleCount, key: "stale", label: "Stale" },
    { count: syncIssueCount, key: "sync", label: "Sync" },
    { count: unknownCount, key: "unknown", label: "Unknown" }
  ];

  return (
    <section aria-labelledby="fleet-health-heading" className="mt-6 space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-zinc-200 p-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 id="fleet-health-heading" className="text-xl font-semibold">Fleet health</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Scan every device quickly, then open the row that needs work.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {filters.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={`min-h-9 rounded-md px-3 py-2 text-xs font-semibold ring-1 ${
                  filter === item.key
                    ? "bg-teal-700 text-white ring-teal-700"
                    : "bg-white text-zinc-700 ring-zinc-200 hover:bg-zinc-50"
                }`}
              >
                {item.label} {item.count}
              </button>
            ))}
          </div>
        </div>

        <dl className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-md bg-emerald-50 p-4 ring-1 ring-emerald-100">
            <dt className="text-xs font-semibold uppercase text-emerald-800">Online</dt>
            <dd className="mt-2 text-2xl font-semibold">{onlineCount}</dd>
          </div>
          <div className="rounded-md bg-rose-50 p-4 ring-1 ring-rose-100">
            <dt className="text-xs font-semibold uppercase text-rose-800">Offline</dt>
            <dd className="mt-2 text-2xl font-semibold">{offlineCount}</dd>
          </div>
          <div className="rounded-md bg-amber-50 p-4 ring-1 ring-amber-100">
            <dt className="text-xs font-semibold uppercase text-amber-900">Stale</dt>
            <dd className="mt-2 text-2xl font-semibold">{staleCount}</dd>
          </div>
          <div className="rounded-md bg-sky-50 p-4 ring-1 ring-sky-100">
            <dt className="text-xs font-semibold uppercase text-sky-800">Playing</dt>
            <dd className="mt-2 text-2xl font-semibold">{playingCount}</dd>
          </div>
          <div className="rounded-md bg-orange-50 p-4 ring-1 ring-orange-100">
            <dt className="text-xs font-semibold uppercase text-orange-800">Needs attention</dt>
            <dd className="mt-2 text-2xl font-semibold">{attentionCount}</dd>
          </div>
          <div className="rounded-md bg-zinc-50 p-4 ring-1 ring-zinc-200">
            <dt className="text-xs font-semibold uppercase text-zinc-600">Inventory</dt>
            <dd className="mt-2 text-2xl font-semibold">{rows.length}</dd>
          </div>
        </dl>

        <div className="border-t border-zinc-200 p-5">
          <label htmlFor="device-health-search" className="text-sm font-semibold text-zinc-800">
            Search devices
          </label>
          <input
            id="device-health-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Name, host, location, group, or screen"
            className="mt-2 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-100"
          />
          <p className="mt-2 text-sm text-zinc-600">
            Showing {formatCount(visibleRows.length, "device")} from {formatCount(rows.length, "device")}.
          </p>
        </div>

        <div className="max-w-full overflow-x-auto border-t border-zinc-200">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Group</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Playback</th>
                <th className="px-4 py-3">Sync</th>
                <th className="px-4 py-3">Last seen</th>
                <th className="px-4 py-3">Screen</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {visibleRows.map((row) => (
                <tr key={row.device.id} className={row.needsAttention ? "bg-amber-50/40" : undefined}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-zinc-950">{row.device.name}</p>
                    <p className="mt-1 text-xs text-zinc-600">{row.device.host}</p>
                  </td>
                  <td className="px-4 py-3 text-zinc-700">{row.device.location}</td>
                  <td className="px-4 py-3 text-zinc-700">{row.device.group}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={row.healthLabel} tone={row.healthTone} />
                    <p className="mt-1 text-xs text-zinc-600">{row.healthDetail}</p>
                  </td>
                  <td className="px-4 py-3 text-zinc-700">{row.playbackLabel}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={row.syncLabel} tone={row.syncTone} />
                    <p className="mt-1 text-xs text-zinc-600">{row.syncDetail}</p>
                  </td>
                  <td className="px-4 py-3 text-zinc-700">{row.lastSeen}</td>
                  <td className="px-4 py-3 text-zinc-700">{row.linkedScreen?.name ?? "Not linked"}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedDeviceId(row.device.id)}
                        className="min-h-9 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50"
                      >
                        Details
                      </button>
                      <button
                        type="button"
                        disabled={!row.isLive || isRecovering}
                        onClick={() => void recoverDevice(row)}
                        className="min-h-9 rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                      >
                        {recoveringDeviceId === row.device.id ? "Recovering" : "Recover"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visibleRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-5 text-zinc-600" colSpan={9}>
                    No devices match this view.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {message ? (
        <p className="text-sm font-medium text-zinc-700" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}

      {selectedRow ? (
        <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm" aria-label="Selected device details">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-lg font-semibold">{selectedRow.device.name}</h3>
              <p className="mt-1 text-sm text-zinc-600">
                {selectedRow.device.host} / {selectedRow.device.location} / {selectedRow.device.group}
              </p>
            </div>
            <StatusPill label={selectedRow.needsAttention ? "Review" : "OK"} tone={selectedRow.needsAttention ? "warn" : "good"} />
          </div>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md bg-zinc-50 p-4">
              <dt className="text-xs font-semibold uppercase text-zinc-500">Health</dt>
              <dd className="mt-2 font-semibold text-zinc-950">{selectedRow.healthLabel}</dd>
              <dd className="mt-1 text-sm text-zinc-600">{selectedRow.healthDetail}</dd>
            </div>
            <div className="rounded-md bg-zinc-50 p-4">
              <dt className="text-xs font-semibold uppercase text-zinc-500">Playback</dt>
              <dd className="mt-2 font-semibold text-zinc-950">{selectedRow.playbackLabel}</dd>
              <dd className="mt-1 text-sm text-zinc-600">{selectedRow.isLive ? "Live player evidence" : "No live player evidence yet"}</dd>
            </div>
            <div className="rounded-md bg-zinc-50 p-4">
              <dt className="text-xs font-semibold uppercase text-zinc-500">Sync</dt>
              <dd className="mt-2 font-semibold text-zinc-950">{selectedRow.syncLabel}</dd>
              <dd className="mt-1 text-sm text-zinc-600">{selectedRow.syncDetail}</dd>
            </div>
            <div className="rounded-md bg-zinc-50 p-4">
              <dt className="text-xs font-semibold uppercase text-zinc-500">Screen</dt>
              <dd className="mt-2 font-semibold text-zinc-950">{selectedRow.linkedScreen?.name ?? "Not linked"}</dd>
              <dd className="mt-1 text-sm text-zinc-600">{selectedRow.linkedScreen?.location ?? "No screen assignment"}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </section>
  );
}
