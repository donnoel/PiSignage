import { promises as fs } from "node:fs";
import { DashboardAutoRefresh } from "./dashboard-auto-refresh";
import { Metric, StatusPill } from "./dashboard-ui";
import { DeviceHealthFleetPanel } from "./device-health-fleet-panel";
import { ensureLocalDataFoundation } from "./lib/local-data-store";
import type { DeviceRecord, DeviceStore, ScreenRecord, ScreenStore } from "./lib/local-data-store";
import { readNormalizedInventory } from "./lib/local-inventory";
import { localStateDirectory, publishStatusPath, readPlaylistStore, repoRoot, selectPlaylist, writeFileAtomic } from "./lib/local-playlist";
import type { Playlist, PlaylistAsset, PlaylistStore } from "./lib/local-playlist";
import { readPiConfig, runSsh } from "./lib/pi-local";
import type { PiConfig } from "./lib/pi-local";
import { piConfigForDevice } from "./lib/pi-targets";
import { isPlaybackSafeVideoFileName } from "./lib/playback-safety";
import { MediaStorePanel } from "./media-store-panel";
import { LocalPlaylistBuilder, LocalPlaylistScreenAssignment } from "./local-playlist-builder";
import { LocalPlaylistCreateForm } from "./local-playlist-create-form";
import { LocalPlaylistDeleteButton } from "./local-playlist-delete-button";
import { LocalPlaylistRenameButton } from "./local-playlist-rename-button";
import { LocalPlaylistSwitcher } from "./local-playlist-switcher";
import { LocalPublishForm } from "./local-publish-form";
import { LocalPlaylistSequence } from "./local-playlist-sequence";
import { LocalPlaylistTimeline } from "./local-playlist-timeline";
import { ScreenDeviceInventoryPanel } from "./screen-device-inventory-panel";
import { SchedulingPanel } from "./scheduling-panel";
import { TroubleshootingPanel } from "./troubleshooting-panel";

export const dynamic = "force-dynamic";

type Heartbeat = {
  deviceId: string;
  timestamp: string;
  appVersion: string;
  currentPlaylistId: string;
  currentAssetId: string | null;
  diskFreeBytes: number | null;
  networkOnline: boolean;
};

type PlayerStatus = {
  mode?: string;
  state?: string;
  startedAt?: string;
  updatedAt?: string;
  displayOutput?: string;
  displayMode?: string;
  playlistId?: string;
  playlistVersion?: number;
  assetCount?: number;
  assetIds?: string[];
  lastError?: string | null;
};

type PiProbe = {
  configured: boolean;
  reachable: boolean;
  host: string | null;
  message: string;
  playerStatus: PlayerStatus | null;
  serviceActiveState: string | null;
  serviceSubState: string | null;
  serviceRestartCount: string | null;
  temp: string | null;
  throttled: string | null;
  vlcMemoryMb: string | null;
  vlcCpuPercent: string | null;
  uptime: string | null;
  bootId: string | null;
  displayMode: string | null;
};

type LastKnownPlayback = {
  bootId: string | null;
  displayMode: string | null;
  host: string;
  observedAt: string;
  playerStatus: PlayerStatus | null;
  serviceActiveState: string | null;
  serviceSubState: string | null;
};

type DashboardState = {
  deviceStatuses: Record<string, DeviceLiveStatus>;
  heartbeat: Heartbeat | null;
  inventory: {
    devices: DeviceStore;
    screens: ScreenStore;
  };
  lastKnownPlayback: LastKnownPlayback | null;
  playlist: Playlist;
  playlistStore: PlaylistStore;
  publishStatus: PublishStatus | null;
  pi: PiProbe;
};

type DeviceLiveStatus = {
  ageLabel: string;
  host: string | null;
  playbackHealthy: boolean;
  playbackLabel: string;
  playerStatus: PlayerStatus | null;
  reachable: boolean;
  stale: boolean;
  timestampLabel: string;
};

type PublishStatus = {
  action: string;
  assetCount: number;
  message: string;
  ok: boolean;
  piPublishEnabled: boolean;
  playlistId?: string;
  playlistName?: string;
  playlistVersion: number;
  timestamp: string;
};

type StatusTone = "good" | "warn" | "muted";

type PlaylistSyncState = {
  detail: string;
  label: string;
  tone: StatusTone;
};

const execTimeoutMs = 4_000;
const staleStatusThresholdMs = 45_000;
const staleHeartbeatThresholdMs = 120_000;

type DashboardView =
  | "dashboard"
  | "media-store"
  | "playlist"
  | "device-health"
  | "screens"
  | "scheduling";

type DashboardPageProps = {
  searchParams?: Promise<{
    playlist?: string | string[];
    screen?: string | string[];
    view?: string | string[];
  }>;
};

const navigationItems: Array<{ label: string; view: DashboardView }> = [
  { label: "Dashboard", view: "dashboard" },
  { label: "Media Store", view: "media-store" },
  { label: "Playlists", view: "playlist" },
  { label: "Screen Health", view: "device-health" },
  { label: "Screens", view: "screens" },
  { label: "Scheduling", view: "scheduling" }
];

const viewCopy: Record<DashboardView, { eyebrow: string; title: string; description?: string }> = {
  dashboard: {
    eyebrow: "",
    title: "Dashboard"
  },
  "media-store": {
    eyebrow: "Library",
    title: "Media Store",
    description: "Upload, find, and organize media for your screens."
  },
  playlist: {
    eyebrow: "Loops",
    title: "Playlists",
    description: "Create a playlist, choose screens, then publish."
  },
  "device-health": {
    eyebrow: "Health",
    title: "Screen Health",
    description: "Connection, playback, playlist update, recovery tools, logs, and Pi evidence for local screens."
  },
  screens: {
    eyebrow: "Inventory",
    title: "Screens",
    description: "Local screens, assigned playlists, and live playback status."
  },
  scheduling: {
    eyebrow: "Hours",
    title: "Scheduling"
  }
};

function dashboardViewFrom(value: string | string[] | undefined): DashboardView {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === "troubleshooting") {
    return "device-health";
  }

  return navigationItems.some((item) => item.view === candidate) ? (candidate as DashboardView) : "dashboard";
}

async function readJsonFile<TValue>(filePath: string): Promise<TValue | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as TValue;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;

    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function formatTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) {
    return "Not reported";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number") {
    return "Not reported";
  }

  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    style: "unit",
    unit: "gigabyte"
  }).format(value / 1_000_000_000);
}

function formatDuration(assets: PlaylistAsset[]): string {
  const totalSeconds = assets.reduce((total, asset) => total + (asset.durationSeconds ?? 0), 0);
  return formatSeconds(totalSeconds);
}

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function fileNameFromUri(uri: string): string {
  return uri.split("/").filter(Boolean).at(-1) ?? uri;
}

function parseVlcStats(rawValue: string): Pick<PiProbe, "vlcMemoryMb" | "vlcCpuPercent"> {
  const [rssKbText, cpuText] = rawValue.trim().split(/\s+/);
  const rssKb = Number.parseFloat(rssKbText);
  const cpu = Number.parseFloat(cpuText);

  return {
    vlcMemoryMb: Number.isFinite(rssKb) ? `${(rssKb / 1024).toFixed(1)} MB` : null,
    vlcCpuPercent: Number.isFinite(cpu) ? `${cpu.toFixed(1)}%` : null
  };
}

function displayModeFromKmsprint(rawValue: string): string | null {
  const match = rawValue.match(/Crtc \d+ \(\d+\) ([^\s]+) /);
  return formatDisplayMode(match?.[1]) ?? null;
}

function cleanProbeOutput(rawValue: string): string {
  const statusIndex = rawValue.lastIndexOf("__STATUS__");
  return statusIndex === -1 ? rawValue : rawValue.slice(statusIndex);
}

function formatDisplayMode(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d+x\d+)@(\d+(?:\.\d+)?)/);
  if (!match) {
    return value;
  }

  const refreshRate = Number.parseFloat(match[2]);
  return Number.isFinite(refreshRate) ? `${match[1]} @ ${refreshRate.toFixed(0)} Hz` : value;
}

function formatTemperature(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  return value.replace("temp=", "").replace("'C", " C");
}

function formatThrottle(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  return value.replace("throttled=", "");
}

function formatStatusAge(timestamp: string | null | undefined): string {
  if (!timestamp) {
    return "Not reported";
  }

  const statusDate = new Date(timestamp);
  if (Number.isNaN(statusDate.getTime())) {
    return "Unknown";
  }

  const ageSeconds = Math.max(0, Math.round((Date.now() - statusDate.getTime()) / 1000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }

  const ageMinutes = Math.round(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }

  return `${Math.round(ageMinutes / 60)}h ago`;
}

function formatElapsedSince(timestamp: string | null | undefined): string | null {
  const age = formatStatusAge(timestamp);
  return age === "Not reported" || age === "Unknown" ? null : age.replace(/ ago$/, "");
}

function localConfigLabel(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function statusAgeMs(timestamp: string | null | undefined): number | null {
  if (!timestamp) {
    return null;
  }

  const statusDate = new Date(timestamp);
  if (Number.isNaN(statusDate.getTime())) {
    return null;
  }

  return Math.max(0, Date.now() - statusDate.getTime());
}

function screenLabel(pi: PiProbe, heartbeat: Heartbeat | null, isHeartbeatFresh: boolean): string {
  const configuredScreenName = localConfigLabel("PISIGNAGE_SCREEN_NAME");
  if (configuredScreenName) {
    return configuredScreenName;
  }

  if (isHeartbeatFresh && heartbeat?.deviceId) {
    return heartbeat.deviceId;
  }

  if (pi.host) {
    return `Pi ${pi.host}`;
  }

  return "Screen not configured";
}

function locationLabel(): string {
  return localConfigLabel("PISIGNAGE_LOCATION_NAME") ?? "Location not configured";
}

function deviceIdentifier(pi: PiProbe, heartbeat: Heartbeat | null, isHeartbeatFresh: boolean): string {
  if (isHeartbeatFresh && heartbeat?.deviceId) {
    return heartbeat.deviceId;
  }

  return pi.host ?? "Pi not configured";
}

function statusFreshnessDetail(
  pi: PiProbe,
  playerStatus: PlayerStatus | null | undefined,
  isPlayerStatusFresh: boolean
): string {
  if (!pi.configured) {
    return "Pi SSH is not configured yet.";
  }

  if (!pi.reachable) {
    return "Pi status is unavailable from this dashboard.";
  }

  if (!playerStatus?.updatedAt) {
    return "Pi is reachable, but VLC has not written a status heartbeat yet.";
  }

  if (!isPlayerStatusFresh) {
    return `Last VLC heartbeat was ${formatStatusAge(playerStatus.updatedAt)}. Playback may still be running locally on the Pi.`;
  }

  return `Last VLC heartbeat was ${formatStatusAge(playerStatus.updatedAt)}.`;
}

function serviceLabel(activeState: string | null, subState: string | null): string {
  if (!activeState) {
    return "Unknown";
  }

  return subState ? `${activeState} / ${subState}` : activeState;
}

function serviceTone(activeState: string | null): "good" | "warn" | "muted" {
  return activeState === "active" ? "good" : "warn";
}

function bootRecoveryLabel(pi: PiProbe, playbackHealthy: boolean): string {
  if (!pi.reachable) {
    return "Unknown";
  }

  return playbackHealthy ? "Recovered" : "Check";
}

function bootRecoveryDetail(pi: PiProbe): string {
  const bootLabel = pi.bootId ? `boot ${pi.bootId.slice(0, 8)}` : "boot not reported";
  return pi.uptime ? `${pi.uptime} · ${bootLabel}` : bootLabel;
}

function lastKnownPlaybackPath(): string {
  return `${localStateDirectory()}/last-known-playback.json`;
}

async function readLastKnownPlayback(host: string | null): Promise<LastKnownPlayback | null> {
  if (!host) {
    return null;
  }

  try {
    const snapshot = JSON.parse(await fs.readFile(lastKnownPlaybackPath(), "utf8")) as LastKnownPlayback;
    return snapshot.host === host ? snapshot : null;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return null;
    }

    console.error("last known playback read failed", error);
    return null;
  }
}

async function resolveLastKnownPlayback(pi: PiProbe): Promise<LastKnownPlayback | null> {
  if (!pi.host) {
    return null;
  }

  if (!pi.reachable) {
    return readLastKnownPlayback(pi.host);
  }

  const snapshot: LastKnownPlayback = {
    bootId: pi.bootId,
    displayMode: pi.displayMode,
    host: pi.host,
    observedAt: new Date().toISOString(),
    playerStatus: pi.playerStatus,
    serviceActiveState: pi.serviceActiveState,
    serviceSubState: pi.serviceSubState
  };

  try {
    await writeFileAtomic(lastKnownPlaybackPath(), `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch (error) {
    console.error("last known playback write failed", error);
  }

  return snapshot;
}

function lastKnownPlaybackLabel(snapshot: LastKnownPlayback | null): string | null {
  if (!snapshot || snapshot.playerStatus?.state !== "playing") {
    return null;
  }

  return `Last known playing ${formatStatusAge(snapshot.playerStatus.updatedAt ?? snapshot.observedAt)}`;
}

function offlineDurationLabel(snapshot: LastKnownPlayback | null): string | null {
  const elapsed = formatElapsedSince(snapshot?.observedAt);
  return elapsed ? `Offline for ${elapsed}` : null;
}

function offlinePlaybackDetail(snapshot: LastKnownPlayback | null): string {
  const details: string[] = [];
  const lastKnown = lastKnownPlaybackLabel(snapshot);
  const offlineDuration = offlineDurationLabel(snapshot);

  if (offlineDuration) {
    details.push(`${offlineDuration}.`);
  }
  if (lastKnown) {
    details.push(`${lastKnown}.`);
  }
  details.push("Playback unknown until this screen comes back online.");

  return details.join(" ");
}

function parseServiceStatus(rawValue: string): Pick<
  PiProbe,
  "serviceActiveState" | "serviceSubState" | "serviceRestartCount"
> {
  const values = Object.fromEntries(
    rawValue
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) {
          return [line, ""] as const;
        }

        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)] as const;
      })
  );

  return {
    serviceActiveState: values.ActiveState || null,
    serviceSubState: values.SubState || null,
    serviceRestartCount: values.NRestarts || null
  };
}

function piConfigFromInventory(inventory: { devices: DeviceStore }): PiConfig | null {
  const savedDevice = inventory.devices.items.find((device) => {
    return Boolean(device.host.trim()) && device.host !== "Not configured";
  });
  const fallbackConfig = readPiConfig();

  if (!savedDevice) {
    return fallbackConfig;
  }

  return {
    host: savedDevice.host.trim(),
    password: fallbackConfig?.password,
    root: savedDevice.rootPath?.trim() && savedDevice.rootPath !== "~" ? savedDevice.rootPath.trim() : fallbackConfig?.root ?? "/home/donnoel/PiSignage",
    user: savedDevice.sshUser?.trim() || fallbackConfig?.user || "donnoel"
  };
}

async function loadPiProbe(config: PiConfig | null): Promise<PiProbe> {
  if (!config) {
    return {
      configured: false,
      reachable: false,
      host: null,
      message: "Add a local Pi in Screens, or configure Pi SSH in dashboard/.env.local.",
      playerStatus: null,
      temp: null,
      throttled: null,
      vlcMemoryMb: null,
      vlcCpuPercent: null,
      serviceActiveState: null,
      serviceSubState: null,
      serviceRestartCount: null,
      uptime: null,
      bootId: null,
      displayMode: null
    };
  }

  const remoteCommand = [
    "printf '__STATUS__\\n'",
    "cat ~/.local/state/pisignage/player-status.json 2>/dev/null || true",
    "printf '\\n__TEMP__\\n'",
    "vcgencmd measure_temp 2>/dev/null || true",
    "printf '__THROTTLE__\\n'",
    "vcgencmd get_throttled 2>/dev/null || true",
    "printf '__VLC__\\n'",
    "ps -C vlc -o rss=,%cpu= | awk '{rss+=$1; cpu+=$2} END {if (NR > 0) printf \"%.0f %.1f\\n\", rss, cpu}'",
    "printf '__SERVICE__\\n'",
    "systemctl --user show pisignage-vlc.service --property=ActiveState --property=SubState --property=NRestarts 2>/dev/null || true",
    "printf '__UPTIME__\\n'",
    "uptime -p 2>/dev/null || uptime",
    "printf '__BOOT__\\n'",
    "cat /proc/sys/kernel/random/boot_id 2>/dev/null || true",
    "printf '__DISPLAY__\\n'",
    "kmsprint 2>/dev/null | sed -n '1,20p' || true"
  ].join("; ");

  try {
    const stdout = cleanProbeOutput(await runSsh(config, remoteCommand, { timeoutMs: execTimeoutMs }));

    const statusText = textBetween(stdout, "__STATUS__", "__TEMP__");
    const temp = textBetween(stdout, "__TEMP__", "__THROTTLE__").trim() || null;
    const throttled = textBetween(stdout, "__THROTTLE__", "__VLC__").trim() || null;
    const vlcStats = parseVlcStats(textBetween(stdout, "__VLC__", "__SERVICE__"));
    const serviceStatus = parseServiceStatus(textBetween(stdout, "__SERVICE__", "__UPTIME__"));
    const uptime = textBetween(stdout, "__UPTIME__", "__BOOT__").trim() || null;
    const bootId = textBetween(stdout, "__BOOT__", "__DISPLAY__").trim() || null;
    const displayMode = displayModeFromKmsprint(stdout);
    let playerStatus: PlayerStatus | null = null;

    try {
      playerStatus = JSON.parse(statusText) as PlayerStatus;
    } catch {
      playerStatus = null;
    }

    return {
      configured: true,
      reachable: true,
      host: config.host,
      message: `Connected to ${config.host} over local SSH.`,
      playerStatus,
      temp,
      throttled,
      ...vlcStats,
      ...serviceStatus,
      uptime,
      bootId,
      displayMode
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const friendlyMessage = message.includes("Permission denied")
      ? `Pi SSH rejected the local probe for ${config.user}@${config.host}. Update SSH key access or local credentials for this network.`
      : message.includes("timed out") || message.includes("ETIMEDOUT")
        ? `Pi probe timed out for ${config.host}. Confirm the Pi is on this network and SSH is reachable.`
        : `Pi probe could not read local playback status from ${config.host}.`;

    return {
      configured: true,
      reachable: false,
      host: config.host,
      message: friendlyMessage,
      playerStatus: null,
      temp: null,
      throttled: null,
      vlcMemoryMb: null,
      vlcCpuPercent: null,
      serviceActiveState: null,
      serviceSubState: null,
      serviceRestartCount: null,
      uptime: null,
      bootId: null,
      displayMode: null
    };
  }
}

async function loadDeviceStatuses(inventory: DashboardState["inventory"]): Promise<Record<string, DeviceLiveStatus>> {
  const entries = await Promise.all(
    inventory.devices.items.map(async (device) => {
      const hostConfigured = Boolean(device.host.trim()) && device.host !== "Not configured";
      if (!hostConfigured) {
        return [device.id, null] as const;
      }

      const probe = await loadPiProbe(piConfigForDevice(device));
      const status = probe.playerStatus;
      const playbackState = status?.state ?? (probe.reachable ? "unknown" : "unreachable");
      const isPlaying = playbackState === "playing";
      const ageMs = statusAgeMs(status?.updatedAt);
      const fresh = ageMs !== null && ageMs <= staleStatusThresholdMs;
      const playbackHealthy = isPlaying && fresh;

      return [
        device.id,
        {
          ageLabel: formatStatusAge(status?.updatedAt),
          host: probe.host,
          playbackHealthy,
          playbackLabel: playbackHealthy ? "Playing" : isPlaying ? "Stale" : playbackState,
          playerStatus: status,
          reachable: probe.reachable,
          stale: isPlaying && !fresh,
          timestampLabel: formatTimestamp(status?.updatedAt)
        }
      ] as const;
    })
  );

  return Object.fromEntries(entries.filter((entry): entry is [string, DeviceLiveStatus] => entry[1] !== null));
}

function textBetween(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return "";
  }

  return value.slice(startIndex + start.length, endIndex).trim();
}

async function loadDashboardState(selectedPlaylistId?: string | null): Promise<DashboardState> {
  await ensureLocalDataFoundation();

  const root = repoRoot();
  const heartbeatPath = `${root}/device-agent/local-state/heartbeat.json`;
  const playlistStore = await readPlaylistStore();
  const playlist = selectPlaylist(playlistStore, selectedPlaylistId);
  const seedPlaylistId = playlistStore.items[0]?.playlistId ?? playlist.playlistId;
  const [heartbeat, inventory, publishStatus] = await Promise.all([
    readJsonFile<Heartbeat>(heartbeatPath),
    readNormalizedInventory(seedPlaylistId),
    readJsonFile<PublishStatus>(publishStatusPath())
  ]);
  const [pi, deviceStatuses] = await Promise.all([
    loadPiProbe(piConfigFromInventory(inventory)),
    loadDeviceStatuses(inventory)
  ]);
  const lastKnownPlayback = await resolveLastKnownPlayback(pi);

  return { deviceStatuses, heartbeat, inventory, lastKnownPlayback, playlist, playlistStore, publishStatus, pi };
}

function syncState(localVersion: number, piVersion: number | undefined, piReachable: boolean): PlaylistSyncState {
  if (!piReachable) {
    return {
      detail: "Beam cannot reach the screen right now. The last sent playlist remains saved locally.",
      label: "Waiting",
      tone: "muted"
    };
  }

  if (typeof piVersion !== "number") {
    return {
      detail: "Waiting for the screen to report what it has.",
      label: "Waiting for screen",
      tone: "warn"
    };
  }

  if (piVersion === localVersion) {
    return {
      detail: "The screen has this version.",
      label: "Screen current",
      tone: "good"
    };
  }

  if (piVersion < localVersion) {
    return {
      detail: "The screen has not confirmed these changes yet.",
      label: "Needs publish",
      tone: "warn"
    };
  }

  return {
    detail: "The screen is reporting a different version than Beam has saved.",
    label: "Mismatch",
    tone: "warn"
  };
}

function actionLabel(action: string | undefined): string {
  return {
    "add-media": "Add media",
    "move-down": "Move down",
    "move-up": "Move up",
    publish: "Publish now",
    "playlist-create": "Create playlist",
    reorder: "Reorder",
    remove: "Remove",
    "restore-baseline": "Restore baseline",
    "update-item": "Edit item",
    upload: "Upload"
  }[action ?? ""] ?? "Not recorded";
}

function nameList<TItem>(items: TItem[], getName: (item: TItem) => string, emptyLabel: string): string {
  if (items.length === 0) {
    return emptyLabel;
  }

  return items.map(getName).join(", ");
}

function publishStateLabel(publishStatus: PublishStatus | null): string {
  if (!publishStatus) {
    return "Not published";
  }

  if (publishStatus.ok) {
    return "Sent";
  }

  return publishStatus.piPublishEnabled ? "Publish not verified" : "Pending publish";
}

function shortPublishDetail(publishStatus: PublishStatus | null): string {
  if (!publishStatus) {
    return "Not sent yet";
  }

  if (publishStatus.ok) {
    return `Sent ${formatTimestamp(publishStatus.timestamp)}`;
  }

  return publishStatus.piPublishEnabled ? "Needs attention" : "Saved locally";
}

function publishStatusDisplayMessage(publishStatus: PublishStatus): string {
  if (publishStatus.message.includes("could not verify every media file on the Pi")) {
    return "Saved locally. Beam cannot verify every media file on the Pi until the Pi and media are available.";
  }

  if (publishStatus.message.includes("did not complete")) {
    return "Saved locally. Beam could not complete the Pi publish check. Check Pi connectivity and publish again.";
  }

  return publishStatus.message;
}

function playlistLiveStatus(
  playlistSyncState: PlaylistSyncState,
  publishStatus: PublishStatus | null,
  assignedScreensLabel: string
): PlaylistSyncState {
  if (assignedScreensLabel === "No screens assigned") {
    return {
      detail: "Choose a screen before this playlist can go live.",
      label: "No screen",
      tone: "muted"
    };
  }

  if (publishStatus && !publishStatus.ok && publishStatus.piPublishEnabled) {
    return {
      detail: "The playlist is saved locally, but Beam could not verify it on the Pi.",
      label: "Publish not verified",
      tone: "warn"
    };
  }

  if (publishStatus && !publishStatus.ok && !publishStatus.piPublishEnabled) {
    return {
      detail: "Saved locally. Publish manually when this playlist is ready for the screen.",
      label: "Pending publish",
      tone: "warn"
    };
  }

  if (playlistSyncState.tone === "good") {
    return {
      detail: "Live on the assigned screen.",
      label: "Live",
      tone: "good"
    };
  }

  if (playlistSyncState.label === "Not live") {
    if (publishStatus?.ok) {
      return {
        detail: "Sent, but the screen has not confirmed it yet.",
        label: "Sent",
        tone: "muted"
      };
    }

    return {
      detail: "Not sent to a screen yet.",
      label: "Not published",
      tone: "muted"
    };
  }

  return playlistSyncState;
}

function shortScreenDetail(playlistLiveState: PlaylistSyncState): string {
  if (playlistLiveState.tone === "good") {
    return "Screen is current.";
  }

  return playlistLiveState.detail;
}

type EvidenceItem = {
  label: string;
  value: string;
  detail: string;
  tone: "good" | "warn" | "muted";
  timestamp?: string | null;
};

type AttentionItem = {
  detail: string;
  label: string;
  tone: "good" | "warn" | "muted";
};

type FleetCommandRow = {
  assignedPlaylistAssetCount: number | null;
  assignedPlaylistDuration: string | null;
  assignedPlaylistName: string;
  detail: string;
  group: string;
  healthLabel: string;
  healthTone: "good" | "warn" | "muted";
  host: string;
  id: string;
  isLive: boolean;
  location: string;
  name: string;
  needsAttention: boolean;
  playbackLabel: string;
  screenId: string;
  screenName: string;
  syncLabel: string;
  syncTone: "good" | "warn" | "muted";
};

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function normalizeIdentity(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function publishRequiredDetail(localVersion: number, reportedVersion: number | string): string {
  return `Beam v${localVersion}; Pi v${reportedVersion}. Publish required.`;
}

function fleetCommandRows({
  deviceStatuses,
  inventory,
  isPlaying,
  isPlayerStatusFresh,
  lastKnownPlayback,
  pi,
  playbackHealthy,
  playbackLabel,
  playlistStore
}: {
  deviceStatuses: DashboardState["deviceStatuses"];
  inventory: DashboardState["inventory"];
  isPlaying: boolean;
  isPlayerStatusFresh: boolean;
  lastKnownPlayback: LastKnownPlayback | null;
  pi: PiProbe;
  playbackHealthy: boolean;
  playbackLabel: string;
  playlistStore: PlaylistStore;
}): FleetCommandRow[] {
  const screensByDeviceId = new Map<string, ScreenRecord>();
  const playlistsById = new Map(playlistStore.items.map((item) => [item.playlistId, item]));
  const livePlaylistId = pi.playerStatus?.playlistId ?? null;
  const livePlaylistVersion = pi.playerStatus?.playlistVersion;

  for (const screen of inventory.screens.items) {
    if (screen.deviceId) {
      screensByDeviceId.set(screen.deviceId, screen);
    }
  }

  for (const screen of inventory.screens.items) {
    const deviceId = inventory.devices.items.find((device) => device.screenId === screen.id)?.id;
    if (deviceId && !screensByDeviceId.has(deviceId)) {
      screensByDeviceId.set(deviceId, screen);
    }
  }

  return inventory.devices.items
    .filter((device) => screensByDeviceId.has(device.id))
    .slice()
    .sort(
      (left, right) =>
        left.group.localeCompare(right.group, undefined, { sensitivity: "base" }) ||
        left.location.localeCompare(right.location, undefined, { sensitivity: "base" }) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    )
    .map((device) => {
      const linkedScreen = screensByDeviceId.get(device.id) ?? null;
      const assignedPlaylistId = linkedScreen?.playlistId ?? device.playlistId;
      const assignedPlaylist = assignedPlaylistId ? playlistsById.get(assignedPlaylistId) ?? null : null;
      const hostConfigured = Boolean(device.host.trim()) && device.host !== "Not configured";
      const deviceStatus = deviceStatuses[device.id];
      const isLive = Boolean(deviceStatus) || Boolean(pi.host && normalizeIdentity(device.host) === normalizeIdentity(pi.host));
      const reachable = deviceStatus?.reachable ?? (isLive ? pi.reachable : false);
      const reportedPlaylistId = deviceStatus?.playerStatus?.playlistId ?? (isLive ? livePlaylistId : null);
      const reportedPlaylistVersion = deviceStatus?.playerStatus?.playlistVersion ?? (isLive ? livePlaylistVersion : undefined);
      const rowPlaybackHealthy = deviceStatus?.playbackHealthy ?? (isLive ? playbackHealthy : false);
      const rowPlaybackLabel = deviceStatus?.playbackLabel ?? (isLive ? playbackLabel : "Unknown");
      const livePlaybackStale = deviceStatus?.stale ?? (isLive && isPlaying && !isPlayerStatusFresh);
      const healthLabel = !hostConfigured ? "No host" : isLive ? (reachable ? "Online" : "Offline") : "Not reporting";
      const healthTone = !hostConfigured ? "warn" : isLive ? (reachable ? "good" : "warn") : "muted";
      let syncDetail = "No playlist is assigned to this screen.";
      let syncLabel = "Unassigned";
      let syncTone: "good" | "warn" | "muted" = "warn";

      if (assignedPlaylistId && !assignedPlaylist) {
        syncDetail = "This screen points to a playlist Beam cannot find locally.";
        syncLabel = "Review";
      } else if (assignedPlaylist && !isLive) {
        syncDetail = "No live playlist report has been received for this saved screen.";
        syncLabel = "Unknown";
        syncTone = "muted";
      } else if (assignedPlaylist && !reachable) {
        syncDetail = "Beam cannot reach this screen to confirm the playlist.";
        syncLabel = "Waiting";
        syncTone = "muted";
      } else if (assignedPlaylist && !reportedPlaylistId) {
        syncDetail = "The screen has not reported a playlist update yet.";
        syncLabel = "Unknown";
      } else if (assignedPlaylist && reportedPlaylistId !== assignedPlaylist.playlistId) {
        const reportedPlaylist = reportedPlaylistId ? playlistsById.get(reportedPlaylistId)?.name ?? "another playlist" : "another playlist";
        syncDetail = `Beam expects ${assignedPlaylist.name}; Pi reports ${reportedPlaylist}. Publish required.`;
        syncLabel = "Publish required";
      } else if (assignedPlaylist && reportedPlaylistVersion === assignedPlaylist.version) {
        syncDetail = `${assignedPlaylist.name} is on the screen.`;
        syncLabel = "In sync";
        syncTone = "good";
      } else if (assignedPlaylist && typeof reportedPlaylistVersion === "number" && reportedPlaylistVersion < assignedPlaylist.version) {
        syncDetail = publishRequiredDetail(assignedPlaylist.version, reportedPlaylistVersion);
        syncLabel = "Publish required";
      } else if (assignedPlaylist) {
        syncDetail = `Beam v${assignedPlaylist.version}; Pi v${reportedPlaylistVersion ?? "unknown"}. Review required.`;
        syncLabel = "Review";
      }

      const playback = isLive ? (!reachable ? "No live report" : rowPlaybackHealthy ? "Playing" : rowPlaybackLabel) : "Unknown";
      const needsAttention =
        !hostConfigured ||
        syncTone === "warn" ||
        (isLive && (!reachable || !rowPlaybackHealthy || livePlaybackStale)) ||
        (!isLive && hostConfigured);
      const detail = !hostConfigured
        ? "Add a local address before this Pi can report."
        : isLive
          ? reachable
            ? syncDetail
            : offlinePlaybackDetail(lastKnownPlayback)
          : "This Pi is saved in Beam, but it is not checking in yet.";

      return {
        assignedPlaylistAssetCount: assignedPlaylist?.assets.length ?? null,
        assignedPlaylistDuration: assignedPlaylist ? formatDuration(assignedPlaylist.assets) : null,
        assignedPlaylistName: assignedPlaylist?.name ?? "No playlist assigned",
        detail,
        group: linkedScreen?.group ?? device.group,
        healthLabel,
        healthTone,
        host: device.host,
        id: device.id,
        isLive,
        location: linkedScreen?.location ?? device.location,
        name: linkedScreen ? `${linkedScreen.name} Pi` : device.name,
        needsAttention,
        playbackLabel: playback,
        screenId: linkedScreen?.id ?? device.screenId ?? device.id,
        screenName: linkedScreen?.name ?? "No screen linked",
        syncLabel,
        syncTone
      };
    });
}

function scalarSearchParam(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.trim() || null;
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const resolvedSearchParams = await searchParams;
  const selectedView = dashboardViewFrom(resolvedSearchParams?.view);
  const selectedPlaylistParam = scalarSearchParam(resolvedSearchParams?.playlist);
  const currentViewCopy = viewCopy[selectedView];
  const { deviceStatuses, heartbeat, inventory, lastKnownPlayback, playlist, playlistStore, publishStatus, pi } =
    await loadDashboardState(selectedPlaylistParam);
  const selectedScreenParam = scalarSearchParam(resolvedSearchParams?.screen);
  const playerStatus = pi.playerStatus;
  const playbackState = playerStatus?.state ?? (pi.reachable ? "unknown" : "unreachable");
  const isPlaying = playbackState === "playing";
  const playerStatusAgeMs = statusAgeMs(playerStatus?.updatedAt);
  const isPlayerStatusFresh = playerStatusAgeMs !== null && playerStatusAgeMs <= staleStatusThresholdMs;
  const heartbeatAgeMs = statusAgeMs(heartbeat?.timestamp);
  const isHeartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= staleHeartbeatThresholdMs;
  const playbackHealthy = isPlaying && isPlayerStatusFresh;
  const playbackLabel = playbackHealthy ? "Playing" : isPlaying ? "Stale" : playbackState;
  const playerFreshnessDetail = statusFreshnessDetail(pi, playerStatus, isPlayerStatusFresh);
  const localScreenName = screenLabel(pi, heartbeat, isHeartbeatFresh);
  const localLocationName = locationLabel();
  const localDeviceIdentifier = deviceIdentifier(pi, heartbeat, isHeartbeatFresh);
  const playerUpdatedAt = formatTimestamp(playerStatus?.updatedAt);
  const lastPlayerHeartbeatAge = formatStatusAge(playerStatus?.updatedAt);
  const totalDuration = formatDuration(playlist.assets);
  const playlistOptions = playlistStore.items;
  const firstPlaylistId = playlistOptions[0]?.playlistId ?? playlist.playlistId;
  const devicesById = new Map(inventory.devices.items.map((device) => [device.id, device]));
  const devicesByScreenId = new Map(
    inventory.devices.items
      .filter((device) => device.screenId)
      .map((device) => [device.screenId as string, device])
  );
  const publishStatusForSelected = publishStatus?.playlistId
    ? publishStatus.playlistId === playlist.playlistId
      ? publishStatus
      : null
    : playlist.playlistId === firstPlaylistId
      ? publishStatus
      : null;
  const piPlaylistVersion = playerStatus?.playlistVersion;
  function playlistScreens(playlistId: string) {
    return inventory.screens.items
      .filter((screen) => screen.playlistId === playlistId)
      .slice()
      .sort((left, right) =>
        left.location.localeCompare(right.location, undefined, { sensitivity: "base" }) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      );
  }

  function linkedDeviceForScreen(screen: ScreenRecord): DeviceRecord | null {
    return (screen.deviceId ? devicesById.get(screen.deviceId) : null) ?? devicesByScreenId.get(screen.id) ?? null;
  }

  function syncStateForPlaylist(option: Playlist): PlaylistSyncState {
    const screensForPlaylist = playlistScreens(option.playlistId);
    if (screensForPlaylist.length === 0) {
      return {
        detail: "Publish this playlist when it is ready for a screen.",
        label: "Not live",
        tone: "muted"
      };
    }

    const screenStates = screensForPlaylist.map((screen) => {
      const device = linkedDeviceForScreen(screen);
      const status = device ? deviceStatuses[device.id] : null;
      const reportsThisPlaylist = status?.playerStatus?.playlistId === option.playlistId;
      const state = reportsThisPlaylist
        ? syncState(option.version, status?.playerStatus?.playlistVersion, status?.reachable ?? false)
        : {
            detail: device
              ? `${screen.name} has not reported this playlist yet.`
              : `${screen.name} does not have a linked Pi.`,
            label: "Not live",
            tone: "muted" as const
          };

      return { screen, state, status };
    });
    const unconfirmed = screenStates.find((entry) => entry.state.tone !== "good");
    if (unconfirmed) {
      return {
        detail: `${unconfirmed.screen.name}: ${unconfirmed.state.detail}`,
        label: unconfirmed.state.label,
        tone: unconfirmed.state.tone
      };
    }

    return {
      detail:
        screenStates.length === 1
          ? `${screenStates[0].screen.name} reports this playlist version.`
          : `All ${screenStates.length} assigned screens report this playlist version.`,
      label: "Screen current",
      tone: "good"
    };
  }

  const playlistSyncState = syncStateForPlaylist(playlist);
  const piPlayerUrl =
    process.env.PISIGNAGE_PLAYER_URL?.trim() ||
    (pi.host ? `http://${pi.host}:5173/?playlist=/playlist.local.json` : null);
  const readyAssetCount = playlist.assets.filter((asset) => {
    const fileName = asset.uri.split("/").filter(Boolean).at(-1) ?? asset.uri;
    return asset.type === "video" && isPlaybackSafeVideoFileName(fileName);
  }).length;
  const needsPrepAssetCount = playlist.assets.length - readyAssetCount;
  const playlistReportingStatus = playlistScreens(playlist.playlistId)
    .map((screen) => {
      const device = linkedDeviceForScreen(screen);
      return device ? deviceStatuses[device.id] : null;
    })
    .find((status) => status?.playerStatus?.playlistId === playlist.playlistId);
  const playlistReportedByPi = Boolean(playlistReportingStatus);
  const piAssetIds = new Set(
    playlistReportingStatus?.playerStatus?.assetIds ??
      (playerStatus?.playlistId === playlist.playlistId ? playerStatus.assetIds ?? [] : [])
  );
  const troubleshootingScreens = inventory.screens.items
    .map((screen) => {
      const linkedDevice =
        linkedDeviceForScreen(screen);
      const assignedPlaylist = screen.playlistId
        ? playlistStore.items.find((item) => item.playlistId === screen.playlistId)
        : null;

      return {
        deviceHost: linkedDevice?.host ?? null,
        deviceId: linkedDevice?.id ?? null,
        deviceName: linkedDevice?.name ?? null,
        group: screen.group,
        id: screen.id,
        location: screen.location,
        name: screen.name,
        playlistName: assignedPlaylist?.name ?? null
      };
    })
    .sort(
      (left, right) =>
        left.location.localeCompare(right.location, undefined, { sensitivity: "base" }) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
  function publishStatusForPlaylist(option: Playlist): PublishStatus | null {
    if (!publishStatus) {
      return null;
    }

    if (publishStatus.playlistId) {
      return publishStatus.playlistId === option.playlistId ? publishStatus : null;
    }

    return option.playlistId === firstPlaylistId ? publishStatus : null;
  }

  const assignedScreens = playlistScreens(playlist.playlistId);
  const assignedScreensLabel = nameList(assignedScreens, (screen) => screen.name, "No screens assigned");
  const selectedPlaylistLiveState = playlistLiveStatus(
    playlistSyncState,
    publishStatusForSelected,
    assignedScreensLabel
  );
  const playlistAssetFileNames = playlist.assets.map((asset) => fileNameFromUri(asset.uri));
  const playlistSwitchOptions = playlistOptions.map((option) => ({
    assetCount: option.assets.length,
    durationLabel: formatDuration(option.assets),
    name: option.name,
    playlistId: option.playlistId
  }));
  const attentionItems: AttentionItem[] = [];

  if (!pi.configured) {
    attentionItems.push({
      detail: "Add Pi SSH settings in dashboard/.env.local.",
      label: "Pi not configured",
      tone: "warn"
    });
  } else if (!pi.reachable) {
    attentionItems.push({
      detail: pi.message,
      label: "Pi unreachable",
      tone: "warn"
    });
  }

  if (!playbackHealthy) {
    attentionItems.push({
      detail: playerFreshnessDetail,
      label: isPlaying ? "Playback status stale" : "Playback not confirmed",
      tone: "warn"
    });
  }

  if (playlistSyncState.tone !== "good") {
    attentionItems.push({
      detail: playlistSyncState.detail,
      label: "Playlist sync",
      tone: playlistSyncState.tone
    });
  }

  if (publishStatusForSelected && !publishStatusForSelected.ok && publishStatusForSelected.piPublishEnabled) {
    attentionItems.push({
      detail: publishStatusDisplayMessage(publishStatusForSelected),
      label: "Publish not verified",
      tone: "warn"
    });
  }

  const fleetRows = fleetCommandRows({
    deviceStatuses,
    inventory,
    isPlaying,
    isPlayerStatusFresh,
    lastKnownPlayback,
    pi,
    playbackHealthy,
    playbackLabel,
    playlistStore
  });
  const onlineDeviceCount = fleetRows.filter((row) => row.healthLabel === "Online").length;
  const offlineDeviceCount = fleetRows.filter((row) => row.healthLabel === "Offline").length;
  const notReportingDeviceCount = fleetRows.filter((row) => row.healthLabel === "Not reporting").length;
  const disconnectedDeviceCount = offlineDeviceCount + notReportingDeviceCount;
  const playingDeviceCount = fleetRows.filter((row) => row.playbackLabel === "Playing").length;
  const staleDeviceCount = fleetRows.filter((row) => row.isLive && isPlaying && !isPlayerStatusFresh).length;
  const syncIssueCount = fleetRows.filter((row) => row.syncTone === "warn").length;
  const playingDetail = playingDeviceCount > 0
    ? staleDeviceCount > 0
      ? `${staleDeviceCount} stale report`
      : "live report confirmed"
    : disconnectedDeviceCount > 0
      ? "no live connection"
      : "waiting for playback";
  const screenDetail = offlineDeviceCount > 0
    ? `${offlineDeviceCount} offline`
    : notReportingDeviceCount > 0
      ? `${notReportingDeviceCount} not reporting`
      : syncIssueCount > 0
        ? `${syncIssueCount} sync issue`
        : "all reporting";
  const fleetAttentionCount = fleetRows.filter((row) => row.needsAttention).length;
  const fleetExceptions = fleetRows
    .filter((row) => row.needsAttention)
    .sort((left, right) => Number(right.isLive) - Number(left.isLive))
    .slice(0, 8);
  const systemExceptions = attentionItems.filter((item) => item.label === "Publish not verified");
  const commandAttentionCount = fleetAttentionCount + systemExceptions.length;
  const commandCenterReady = commandAttentionCount === 0 && onlineDeviceCount > 0;
  const systemStatusLabel = commandCenterReady ? "Ready" : commandAttentionCount > 0 ? "Review" : "Watching";
  const systemStatusTone = commandCenterReady ? "good" : commandAttentionCount > 0 ? "warn" : "muted";
  const focusedScreen =
    fleetRows.find((row) => row.screenId === selectedScreenParam || row.id === selectedScreenParam) ??
    fleetRows.find((row) => row.isLive) ??
    fleetRows[0] ??
    null;
  const focusedScreenIsLive = Boolean(focusedScreen?.isLive);
  const focusedScreenName = focusedScreen?.screenName ?? localScreenName;
  const focusedScreenLocation = focusedScreen
    ? `${focusedScreen.location} · ${focusedScreen.group}`
    : localLocationName;
  const focusedPlaybackLabel = focusedScreen?.playbackLabel ?? playbackLabel;
  const focusedSyncLabel = focusedScreen?.syncLabel ?? playlistSyncState.label;
  const focusedScreenHost = focusedScreen?.host || pi.host || "No host";
  const focusedOfflineDuration = focusedScreenIsLive && !pi.reachable ? offlineDurationLabel(lastKnownPlayback) : null;
  const focusedLastKnownPlayback =
    focusedScreenIsLive && !pi.reachable ? lastKnownPlaybackLabel(lastKnownPlayback) : null;
  const focusedScreenTitle = focusedScreenIsLive
    ? pi.reachable
      ? focusedScreen.assignedPlaylistName
      : "Screen offline"
    : "Waiting for check-in";
  const focusedScreenDetail = focusedScreenIsLive
    ? pi.reachable
      ? focusedScreen.syncTone === "good"
        ? `VLC reports ${focusedScreen.assignedPlaylistName} is in sync. Exact item position is not reported yet across the ${pluralize(focusedScreen.assignedPlaylistAssetCount ?? 0, "item")} loop.`
        : focusedScreen.detail
      : offlinePlaybackDetail(lastKnownPlayback)
    : "This screen is saved in Beam. Once it checks in, its current playback will appear here.";
  const focusedLastReportLabel = focusedScreenIsLive
    ? pi.reachable
      ? formatStatusAge(playerStatus?.updatedAt)
      : "unavailable"
    : "not checking in";
  const focusedLiveSummary = focusedScreenIsLive
    ? pi.reachable
      ? focusedPlaybackLabel === "Playing"
        ? "Playing live"
        : focusedPlaybackLabel
      : "Offline"
    : "Not reporting";
  const focusedScreenSummary = focusedScreenIsLive && pi.reachable
    ? `${focusedLiveSummary} · ${focusedSyncLabel} · Last report ${focusedLastReportLabel}`
    : [focusedOfflineDuration ?? focusedLiveSummary, focusedLastKnownPlayback ?? "Playback unknown"].join(" · ");
  const previewEyebrow = focusedScreenIsLive && pi.reachable ? "Showing now" : "Screen status";
  const focusedPlayerUrl =
    focusedScreenIsLive && piPlayerUrl
      ? piPlayerUrl
      : focusedScreen?.host && focusedScreen.host !== "Not configured"
        ? `http://${focusedScreen.host}:5173/?playlist=/playlist.local.json`
        : null;
  const setupLocationName = focusedScreen?.location ?? localLocationName;
  const setupScreenName = focusedScreen?.screenName ?? localScreenName;
  const setupDeviceIdentifier =
    focusedScreen?.host && focusedScreen.host !== "No host" ? focusedScreen.host : localDeviceIdentifier;
  const recoveryEvidence: EvidenceItem[] = [
    {
      label: "Playback report",
      value: playbackHealthy ? "Fresh and playing" : isPlaying ? "Playing but stale" : "Needs attention",
      detail: `${playerFreshnessDetail} ${playerStatus?.lastError ? `Last error: ${playerStatus.lastError}` : "No VLC error reported."}`,
      tone: playbackHealthy ? "good" : "warn",
      timestamp: playerStatus?.updatedAt
    },
    {
      label: "Playback service",
      value: serviceLabel(pi.serviceActiveState, pi.serviceSubState),
      detail: `Systemd reports ${pi.serviceRestartCount ?? "unknown"} restart(s) this boot.`,
      tone: serviceTone(pi.serviceActiveState)
    },
    {
      label: "Restart recovery",
      value: bootRecoveryLabel(pi, playbackHealthy),
      detail: bootRecoveryDetail(pi),
      tone: playbackHealthy ? "good" : pi.reachable ? "warn" : "muted"
    },
    {
      label: "Playlist update",
      value: playlistSyncState.label,
      detail: `${playlistSyncState.detail} Local v${playlist.version}; Pi ${piPlaylistVersion ? `v${piPlaylistVersion}` : "unknown"}.`,
      tone: playlistSyncState.tone
    },
    {
      label: "Last send",
      value: publishStatusForSelected
        ? publishStatusForSelected.ok
          ? "Succeeded"
          : publishStatusForSelected.piPublishEnabled
            ? "Needs attention"
            : "Pending publish"
        : "Not recorded",
      detail: publishStatusForSelected
        ? `${actionLabel(publishStatusForSelected.action)} wrote playlist v${publishStatusForSelected.playlistVersion}. ${publishStatusDisplayMessage(publishStatusForSelected)}`
        : "No local publish status file has been written yet.",
      tone: publishStatusForSelected
        ? publishStatusForSelected.ok
          ? "good"
          : "warn"
        : "muted",
      timestamp: publishStatusForSelected?.timestamp
    },
    {
      label: "TV output",
      value: formatDisplayMode(playerStatus?.displayMode) ?? pi.displayMode ?? "Unknown",
      detail: playerStatus?.displayOutput ? `Output ${playerStatus.displayOutput}.` : "No display output was reported by VLC status.",
      tone: playerStatus?.displayMode || pi.displayMode ? "good" : "warn"
    },
    {
      label: "Pi temperature",
      value: formatTemperature(pi.temp),
      detail: `Throttle ${formatThrottle(pi.throttled)}.`,
      tone: pi.temp && pi.throttled ? "good" : "warn"
    }
  ];
  const supportEvidence = recoveryEvidence
    .slice()
    .sort((left, right) => {
      const rank = { warn: 0, muted: 1, good: 2 };
      return rank[left.tone] - rank[right.tone];
    });
  const supportAttentionCount = recoveryEvidence.filter((item) => item.tone === "warn").length;

  return (
    <main className="min-h-screen [overflow-x:clip] bg-[#f3f6f8] text-zinc-950">
      <DashboardAutoRefresh />
      <div className="grid min-h-screen lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="border-b border-cyan-200 bg-[radial-gradient(circle_at_top_left,rgba(94,234,212,0.34),transparent_44%),linear-gradient(180deg,#e4fbf7_0%,#f1fbff_48%,#ffffff_100%)] px-5 py-5 text-slate-950 shadow-[inset_-1px_0_0_rgba(20,184,166,0.2)] lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:py-6">
          <div className="flex flex-wrap items-end justify-between gap-2 lg:block">
            <div>
              <div className="inline-flex items-center gap-3" aria-label="Beam">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-950 shadow-sm" aria-hidden="true">
                  <svg viewBox="0 0 36 36" className="h-9 w-9">
                    <rect x="0" y="0" width="36" height="36" rx="8" fill="#0f172a" />
                    <rect x="8" y="10" width="14" height="16" rx="2.5" fill="none" stroke="#f8fafc" strokeWidth="2.4" />
                    <path d="M20 13.5L30 9.5V26.5L20 22.5V13.5Z" fill="#5eead4" />
                    <path d="M20 16L30 13V23L20 20V16Z" fill="#ccfbf1" opacity="0.8" />
                  </svg>
                </span>
                <span className="bg-gradient-to-r from-slate-950 via-teal-950 to-teal-700 bg-clip-text text-[2rem] font-black leading-none tracking-normal text-transparent [font-family:'Trebuchet_MS',ui-rounded,'Avenir_Next_Rounded','Arial_Rounded_MT_Bold',system-ui,sans-serif]">
                  Beam
                </span>
              </div>
            </div>
          </div>
          <nav aria-label="Dashboard views" className="mt-5 grid grid-cols-2 gap-2 text-sm font-medium text-slate-700 sm:grid-cols-3 md:flex md:flex-wrap lg:mt-8 lg:block lg:space-y-1">
            {navigationItems.map((item) => {
              const selected = item.view === selectedView;

              return (
              <a
                key={item.view}
                href={item.view === "dashboard" ? "/" : `/?view=${item.view}`}
                aria-current={selected ? "page" : undefined}
                className={`block whitespace-nowrap rounded-md px-3 py-2 text-center transition focus:outline-none focus:ring-2 focus:ring-teal-500 lg:text-left ${
                  selected ? "bg-white text-teal-950 shadow-sm ring-1 ring-cyan-200" : "hover:bg-white/70 hover:text-teal-950"
                }`}
              >
                {item.label}
              </a>
              );
            })}
          </nav>
        </aside>

        <div className="mx-auto w-full min-w-0 max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
          <header id="dashboard" className="flex flex-col gap-4 border-b border-zinc-200 pb-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              {currentViewCopy.eyebrow ? (
                <p className="text-sm font-semibold uppercase text-teal-700">{currentViewCopy.eyebrow}</p>
              ) : null}
              <h1 className="mt-1 text-3xl font-bold tracking-tight text-zinc-950 sm:text-4xl">{currentViewCopy.title}</h1>
              {currentViewCopy.description ? (
                <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
                  {currentViewCopy.description}
                </p>
              ) : null}
            </div>
          </header>

          <section
            aria-labelledby="operations-heading"
            className={selectedView === "dashboard" ? "mt-5" : "hidden"}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 id="operations-heading" className="text-2xl font-semibold">Command center</h2>
              </div>
              <p className={`text-sm font-semibold ${systemStatusTone === "good" ? "text-emerald-700" : systemStatusTone === "warn" ? "text-amber-800" : "text-zinc-600"}`}>
                {systemStatusLabel}
              </p>
            </div>
            <dl className="mt-4 grid gap-3 md:grid-cols-3">
              <div className={`rounded-lg border p-4 shadow-sm ${onlineDeviceCount > 0 ? "border-emerald-200 bg-emerald-50" : "border-zinc-200 bg-white"}`}>
                <dt className="text-xs font-semibold uppercase text-emerald-800">Online</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{onlineDeviceCount}</dd>
                <dd className="mt-1 text-sm text-zinc-600">of {pluralize(fleetRows.length, "screen")}</dd>
              </div>
              <div className={`rounded-lg border p-4 shadow-sm ${playingDeviceCount > 0 ? "border-sky-200 bg-sky-50" : "border-zinc-200 bg-white"}`}>
                <dt className="text-xs font-semibold uppercase text-sky-800">Live signal</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{playingDeviceCount}</dd>
                <dd className="mt-1 text-sm text-zinc-600">{playingDetail}</dd>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 shadow-sm">
                <dt className="text-xs font-semibold uppercase text-teal-800">Screens</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{inventory.screens.items.length}</dd>
                <dd className="mt-1 text-sm text-zinc-600">{screenDetail}</dd>
              </div>
            </dl>
          </section>

          <section
            aria-labelledby="now-playing-heading"
            className={selectedView === "dashboard" ? "mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]" : "hidden"}
          >
            <div className="order-2 rounded-lg border border-zinc-200 bg-white shadow-sm xl:order-2">
              <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 id="now-playing-heading" className="mt-1 text-2xl font-semibold">{commandAttentionCount === 0 ? "All clear" : "Exceptions"}</h2>
                  <p className="mt-1 text-sm text-zinc-600">
                    {commandAttentionCount === 0
                      ? "Beam has nothing urgent to call out."
                      : "What Beam cannot verify right now."}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <a
                    href="/?view=device-health"
                    className="inline-flex min-h-10 items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-zinc-950 ring-1 ring-zinc-200 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    Screen Health
                  </a>
                </div>
              </div>
              {systemExceptions.length > 0 || fleetExceptions.length > 0 ? (
                <ol className="divide-y divide-zinc-200">
                  {systemExceptions.map((item) => (
                    <li key={`${item.label}-${item.detail}`} className="grid gap-3 px-5 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="break-words font-semibold text-zinc-950">{item.label}</p>
                          <StatusPill label="Expected while offline" tone="warn" />
                        </div>
                        <p className="mt-1 break-words text-zinc-600">Local playlist is saved. Pi verification is unavailable right now.</p>
                      </div>
                      <div className="sm:justify-self-end">
                        <a
                          href="/?view=playlist"
                          className="inline-flex min-h-10 items-center rounded-md px-3 py-2 font-semibold text-teal-800 ring-1 ring-teal-200 hover:bg-teal-50 focus:outline-none focus:ring-2 focus:ring-teal-600"
                        >
                          Review
                        </a>
                      </div>
                    </li>
                  ))}
                  {fleetExceptions.map((row) => (
                    <li key={row.id} className="grid gap-3 px-5 py-4 text-sm">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="break-words font-semibold text-zinc-950">{row.name}</p>
                          <p className="mt-1 break-words text-zinc-600">{row.location} · {row.group}</p>
                        </div>
                        <StatusPill label={row.healthLabel} tone={row.healthTone} />
                      </div>
                      <p className="break-words leading-6 text-zinc-600">{row.detail}</p>
                      <div>
                        <a
                          href="/?view=screens"
                          className="inline-flex min-h-10 items-center rounded-md px-3 py-2 font-semibold text-teal-800 ring-1 ring-teal-200 hover:bg-teal-50 focus:outline-none focus:ring-2 focus:ring-teal-600"
                        >
                          Manage
                        </a>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="border-t border-zinc-200 px-5 py-4 text-sm text-zinc-600">
                  Everything Beam can see is looking good.
                </div>
              )}
            </div>

            <div className="order-1 space-y-4 xl:order-1">
              <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
                <div className="flex flex-col gap-4 border-b border-zinc-200 p-5">
                  <div>
                    <h2 className="mt-1 text-2xl font-semibold">Screen preview</h2>
                    <p className="mt-1 text-sm text-zinc-600">{focusedScreenLocation} · {focusedScreenSummary}</p>
                  </div>
                  <form method="get" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <label htmlFor="screen-focus" className="sr-only">Choose screen to preview</label>
                    <select
                      id="screen-focus"
                      name="screen"
                      defaultValue={focusedScreen?.screenId ?? ""}
                      className="min-h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    >
                      {fleetRows.length === 0 ? (
                        <option value="">No screens in inventory</option>
                      ) : (
                        fleetRows.map((row) => (
                          <option key={row.id} value={row.screenId}>
                            {row.screenName} · {row.location}
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      type="submit"
                      className="inline-flex min-h-10 items-center justify-center rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    >
                      Show
                    </button>
                  </form>
                </div>
                <div className="p-5">
                  <div className="rounded-[1.25rem] border border-zinc-700 bg-zinc-900 p-3 shadow-xl shadow-zinc-300/60">
                    <div className="relative overflow-hidden rounded-xl bg-[linear-gradient(145deg,#236b66_0%,#0f766e_38%,#0e7490_68%,#1e3a8a_100%)] px-4 pb-9 pt-5 text-white shadow-inner ring-1 ring-white/20">
                      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.22)_0%,rgba(255,255,255,0.08)_34%,rgba(255,255,255,0)_70%)]" />
                      <div className="relative flex min-h-[260px] flex-col justify-between gap-5">
                        <div>
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold uppercase text-cyan-100/80">{previewEyebrow}</p>
                              <p className="mt-2 break-words text-3xl font-black leading-tight sm:text-4xl">{focusedScreenTitle}</p>
                            </div>
                            {focusedPlayerUrl ? (
                              <a
                                href={focusedPlayerUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-50 focus:outline-none focus:ring-2 focus:ring-cyan-200"
                              >
                                Open player
                              </a>
                            ) : null}
                          </div>
                          <p className="mt-3 max-w-sm text-sm leading-6 text-cyan-50/80">{focusedScreenDetail}</p>
                        </div>
                        <div className="grid gap-2 text-sm sm:grid-cols-2">
                          <div className="rounded-lg bg-white/10 p-3 ring-1 ring-white/10">
                            <p className="font-semibold text-cyan-50/70">Screen</p>
                            <p className="mt-1 break-words font-semibold text-white">{focusedScreenName}</p>
                          </div>
                          <div className="rounded-lg bg-white/10 p-3 ring-1 ring-white/10">
                            <p className="font-semibold text-cyan-50/70">Host</p>
                            <p className="mt-1 break-words font-semibold text-white">{focusedScreenHost}</p>
                          </div>
                          <div className="rounded-lg bg-white/10 p-3 ring-1 ring-white/10">
                            <p className="font-semibold text-cyan-50/70">Loop</p>
                            <p className="mt-1 font-semibold text-white">
                              {focusedScreen?.assignedPlaylistAssetCount ?? playlist.assets.length} items · {focusedScreen?.assignedPlaylistDuration ?? totalDuration}
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="absolute bottom-3 left-1/2 h-2 w-24 -translate-x-1/2 rounded-full bg-white/30" aria-hidden="true" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section
            id="fleet-health"
            className={selectedView === "device-health" ? "" : "hidden"}
          >
            <DeviceHealthFleetPanel
              deviceStatuses={deviceStatuses}
              devices={inventory.devices.items}
              screens={inventory.screens.items}
              liveHost={pi.host}
              livePlayerUrl={piPlayerUrl}
              livePlaylistId={playerStatus?.playlistId ?? null}
              livePlaybackHealthy={playbackHealthy}
              livePlaybackState={playbackLabel}
              livePlaylistVersion={typeof piPlaylistVersion === "number" ? piPlaylistVersion : null}
              liveReachable={pi.reachable}
              liveStatusStale={Boolean(pi.configured && isPlaying && !isPlayerStatusFresh)}
              playlists={playlistStore.items.map((item) => ({
                name: item.name,
                playlistId: item.playlistId,
                version: item.version
              }))}
              statusAgeLabel={lastPlayerHeartbeatAge}
              statusUpdatedAt={playerStatus?.updatedAt ?? null}
              statusTimestampLabel={playerUpdatedAt}
            />
          </section>

          <section
            aria-labelledby="recovery-history-heading"
            className={selectedView === "device-health" ? "mt-6 rounded-lg border border-zinc-200 bg-white shadow-sm" : "hidden"}
          >
            <details>
              <summary className="flex cursor-pointer items-center justify-between gap-3 border-b border-zinc-200 p-5 text-xl font-semibold" id="recovery-history-heading">
                <span>Playback evidence</span>
                <StatusPill
                  label={
                    supportAttentionCount === 0
                      ? "All clear"
                      : `${supportAttentionCount} ${supportAttentionCount === 1 ? "item needs" : "items need"} attention`
                  }
                  tone={supportAttentionCount === 0 ? "good" : "warn"}
                />
              </summary>
              <div className="px-5 pb-2 pt-4">
                <p className="text-sm text-zinc-600">
                  Detailed local evidence from the connected Pi. Items that need attention appear first.
                </p>
              </div>
              <ol className="divide-y divide-zinc-200">
                {supportEvidence.map((item) => (
                  <li key={item.label} className="grid gap-3 px-5 py-4 text-sm md:grid-cols-[180px_1fr_auto] md:items-start">
                    <div>
                      <p className="font-semibold text-zinc-950">{item.label}</p>
                      <p className="mt-1 text-xs font-medium text-zinc-500">{item.timestamp ? formatTimestamp(item.timestamp) : "Latest check"}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-zinc-950">{item.value}</p>
                      <p className="mt-1 leading-6 text-zinc-600">{item.detail}</p>
                    </div>
                    <div className="md:justify-self-end">
                      <StatusPill label={item.tone === "good" ? "OK" : item.tone === "warn" ? "Check" : "Info"} tone={item.tone} />
                    </div>
                  </li>
                ))}
              </ol>
            </details>
          </section>

          <section
            id="field-setup"
            aria-labelledby="field-setup-heading"
            className={selectedView === "device-health" ? "mt-6 rounded-lg border border-zinc-200 bg-white shadow-sm" : "hidden"}
          >
            <details>
              <summary className="cursor-pointer border-b border-zinc-200 p-5 text-xl font-semibold" id="field-setup-heading">
                Setup and Pi details
              </summary>
              <div className="grid gap-4 p-5 xl:grid-cols-[1.1fr_0.9fr]">
                <div className="rounded-md border border-zinc-200 bg-zinc-50">
                  <div className="border-b border-zinc-200 p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <h2 className="text-lg font-semibold">{setupLocationName}</h2>
                        <p className="mt-1 text-sm text-zinc-600">Local setup from saved configuration and the latest Pi check.</p>
                      </div>
                      <StatusPill label={pi.reachable ? "Online" : "Offline"} tone={pi.reachable ? "good" : "warn"} />
                    </div>
                  </div>
                  <dl className="grid gap-0 divide-y divide-zinc-200 text-sm sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                    <div className="p-5">
                      <dt className="font-semibold text-zinc-500">Screen</dt>
                      <dd className="mt-2 text-lg font-semibold">{setupScreenName}</dd>
                      <dd className="mt-1 text-zinc-600">Pi: {setupDeviceIdentifier}</dd>
                    </div>
                    <div className="p-5">
                      <dt className="font-semibold text-zinc-500">Last local status</dt>
                      <dd className="mt-2 text-lg font-semibold">{playerUpdatedAt}</dd>
                      <dd className="mt-1 text-zinc-600">{pi.message}</dd>
                    </div>
                  </dl>
                </div>

                <div id="device-health" className="rounded-md border border-zinc-200 bg-zinc-50 p-5">
                  <h2 className="text-lg font-semibold">Pi readings</h2>
                  <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                    <Metric label="Temperature" value={formatTemperature(pi.temp)} />
                    <Metric label="Throttle" value={formatThrottle(pi.throttled)} />
                    <Metric label="Uptime" value={pi.uptime ?? "Unknown"} />
                    <Metric label="Disk free" value={isHeartbeatFresh ? formatBytes(heartbeat?.diskFreeBytes) : "Not reported"} />
                  </dl>
                </div>
              </div>
            </details>
          </section>

          <section
            id="screen-health-diagnostics"
            aria-labelledby="screen-health-diagnostics-heading"
            className={selectedView === "device-health" ? "mt-6" : "hidden"}
          >
            <h2 id="screen-health-diagnostics-heading" className="sr-only">Screen Health Diagnostics</h2>
            <TroubleshootingPanel screens={troubleshootingScreens} />
          </section>

          <section
            id="media-store"
            aria-labelledby="media-store-heading"
            className={selectedView === "media-store" ? "mt-6" : "hidden"}
          >
            <h2 id="media-store-heading" className="sr-only">Media Store</h2>
            <MediaStorePanel />
          </section>

          <section
            id="screens"
            aria-labelledby="screens-heading"
            className={selectedView === "screens" ? "mt-6" : "hidden"}
          >
            <h2 id="screens-heading" className="sr-only">Screens</h2>
            <div>
              <ScreenDeviceInventoryPanel
                deviceStatuses={deviceStatuses}
                liveHost={pi.host}
                livePlaybackHealthy={playbackHealthy}
                livePlaybackState={playbackLabel}
                livePlaylistId={playerStatus?.playlistId ?? null}
                livePlaylistVersion={typeof piPlaylistVersion === "number" ? piPlaylistVersion : null}
                liveReachable={pi.reachable}
                liveStatusStale={Boolean(pi.configured && isPlaying && !isPlayerStatusFresh)}
                playlistId={playlist.playlistId}
                playlists={playlistStore.items.map((item) => ({
                  assetCount: item.assets.length,
                  name: item.name,
                  playlistId: item.playlistId,
                  version: item.version
                }))}
                statusAgeLabel={lastPlayerHeartbeatAge}
                statusTimestampLabel={playerUpdatedAt}
              />
            </div>
          </section>

          <section
            id="scheduling"
            aria-labelledby="scheduling-heading"
            className={selectedView === "scheduling" ? "" : "hidden"}
          >
            <h2 id="scheduling-heading" className="sr-only">Scheduling</h2>
            <SchedulingPanel />
          </section>

          <section
            id="playlist"
            aria-labelledby="playlist-heading"
            className={selectedView === "playlist" ? "mt-6 space-y-4" : "hidden"}
          >
            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-teal-700">Active playlist</p>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                    <h2 id="playlist-heading" className="min-w-0 truncate text-3xl font-semibold tracking-normal text-zinc-950" title={playlist.name}>
                      {playlist.name}
                    </h2>
                    <LocalPlaylistRenameButton name={playlist.name} playlistId={playlist.playlistId} />
                    <LocalPlaylistDeleteButton
                      assignedScreenCount={assignedScreens.length}
                      isOnlyPlaylist={playlistOptions.length <= 1}
                      name={playlist.name}
                      playlistId={playlist.playlistId}
                    />
                  </div>
                  <p className="mt-2 max-w-3xl text-sm text-zinc-600">
                    Editing {playlist.name}. Add media, tune the order, then publish this playlist{assignedScreens.length === 0 ? " after assigning a screen." : ` to ${assignedScreensLabel}.`}
                  </p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end xl:flex-col xl:items-stretch">
                  <LocalPlaylistSwitcher currentPlaylistId={playlist.playlistId} playlists={playlistSwitchOptions} />
                </div>
              </div>
              <div className="grid border-t border-zinc-200 text-sm sm:grid-cols-2 xl:grid-cols-4">
                <div className="border-b border-zinc-200 p-3 sm:border-r xl:border-b-0">
                  <p className="font-semibold text-zinc-500">Contents</p>
                  <p className="mt-1 font-semibold text-zinc-950">{playlist.assets.length} items · {totalDuration}</p>
                </div>
                <div className="border-b border-zinc-200 p-3 xl:border-b-0 xl:border-r">
                  <p className="font-semibold text-zinc-500">Screens</p>
                  <p className="mt-1 truncate font-semibold text-zinc-950" title={assignedScreensLabel}>{assignedScreensLabel}</p>
                </div>
                <div className="border-b border-zinc-200 p-3 sm:border-r sm:border-b-0">
                  <p className="font-semibold text-zinc-500">Sync</p>
                  <p className="mt-1 font-semibold text-zinc-950">{selectedPlaylistLiveState.label}</p>
                </div>
                <div className="p-3">
                  <p className="font-semibold text-zinc-500">Last publish</p>
                  <p className="mt-1 font-semibold text-zinc-950">{publishStateLabel(publishStatusForSelected)}</p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-xl font-semibold">Build and publish</h3>
                  <p className="mt-1 text-sm text-zinc-600">Add media, tune the sequence, assign screens, then publish the active playlist.</p>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <StatusPill label={`${playlist.assets.length} items`} tone="muted" />
                  <StatusPill label={totalDuration} tone="muted" />
                  <StatusPill label={`${readyAssetCount} ready`} tone="good" />
                  {needsPrepAssetCount > 0 ? <StatusPill label={`${needsPrepAssetCount} needs prep`} tone="warn" /> : null}
                </div>
              </div>
              <div className="grid xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="min-w-0 xl:border-r xl:border-zinc-200">
                  <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-lg font-semibold">Sequence</h4>
                    <p className="mt-1 text-sm text-zinc-600">
                      {playlist.assets.length === 0 ? "No media in this playlist yet." : "Order, timing, and item names for the active playlist."}
                    </p>
                  </div>
                  </div>
                  <LocalPlaylistBuilder
                    playlistAssetFileNames={playlistAssetFileNames}
                    playlistId={playlist.playlistId}
                  />
                  {playlist.assets.length > 0 ? (
                    <LocalPlaylistTimeline
                      assets={playlist.assets}
                      piAssetIds={Array.from(piAssetIds)}
                      playlistId={playlist.playlistId}
                    />
                  ) : (
                    <div className="px-5 py-5 text-sm text-zinc-600">
                      Add local media to this playlist before assigning or publishing.
                    </div>
                  )}
                  <LocalPlaylistSequence
                    assets={playlist.assets}
                    piAssetIds={Array.from(piAssetIds)}
                    playlistId={playlist.playlistId}
                  />
                </div>

                <aside className="p-5 xl:sticky xl:top-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h4 className="text-lg font-semibold">Publish active playlist</h4>
                      <p className="mt-1 text-sm text-zinc-600">{playlist.name} · {shortScreenDetail(selectedPlaylistLiveState)}</p>
                    </div>
                    <StatusPill label={selectedPlaylistLiveState.label} tone={selectedPlaylistLiveState.tone} />
                  </div>
                  <dl className="mt-4 grid gap-2 text-sm">
                    <div className="rounded-md bg-zinc-50 p-3">
                      <dt className="font-semibold text-zinc-500">Last sent</dt>
                      <dd className="mt-1 font-semibold text-zinc-950">{publishStateLabel(publishStatusForSelected)}</dd>
                      <dd className="mt-1 text-zinc-600">{shortPublishDetail(publishStatusForSelected)}</dd>
                    </div>
                    <div className="rounded-md bg-zinc-50 p-3">
                      <dt className="font-semibold text-zinc-500">Screens</dt>
                      <dd className="mt-1 text-zinc-700">{assignedScreensLabel}</dd>
                    </div>
                    <div className="rounded-md bg-zinc-50 p-3">
                      <dt className="font-semibold text-zinc-500">Playlist</dt>
                      <dd className="mt-1 truncate text-zinc-700" title={playlist.name}>{playlist.name}</dd>
                    </div>
                  </dl>
                  <LocalPlaylistScreenAssignment playlistId={playlist.playlistId} />
                  <LocalPublishForm
                    assetCount={playlist.assets.length}
                    assignedScreenCount={assignedScreens.length}
                    assignmentTargetId="playlist-screen-assignment"
                    playlistId={playlist.playlistId}
                  />
                </aside>
              </div>
            </div>

            <details className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <summary className="flex cursor-pointer list-none flex-col gap-2 p-5 marker:hidden sm:flex-row sm:items-center sm:justify-between [&::-webkit-details-marker]:hidden">
                <div>
                  <h3 className="text-lg font-semibold">Playlist library</h3>
                  <p className="mt-1 text-sm text-zinc-600">{pluralize(playlistOptions.length, "playlist")} saved.</p>
                </div>
                <span className="inline-flex min-h-10 items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900">
                  Open library
                </span>
              </summary>
              <div className="flex flex-col gap-3 border-t border-zinc-200 p-5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-zinc-600">Create playlists or compare saved playlists without leaving the active workflow.</p>
                <div className="w-full sm:max-w-xl">
                  <LocalPlaylistCreateForm />
                </div>
              </div>
              <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
                {playlistOptions.map((option) => {
                  const rowScreens = playlistScreens(option.playlistId);
                  const rowScreensLabel = nameList(rowScreens, (screen) => screen.name, "No screens assigned");
                  const rowPublishStatus = publishStatusForPlaylist(option);
                  const rowSyncState = syncStateForPlaylist(option);
                  const rowLiveState = playlistLiveStatus(rowSyncState, rowPublishStatus, rowScreensLabel);
                  const isSelected = option.playlistId === playlist.playlistId;

                  return (
                    <a
                      key={option.playlistId}
                      href={`/?view=playlist&playlist=${encodeURIComponent(option.playlistId)}`}
                      aria-current={isSelected ? "page" : undefined}
                      className={`rounded-md border p-3 text-sm transition focus:outline-none focus:ring-2 focus:ring-teal-600 ${
                        isSelected
                          ? "border-teal-300 bg-teal-50 text-teal-950"
                          : "border-zinc-200 bg-white hover:border-teal-200 hover:bg-teal-50/40"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold" title={option.name}>{option.name}</p>
                          <p className="mt-1 text-zinc-600">{option.assets.length} items · {formatDuration(option.assets)}</p>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          {isSelected ? <StatusPill label="Active" tone="good" /> : null}
                          <StatusPill label={rowLiveState.label} tone={rowLiveState.tone} />
                        </div>
                      </div>
                      <p className="mt-2 truncate text-zinc-700" title={rowScreensLabel}>{rowScreensLabel}</p>
                      <p className="mt-1 text-xs text-zinc-500">{shortPublishDetail(rowPublishStatus)}</p>
                    </a>
                  );
                })}
              </div>
            </details>

          </section>

        </div>
      </div>
    </main>
  );
}
