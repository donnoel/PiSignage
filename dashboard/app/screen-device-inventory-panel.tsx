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

type InventoryResponse = {
  devices: DeviceRecord[];
  error?: string;
  playlistId: string;
  playlistName: string;
  screens: ScreenRecord[];
};

type InventoryPanelProps = {
  liveHost: string | null;
  livePlaybackState: string;
  livePlaylistVersion: number | null;
  liveReachable: boolean;
  playlistId: string;
  playlistVersion: number;
  statusAgeLabel: string;
  statusTimestampLabel: string;
};

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
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

export function ScreenDeviceInventoryPanel({
  liveHost,
  livePlaybackState,
  livePlaylistVersion,
  liveReachable,
  playlistId,
  playlistVersion,
  statusAgeLabel,
  statusTimestampLabel
}: InventoryPanelProps) {
  const router = useRouter();
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [message, setMessage] = useState("Loading inventory...");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [screenName, setScreenName] = useState("");
  const [screenLocation, setScreenLocation] = useState("");
  const [screenGroup, setScreenGroup] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [deviceHost, setDeviceHost] = useState("");
  const [deviceLocation, setDeviceLocation] = useState("");
  const [deviceGroup, setDeviceGroup] = useState("");
  const [isPending, startTransition] = useTransition();
  const isBusy = isLoading || isSaving || isPending;

  const devicesById = useMemo(() => {
    return new Map((inventory?.devices ?? []).map((device) => [device.id, device]));
  }, [inventory?.devices]);

  async function loadInventory() {
    setIsLoading(true);
    try {
      const response = await fetch("/api/local-inventory", {
        cache: "no-store",
        method: "GET"
      });
      const result = (await response.json()) as InventoryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not load inventory.");
      }
      setInventory({
        ...result,
        devices: sortDevices(result.devices),
        screens: sortScreens(result.screens)
      });
      setMessage("Inventory loaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load inventory.");
      setInventory(null);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadInventory();
  }, []);

  function deviceIsLive(device: DeviceRecord): boolean {
    if (!liveHost) {
      return false;
    }

    return device.host.trim().toLowerCase() === liveHost.trim().toLowerCase();
  }

  function statusForDevice(device: DeviceRecord): {
    detail: string;
    label: string;
    tone: "good" | "muted" | "warn";
  } {
    if (!device.host || device.host === "Not configured") {
      return {
        detail: "Host not configured",
        label: "Not configured",
        tone: "muted"
      };
    }

    if (deviceIsLive(device)) {
      return liveReachable
        ? {
            detail: "Probe reachable",
            label: "Online",
            tone: "good"
          }
        : {
            detail: "Probe unavailable",
            label: "Offline",
            tone: "warn"
          };
    }

    return {
      detail: "No live probe for this host",
      label: "Unknown",
      tone: "muted"
    };
  }

  function lastSeenForDevice(device: DeviceRecord): string {
    if (deviceIsLive(device)) {
      return `${statusAgeLabel} (${statusTimestampLabel})`;
    }

    return "Not seen yet";
  }

  function playbackForDevice(device: DeviceRecord): string {
    if (!deviceIsLive(device)) {
      return "Unknown";
    }

    return livePlaybackState;
  }

  function syncForDevice(device: DeviceRecord): {
    label: string;
    tone: "good" | "muted" | "warn";
  } {
    if (device.playlistId !== playlistId) {
      return {
        label: "Unassigned",
        tone: "warn"
      };
    }

    if (!deviceIsLive(device) || !liveReachable || livePlaylistVersion === null) {
      return {
        label: "Unknown",
        tone: "muted"
      };
    }

    if (livePlaylistVersion === playlistVersion) {
      return {
        label: "In sync",
        tone: "good"
      };
    }

    return {
      label: livePlaylistVersion < playlistVersion ? "Pi behind" : "Mismatch",
      tone: "warn"
    };
  }

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
    setInventory({
      ...result,
      devices: sortDevices(result.devices),
      screens: sortScreens(result.screens)
    });
  }

  async function removeInventory(targetType: "screen" | "device", id: string, label: string) {
    if (isBusy) {
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
        throw new Error(result.error ?? "Could not remove inventory item.");
      }
      setInventory({
        ...result,
        devices: sortDevices(result.devices),
        screens: sortScreens(result.screens)
      });
      setMessage(`${label} removed.`);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove inventory item.");
    } finally {
      setIsSaving(false);
    }
  }

  async function setAssignedPlaylist(
    targetType: "screen" | "device",
    id: string,
    assign: boolean
  ) {
    if (isBusy) {
      return;
    }

    setIsSaving(true);
    setMessage("Saving assignment...");
    try {
      const response = await fetch("/api/local-inventory", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id,
          playlistId: assign ? playlistId : null,
          targetType
        })
      });
      const result = (await response.json()) as InventoryResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not save assignment.");
      }
      setInventory({
        ...result,
        devices: sortDevices(result.devices),
        screens: sortScreens(result.screens)
      });
      setMessage("Assignment saved.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save assignment.");
    } finally {
      setIsSaving(false);
    }
  }

  async function addScreen(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }
    if (!screenName.trim()) {
      setMessage("Screen name is required.");
      return;
    }

    setIsSaving(true);
    setMessage("Adding screen...");
    try {
      await postInventory({
        group: screenGroup,
        location: screenLocation,
        name: screenName,
        playlistId,
        targetType: "screen"
      });
      setScreenName("");
      setScreenLocation("");
      setScreenGroup("");
      setMessage("Screen added.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add screen.");
    } finally {
      setIsSaving(false);
    }
  }

  async function addDevice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }
    if (!deviceName.trim() || !deviceHost.trim()) {
      setMessage("Device name and host are required.");
      return;
    }

    setIsSaving(true);
    setMessage("Adding device...");
    try {
      await postInventory({
        group: deviceGroup,
        host: deviceHost,
        location: deviceLocation,
        name: deviceName,
        playlistId,
        targetType: "device"
      });
      setDeviceName("");
      setDeviceHost("");
      setDeviceLocation("");
      setDeviceGroup("");
      setMessage("Device added.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add device.");
    } finally {
      setIsSaving(false);
    }
  }

  const screens = inventory?.screens ?? [];
  const devices = inventory?.devices ?? [];

  return (
    <div className="min-w-0 space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="grid gap-4 lg:grid-cols-2">
          <form onSubmit={addScreen} className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <h3 className="text-base font-semibold">Add screen</h3>
            <div className="mt-3 grid gap-2">
              <input
                value={screenName}
                onChange={(event) => setScreenName(event.currentTarget.value)}
                placeholder="Screen name"
                className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <input
                value={screenLocation}
                onChange={(event) => setScreenLocation(event.currentTarget.value)}
                placeholder="Location"
                className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <input
                value={screenGroup}
                onChange={(event) => setScreenGroup(event.currentTarget.value)}
                placeholder="Group"
                className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <button
                type="submit"
                disabled={isBusy}
                className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                Add screen
              </button>
            </div>
          </form>

          <form onSubmit={addDevice} className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <h3 className="text-base font-semibold">Add device</h3>
            <div className="mt-3 grid gap-2">
              <input
                value={deviceName}
                onChange={(event) => setDeviceName(event.currentTarget.value)}
                placeholder="Device name"
                className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <input
                value={deviceHost}
                onChange={(event) => setDeviceHost(event.currentTarget.value)}
                placeholder="Host or IP"
                className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <input
                value={deviceLocation}
                onChange={(event) => setDeviceLocation(event.currentTarget.value)}
                placeholder="Location"
                className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <input
                value={deviceGroup}
                onChange={(event) => setDeviceGroup(event.currentTarget.value)}
                placeholder="Group"
                className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950"
              />
              <button
                type="submit"
                disabled={isBusy}
                className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                Add device
              </button>
            </div>
          </form>
        </div>
        <p className="mt-3 text-sm text-zinc-600">{message}</p>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-5">
          <h3 className="text-lg font-semibold">Screens</h3>
        </div>
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[1240px] text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Group</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Assigned playlist</th>
                <th className="px-4 py-3">Device host</th>
                <th className="px-4 py-3">Last seen</th>
                <th className="px-4 py-3">Playback state</th>
                <th className="px-4 py-3">Sync state</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {screens.map((screen) => {
                const device = screen.deviceId ? devicesById.get(screen.deviceId) ?? null : null;
                const status = device ? statusForDevice(device) : { detail: "No linked device", label: "Unknown", tone: "muted" as const };
                const sync = device ? syncForDevice(device) : { label: "Unknown", tone: "muted" as const };
                return (
                  <tr key={screen.id}>
                    <td className="px-4 py-3 font-semibold text-zinc-950">{screen.name}</td>
                    <td className="px-4 py-3 text-zinc-700">{screen.location}</td>
                    <td className="px-4 py-3 text-zinc-700">{screen.group}</td>
                    <td className="px-4 py-3">
                      <StatusPill label={status.label} tone={status.tone} />
                      <p className="mt-1 text-xs text-zinc-600">{status.detail}</p>
                    </td>
                    <td className="px-4 py-3">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={screen.playlistId === playlistId}
                          disabled={isBusy}
                          onChange={(event) => {
                            void setAssignedPlaylist("screen", screen.id, event.currentTarget.checked);
                          }}
                          className="h-4 w-4 accent-teal-700"
                        />
                        <span className="text-zinc-700">{screen.playlistId === playlistId ? "Assigned" : "Unassigned"}</span>
                      </label>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">{device?.host ?? "No linked device"}</td>
                    <td className="px-4 py-3 text-zinc-700">{device ? lastSeenForDevice(device) : "Not seen yet"}</td>
                    <td className="px-4 py-3 text-zinc-700">{device ? playbackForDevice(device) : "Unknown"}</td>
                    <td className="px-4 py-3">
                      <StatusPill label={sync.label} tone={sync.tone} />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void removeInventory("screen", screen.id, screen.name)}
                        disabled={isBusy}
                        className="min-h-9 rounded-md border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {screens.length === 0 ? (
                <tr>
                  <td className="px-4 py-4 text-zinc-600" colSpan={10}>No screens recorded.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-5">
          <h3 className="text-lg font-semibold">Devices</h3>
        </div>
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[1160px] text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Host</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Group</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Assigned playlist</th>
                <th className="px-4 py-3">Last seen</th>
                <th className="px-4 py-3">Playback state</th>
                <th className="px-4 py-3">Sync state</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {devices.map((device) => {
                const status = statusForDevice(device);
                const sync = syncForDevice(device);
                return (
                  <tr key={device.id}>
                    <td className="px-4 py-3 font-semibold text-zinc-950">{device.name}</td>
                    <td className="px-4 py-3 text-zinc-700">{device.host}</td>
                    <td className="px-4 py-3 text-zinc-700">{device.location}</td>
                    <td className="px-4 py-3 text-zinc-700">{device.group}</td>
                    <td className="px-4 py-3">
                      <StatusPill label={status.label} tone={status.tone} />
                      <p className="mt-1 text-xs text-zinc-600">{status.detail}</p>
                    </td>
                    <td className="px-4 py-3">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={device.playlistId === playlistId}
                          disabled={isBusy}
                          onChange={(event) => {
                            void setAssignedPlaylist("device", device.id, event.currentTarget.checked);
                          }}
                          className="h-4 w-4 accent-teal-700"
                        />
                        <span className="text-zinc-700">{device.playlistId === playlistId ? "Assigned" : "Unassigned"}</span>
                      </label>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">{lastSeenForDevice(device)}</td>
                    <td className="px-4 py-3 text-zinc-700">{playbackForDevice(device)}</td>
                    <td className="px-4 py-3">
                      <StatusPill label={sync.label} tone={sync.tone} />
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
                  <td className="px-4 py-4 text-zinc-600" colSpan={10}>No devices recorded.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
