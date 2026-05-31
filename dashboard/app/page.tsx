import { promises as fs } from "node:fs";
import { DashboardAutoRefresh } from "./dashboard-auto-refresh";
import { Metric, StatusPill } from "./dashboard-ui";
import { DeviceHealthFleetPanel } from "./device-health-fleet-panel";
import { ensureLocalDataFoundation } from "./lib/local-data-store";
import type { DeviceStore, ScreenRecord, ScreenStore } from "./lib/local-data-store";
import { ensureInventorySeed } from "./lib/local-inventory";
import { localStateDirectory, publishStatusPath, readLivePlaylist, repoRoot, writeFileAtomic } from "./lib/local-playlist";
import type { Playlist, PlaylistAsset } from "./lib/local-playlist";
import { readPiConfig, runSsh } from "./lib/pi-local";
import { MediaStorePanel } from "./media-store-panel";
import { LocalPlaylistBuilder } from "./local-playlist-builder";
import { LocalPublishForm } from "./local-publish-form";
import { LocalPlaylistControls } from "./local-playlist-controls";
import { LocalPlaylistItemEditor } from "./local-playlist-item-editor";
import { LocalPlaylistTimeline } from "./local-playlist-timeline";
import { ScreenDeviceInventoryPanel } from "./screen-device-inventory-panel";
import { LocalSystemActions } from "./local-system-actions";
import { LocalUploadForm } from "./local-upload-form";
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
  heartbeat: Heartbeat | null;
  inventory: {
    devices: DeviceStore;
    screens: ScreenStore;
  };
  lastKnownPlayback: LastKnownPlayback | null;
  playlist: Playlist;
  publishStatus: PublishStatus | null;
  pi: PiProbe;
};

type PublishStatus = {
  action: string;
  assetCount: number;
  message: string;
  ok: boolean;
  piPublishEnabled: boolean;
  playlistVersion: number;
  timestamp: string;
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
  | "scheduling"
  | "troubleshooting";

type DashboardPageProps = {
  searchParams?: Promise<{
    screen?: string | string[];
    view?: string | string[];
  }>;
};

const navigationItems: Array<{ label: string; view: DashboardView }> = [
  { label: "Dashboard", view: "dashboard" },
  { label: "Media Store", view: "media-store" },
  { label: "Playlist", view: "playlist" },
  { label: "Device health", view: "device-health" },
  { label: "Screens", view: "screens" },
  { label: "Scheduling", view: "scheduling" },
  { label: "Troubleshooting", view: "troubleshooting" }
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
    eyebrow: "Playback loop",
    title: "Playlist",
    description: "Arrange what plays and publish the local loop."
  },
  "device-health": {
    eyebrow: "Health",
    title: "Device Health",
    description: "Live playback, recovery, and Pi status."
  },
  screens: {
    eyebrow: "Inventory",
    title: "Screens",
    description: "Match screens to devices and the active playlist."
  },
  scheduling: {
    eyebrow: "Hours",
    title: "Scheduling",
    description: "Simple on and off windows for each screen."
  },
  troubleshooting: {
    eyebrow: "Support",
    title: "Troubleshooting",
    description: "Fix publish, playback, and Pi access issues."
  }
};

function dashboardViewFrom(value: string | string[] | undefined): DashboardView {
  const candidate = Array.isArray(value) ? value[0] : value;

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

function assetTypeLabel(asset: PlaylistAsset): string {
  if (asset.type === "video" && /\.still-\d+s(?:-\d+)?\.mp4$/i.test(asset.uri)) {
    return "Still clip";
  }

  return asset.type === "video" ? "Video" : "Image";
}

function assetTypeTone(asset: PlaylistAsset): "good" | "warn" | "muted" {
  if (asset.type === "video") {
    return "good";
  }

  return "warn";
}

function assetPlaybackLabel(asset: PlaylistAsset, playerStatus: PlayerStatus | null | undefined): string | null {
  if (!playerStatus?.assetIds?.includes(asset.assetId)) {
    return null;
  }

  return "On Pi";
}

function assetLabel(playlist: Playlist, assetId: string | null | undefined): string {
  if (!assetId) {
    return "No asset reported";
  }

  const asset = playlist.assets.find((candidate) => candidate.assetId === assetId);
  return asset?.altText ?? assetId;
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

function currentPlaybackLabel(
  playlist: Playlist,
  heartbeat: Heartbeat | null,
  isHeartbeatFresh: boolean,
  playbackHealthy: boolean
): string {
  if (isHeartbeatFresh && heartbeat?.currentAssetId) {
    return assetLabel(playlist, heartbeat.currentAssetId);
  }

  if (playbackHealthy) {
    return playlist.name;
  }

  return "Playback not confirmed";
}

function currentPlaybackDetail(
  playlist: Playlist,
  heartbeat: Heartbeat | null,
  isHeartbeatFresh: boolean,
  playbackHealthy: boolean
): string {
  if (isHeartbeatFresh && heartbeat?.currentAssetId) {
    return `Device agent updated ${formatStatusAge(heartbeat?.timestamp)}.`;
  }

  if (playbackHealthy) {
    return `VLC confirms this playlist is playing. Exact item position is not reported yet across the ${pluralize(playlist.assets.length, "item")} loop.`;
  }

  return "Waiting for a fresh VLC playback report.";
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

  return pi.host ?? "Device not configured";
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

async function loadPiProbe(): Promise<PiProbe> {
  const config = readPiConfig();

  if (!config) {
    return {
      configured: false,
      reachable: false,
      host: null,
      message: "Pi SSH is not configured in dashboard/.env.local.",
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

function textBetween(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return "";
  }

  return value.slice(startIndex + start.length, endIndex).trim();
}

async function loadDashboardState(): Promise<DashboardState> {
  await ensureLocalDataFoundation();

  const root = repoRoot();
  const heartbeatPath = `${root}/device-agent/local-state/heartbeat.json`;
  const playlist = await readLivePlaylist();
  const piConfig = readPiConfig();
  const [heartbeat, inventory, publishStatus, pi] = await Promise.all([
    readJsonFile<Heartbeat>(heartbeatPath),
    ensureInventorySeed({
      host: piConfig?.host ?? null,
      location: process.env.PISIGNAGE_LOCATION_NAME?.trim() || "Primary location",
      playlistId: playlist.playlistId,
      rootPath: piConfig?.root ?? null,
      screenName: process.env.PISIGNAGE_SCREEN_NAME?.trim() || "Primary Screen",
      sshUser: piConfig?.user ?? null
    }),
    readJsonFile<PublishStatus>(publishStatusPath()),
    loadPiProbe()
  ]);
  const lastKnownPlayback = await resolveLastKnownPlayback(pi);

  return { heartbeat, inventory, lastKnownPlayback, playlist, publishStatus, pi };
}

function syncState(localVersion: number, piVersion: number | undefined, piReachable: boolean) {
  if (!piReachable) {
    return {
      detail: "Beam cannot reach the Pi right now. The last published playlist remains saved locally.",
      label: "Waiting",
      tone: "muted" as const
    };
  }

  if (typeof piVersion !== "number") {
    return {
      detail: "Waiting for Pi playlist status.",
      label: "Unknown",
      tone: "warn" as const
    };
  }

  if (piVersion === localVersion) {
    return {
      detail: "Pi and local playlist versions match.",
      label: "In sync",
      tone: "good" as const
    };
  }

  if (piVersion < localVersion) {
    return {
      detail: "Pi has not reported the latest local playlist yet.",
      label: "Pi behind",
      tone: "warn" as const
    };
  }

  return {
    detail: "Pi is reporting a newer playlist than this dashboard has locally.",
    label: "Mismatch",
    tone: "warn" as const
  };
}

function actionLabel(action: string | undefined): string {
  return {
    "move-down": "Move down",
    "move-up": "Move up",
    publish: "Publish now",
    remove: "Remove",
    "restore-baseline": "Restore baseline",
    upload: "Upload"
  }[action ?? ""] ?? "Not recorded";
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

function fleetCommandRows({
  inventory,
  isPlaying,
  isPlayerStatusFresh,
  lastKnownPlayback,
  pi,
  playbackHealthy,
  playbackLabel,
  playlist,
  playlistSyncState
}: {
  inventory: DashboardState["inventory"];
  isPlaying: boolean;
  isPlayerStatusFresh: boolean;
  lastKnownPlayback: LastKnownPlayback | null;
  pi: PiProbe;
  playbackHealthy: boolean;
  playbackLabel: string;
  playlist: Playlist;
  playlistSyncState: { detail: string; label: string; tone: "good" | "warn" | "muted" };
}): FleetCommandRow[] {
  const screensByDeviceId = new Map<string, ScreenRecord>();

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
    .slice()
    .sort(
      (left, right) =>
        left.group.localeCompare(right.group, undefined, { sensitivity: "base" }) ||
        left.location.localeCompare(right.location, undefined, { sensitivity: "base" }) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    )
    .map((device) => {
      const linkedScreen = screensByDeviceId.get(device.id) ?? null;
      const hostConfigured = Boolean(device.host.trim()) && device.host !== "Not configured";
      const isLive = Boolean(pi.host && normalizeIdentity(device.host) === normalizeIdentity(pi.host));
      const livePlaybackStale = isLive && isPlaying && !isPlayerStatusFresh;
      const healthLabel = !hostConfigured ? "No host" : isLive ? (pi.reachable ? "Online" : "Offline") : "Not reporting";
      const healthTone = !hostConfigured ? "warn" : isLive ? (pi.reachable ? "good" : "warn") : "muted";
      const deviceAssignedToPlaylist = device.playlistId === playlist.playlistId;
      const syncLabel = !deviceAssignedToPlaylist ? "Unassigned" : isLive ? playlistSyncState.label : "Unknown";
      const syncTone = !deviceAssignedToPlaylist ? "warn" : isLive ? playlistSyncState.tone : "muted";
      const playback = isLive ? (!pi.reachable ? "No live report" : playbackHealthy ? "Playing" : playbackLabel) : "Unknown";
      const needsAttention =
        !hostConfigured ||
        !deviceAssignedToPlaylist ||
        (isLive && (!pi.reachable || !playbackHealthy || livePlaybackStale || playlistSyncState.tone !== "good")) ||
        (!isLive && hostConfigured);
      const detail = !hostConfigured
        ? "Add a host before this device can report."
        : isLive
          ? pi.reachable
            ? playlistSyncState.detail
            : offlinePlaybackDetail(lastKnownPlayback)
          : "This device is saved in Beam, but it is not checking in yet.";

      return {
        detail,
        group: linkedScreen?.group ?? device.group,
        healthLabel,
        healthTone,
        host: device.host,
        id: device.id,
        isLive,
        location: linkedScreen?.location ?? device.location,
        name: device.name,
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
  const currentViewCopy = viewCopy[selectedView];
  const { heartbeat, inventory, lastKnownPlayback, playlist, publishStatus, pi } = await loadDashboardState();
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
  const currentPlayback = currentPlaybackLabel(playlist, heartbeat, isHeartbeatFresh, playbackHealthy);
  const currentPlaybackStatus = currentPlaybackDetail(playlist, heartbeat, isHeartbeatFresh, playbackHealthy);
  const localScreenName = screenLabel(pi, heartbeat, isHeartbeatFresh);
  const localLocationName = locationLabel();
  const localDeviceIdentifier = deviceIdentifier(pi, heartbeat, isHeartbeatFresh);
  const playerUpdatedAt = formatTimestamp(playerStatus?.updatedAt);
  const lastPlayerHeartbeatAge = formatStatusAge(playerStatus?.updatedAt);
  const totalDuration = formatDuration(playlist.assets);
  const piPlaylistVersion = playerStatus?.playlistVersion;
  const playlistSyncState = syncState(playlist.version, piPlaylistVersion, pi.reachable);
  const lastPublishLabel = publishStatus
    ? `${actionLabel(publishStatus.action)} · ${formatTimestamp(publishStatus.timestamp)}`
    : "No publish recorded";
  const piPlayerUrl =
    process.env.PISIGNAGE_PLAYER_URL?.trim() ||
    (pi.host ? `http://${pi.host}:5173/?playlist=/playlist.local.json` : null);
  const videoAssetCount = playlist.assets.filter((asset) => asset.type === "video").length;
  const imageAssetCount = playlist.assets.length - videoAssetCount;
  const piAssetIds = new Set(playerStatus?.assetIds ?? []);
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

  if (publishStatus && !publishStatus.ok) {
    attentionItems.push({
      detail: publishStatus.message,
      label: "Publish failed",
      tone: "warn"
    });
  }

  const fleetRows = fleetCommandRows({
    inventory,
    isPlaying,
    isPlayerStatusFresh,
    lastKnownPlayback,
    pi,
    playbackHealthy,
    playbackLabel,
    playlist,
    playlistSyncState
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
  const systemExceptions = attentionItems.filter((item) => item.label === "Publish failed");
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
      ? currentPlayback
      : "Screen offline"
    : "Waiting for check-in";
  const focusedScreenDetail = focusedScreenIsLive
    ? pi.reachable
      ? currentPlaybackStatus
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
  const recoveryEvidence: EvidenceItem[] = [
    {
      label: "Playback heartbeat",
      value: playbackHealthy ? "Fresh and playing" : isPlaying ? "Playing but stale" : "Needs attention",
      detail: `${playerFreshnessDetail} ${playerStatus?.lastError ? `Last error: ${playerStatus.lastError}` : "No VLC error reported."}`,
      tone: playbackHealthy ? "good" : "warn",
      timestamp: playerStatus?.updatedAt
    },
    {
      label: "VLC service",
      value: serviceLabel(pi.serviceActiveState, pi.serviceSubState),
      detail: `Systemd reports ${pi.serviceRestartCount ?? "unknown"} restart(s) this boot.`,
      tone: serviceTone(pi.serviceActiveState)
    },
    {
      label: "Boot recovery",
      value: bootRecoveryLabel(pi, playbackHealthy),
      detail: bootRecoveryDetail(pi),
      tone: playbackHealthy ? "good" : pi.reachable ? "warn" : "muted"
    },
    {
      label: "Playlist sync",
      value: playlistSyncState.label,
      detail: `${playlistSyncState.detail} Local v${playlist.version}; Pi ${piPlaylistVersion ? `v${piPlaylistVersion}` : "unknown"}.`,
      tone: playlistSyncState.tone
    },
    {
      label: "Last publish",
      value: publishStatus ? (publishStatus.ok ? "Succeeded" : "Needs attention") : "Not recorded",
      detail: publishStatus
        ? `${actionLabel(publishStatus.action)} wrote playlist v${publishStatus.playlistVersion}. ${publishStatus.message}`
        : "No local publish status file has been written yet.",
      tone: publishStatus ? (publishStatus.ok ? "good" : "warn") : "muted",
      timestamp: publishStatus?.timestamp
    },
    {
      label: "Display",
      value: formatDisplayMode(playerStatus?.displayMode) ?? pi.displayMode ?? "Unknown",
      detail: playerStatus?.displayOutput ? `Output ${playerStatus.displayOutput}.` : "No display output was reported by VLC status.",
      tone: playerStatus?.displayMode || pi.displayMode ? "good" : "warn"
    },
    {
      label: "Thermals",
      value: formatTemperature(pi.temp),
      detail: `Throttle ${formatThrottle(pi.throttled)}.`,
      tone: pi.temp && pi.throttled ? "good" : "warn"
    }
  ];

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f3f6f8] text-zinc-950">
      {selectedView === "dashboard" || selectedView === "device-health" ? <DashboardAutoRefresh /> : null}
      <div className="grid min-h-screen lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="border-b border-cyan-200 bg-gradient-to-b from-cyan-50 via-white to-slate-100 px-5 py-5 text-slate-950 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:py-6">
          <div className="flex flex-wrap items-end justify-between gap-2 lg:block">
            <div>
              <div className="text-2xl font-black tracking-tight">Beam</div>
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
                className={`block whitespace-nowrap rounded-md px-3 py-2 text-center focus:outline-none focus:ring-2 focus:ring-teal-600 lg:text-left ${
                  selected ? "bg-white text-teal-900 shadow-sm ring-1 ring-cyan-200" : "hover:bg-white/70"
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
                <dd className="mt-1 text-sm text-zinc-600">of {pluralize(fleetRows.length, "device")}</dd>
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
                    Device health
                  </a>
                </div>
              </div>
              {systemExceptions.length > 0 || fleetExceptions.length > 0 ? (
                <ol className="divide-y divide-zinc-200">
                  {systemExceptions.map((item) => (
                    <li key={`${item.label}-${item.detail}`} className="grid gap-3 px-5 py-4 text-sm lg:grid-cols-[minmax(180px,0.7fr)_minmax(0,1fr)_auto] lg:items-start">
                      <div className="min-w-0">
                        <p className="break-words font-semibold text-zinc-950">{item.label}</p>
                        <p className="mt-1 break-words text-zinc-600">Local operation</p>
                      </div>
                      <div className="min-w-0">
                        <StatusPill label="Check" tone={item.tone} />
                        <p className="mt-2 break-words leading-6 text-zinc-600">{item.detail}</p>
                      </div>
                      <div className="lg:justify-self-end">
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
                  <div className="rounded-[1.25rem] border border-zinc-800 bg-zinc-950 p-3 shadow-xl shadow-zinc-300/60">
                    <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-slate-950 via-zinc-900 to-teal-950 px-4 py-5 text-white ring-1 ring-white/10">
                      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/10 to-transparent" />
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
                            <p className="mt-1 font-semibold text-white">{playlist.assets.length} items · {totalDuration}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="mx-auto mt-3 h-2 w-24 rounded-full bg-zinc-700" aria-hidden="true" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section
            aria-labelledby="sync-heading"
            className={selectedView === "playlist" ? "mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm" : "hidden"}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="sync-heading" className="text-xl font-semibold">Publish sync</h2>
                <p className="mt-1 text-sm text-zinc-600">{playlistSyncState.detail}</p>
              </div>
              <StatusPill label={playlistSyncState.label} tone={playlistSyncState.tone} />
            </div>
            <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Local playlist</dt>
                <dd className="mt-2 text-lg font-semibold">v{playlist.version}</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Pi playlist</dt>
                <dd className="mt-2 text-lg font-semibold">{piPlaylistVersion ? `v${piPlaylistVersion}` : "Unknown"}</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Last publish</dt>
                <dd className="mt-2 text-sm font-semibold text-zinc-950">{lastPublishLabel}</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Publish result</dt>
                <dd className="mt-2 text-sm font-semibold text-zinc-950">
                  {publishStatus ? (publishStatus.ok ? "Success" : "Needs attention") : "Not recorded"}
                </dd>
                {publishStatus ? <dd className="mt-1 text-sm text-zinc-600">{publishStatus.message}</dd> : null}
              </div>
            </dl>
            <LocalPublishForm />
          </section>

          <section
            id="fleet-health"
            className={selectedView === "device-health" ? "" : "hidden"}
          >
            <DeviceHealthFleetPanel
              devices={inventory.devices.items}
              screens={inventory.screens.items}
              liveHost={pi.host}
              livePlaybackHealthy={playbackHealthy}
              livePlaybackState={playbackLabel}
              livePlaylistVersion={typeof piPlaylistVersion === "number" ? piPlaylistVersion : null}
              liveReachable={pi.reachable}
              liveStatusStale={Boolean(pi.configured && isPlaying && !isPlayerStatusFresh)}
              playlistId={playlist.playlistId}
              playlistVersion={playlist.version}
              statusAgeLabel={lastPlayerHeartbeatAge}
              statusTimestampLabel={playerUpdatedAt}
            />
          </section>

          <section
            aria-labelledby="recovery-heading"
            className={selectedView === "device-health" ? "mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm" : "hidden"}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="recovery-heading" className="text-xl font-semibold">Recovery evidence</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  Latest boot, player, display, and health reports.
                </p>
              </div>
              <StatusPill
                label={serviceLabel(pi.serviceActiveState, pi.serviceSubState)}
                tone={serviceTone(pi.serviceActiveState)}
              />
            </div>
            <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Boot recovery</dt>
                <dd className="mt-2 text-lg font-semibold">{bootRecoveryLabel(pi, playbackHealthy)}</dd>
                <dd className="mt-1 text-sm text-zinc-600">{bootRecoveryDetail(pi)}</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">VLC service</dt>
                <dd className="mt-2 text-lg font-semibold">{serviceLabel(pi.serviceActiveState, pi.serviceSubState)}</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Auto restarts</dt>
                <dd className="mt-2 text-lg font-semibold">{pi.serviceRestartCount ?? "Unknown"}</dd>
                <dd className="mt-1 text-sm text-zinc-600">Crash recovery this boot</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Status age</dt>
                <dd className="mt-2 text-lg font-semibold">{formatStatusAge(playerStatus?.updatedAt)}</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Display</dt>
                <dd className="mt-2 text-lg font-semibold">{formatDisplayMode(playerStatus?.displayMode) ?? pi.displayMode ?? "Unknown"}</dd>
                <dd className="mt-1 text-sm text-zinc-600">{playerStatus?.displayOutput ?? "No output reported"}</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-4">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Thermals</dt>
                <dd className="mt-2 text-lg font-semibold">{formatTemperature(pi.temp)}</dd>
                <dd className="mt-1 text-sm text-zinc-600">Throttle {formatThrottle(pi.throttled)}</dd>
              </div>
            </dl>
          </section>

          <section
            aria-labelledby="recovery-history-heading"
            className={selectedView === "device-health" ? "mt-6 rounded-lg border border-zinc-200 bg-white shadow-sm" : "hidden"}
          >
            <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="recovery-history-heading" className="text-xl font-semibold">Recovery history</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  Latest local evidence the Pi reported for playback, service recovery, publish state, display, and health.
                </p>
              </div>
              <StatusPill label={playbackHealthy && playlistSyncState.tone === "good" ? "Ready" : "Review"} tone={playbackHealthy && playlistSyncState.tone === "good" ? "good" : "warn"} />
            </div>
            <ol className="divide-y divide-zinc-200">
              {recoveryEvidence.map((item) => (
                <li key={item.label} className="grid gap-3 px-5 py-4 text-sm md:grid-cols-[180px_1fr_auto] md:items-start">
                  <div>
                    <p className="font-semibold text-zinc-950">{item.label}</p>
                    <p className="mt-1 text-xs font-medium text-zinc-500">{item.timestamp ? formatTimestamp(item.timestamp) : "Latest probe"}</p>
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
          </section>

          <section
            id="field-setup"
            aria-labelledby="field-setup-heading"
            className={selectedView === "device-health" ? "mt-6 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]" : "hidden"}
          >
            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="border-b border-zinc-200 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 id="field-setup-heading" className="text-xl font-semibold">{localLocationName}</h2>
                    <p className="mt-1 text-sm text-zinc-600">Local field setup from live configuration and Pi status.</p>
                  </div>
                  <StatusPill label={pi.reachable ? "Online" : "Offline"} tone={pi.reachable ? "good" : "warn"} />
                </div>
              </div>
              <dl className="grid gap-0 divide-y divide-zinc-200 text-sm sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                <div className="p-5">
                  <dt className="font-semibold text-zinc-500">Screen</dt>
                  <dd className="mt-2 text-lg font-semibold">{localScreenName}</dd>
                  <dd className="mt-1 text-zinc-600">Device ID: {localDeviceIdentifier}</dd>
                </div>
                <div className="p-5">
                  <dt className="font-semibold text-zinc-500">Last local status</dt>
                  <dd className="mt-2 text-lg font-semibold">{playerUpdatedAt}</dd>
                  <dd className="mt-1 text-zinc-600">{pi.message}</dd>
                </div>
              </dl>
            </div>

            <div id="device-health" className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
              <h2 className="text-xl font-semibold">Device health</h2>
              <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                <Metric label="Temperature" value={formatTemperature(pi.temp)} />
                <Metric label="Throttle" value={formatThrottle(pi.throttled)} />
                <Metric label="Uptime" value={pi.uptime ?? "Unknown"} />
                <Metric label="Disk free" value={isHeartbeatFresh ? formatBytes(heartbeat?.diskFreeBytes) : "Not reported"} />
              </dl>
            </div>
          </section>

          <section
            aria-labelledby="system-actions-heading"
            className={selectedView === "device-health" ? "mt-6" : "hidden"}
          >
            <h2 id="system-actions-heading" className="sr-only">System actions</h2>
            <LocalSystemActions />
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
            <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
              <div>
                <h2 id="screens-heading" className="text-xl font-semibold">Screens</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  Add and manage screen and device inventory with live status and playlist assignment visibility.
                </p>
              </div>
            </div>
            <div className="mt-4">
              <ScreenDeviceInventoryPanel
                liveHost={pi.host}
                livePlaybackState={playbackLabel}
                livePlaylistVersion={typeof piPlaylistVersion === "number" ? piPlaylistVersion : null}
                liveReachable={pi.reachable}
                playlistId={playlist.playlistId}
                playlistVersion={playlist.version}
                statusAgeLabel={lastPlayerHeartbeatAge}
                statusTimestampLabel={playerUpdatedAt}
              />
            </div>
          </section>

          <section
            id="troubleshooting"
            aria-labelledby="troubleshooting-heading"
            className={selectedView === "troubleshooting" ? "" : "hidden"}
          >
            <h2 id="troubleshooting-heading" className="sr-only">Troubleshooting</h2>
            <TroubleshootingPanel />
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
            className={selectedView === "playlist" ? "mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]" : "hidden"}
          >
            <div className="min-w-0 rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 id="playlist-heading" className="text-xl font-semibold">{playlist.name}</h2>
                  <p className="mt-1 text-sm text-zinc-600">
                    Playlist ID: {playlist.playlistId} · Version {playlist.version} · Live local state
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <StatusPill label={`${playlist.assets.length} items`} tone="muted" />
                  <StatusPill label={`${totalDuration} loop`} tone="muted" />
                  <StatusPill label={`${videoAssetCount} video`} tone="good" />
                  {imageAssetCount > 0 ? <StatusPill label={`${imageAssetCount} raw image`} tone="warn" /> : null}
                </div>
              </div>
              <div className="grid gap-3 border-b border-zinc-200 bg-zinc-50 px-5 py-4 text-sm md:grid-cols-3">
                <div>
                  <p className="font-semibold text-zinc-950">Dashboard queue</p>
                  <p className="mt-1 text-zinc-600">The editable local playlist that upload, reorder, and remove actions update.</p>
                </div>
                <div>
                  <p className="font-semibold text-zinc-950">Pi reported media</p>
                  <p className="mt-1 text-zinc-600">
                    {playerStatus?.assetCount ?? "Unknown"} items from {piPlaylistVersion ? `playlist v${piPlaylistVersion}` : "an unknown playlist version"}.
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-zinc-950">Playback contract</p>
                  <p className="mt-1 text-zinc-600">VLC receives video assets; JPEG and PNG uploads are converted into Pi-safe MP4 still clips before publish.</p>
                </div>
              </div>
              <LocalPlaylistTimeline assets={playlist.assets} piAssetIds={Array.from(piAssetIds)} />
              <ul className="divide-y divide-zinc-200">
                {playlist.assets.map((asset, index) => {
                  const piPlaybackLabel = assetPlaybackLabel(asset, playerStatus);
                  const assetName = asset.altText ?? asset.assetId;
                  const fileName = fileNameFromUri(asset.uri);

                  return (
                  <li
                    key={asset.assetId}
                    className={`grid gap-4 px-5 py-5 text-sm lg:grid-cols-[56px_minmax(0,1fr)] ${
                      piAssetIds.has(asset.assetId) ? "bg-emerald-50/35" : ""
                    }`}
                  >
                    <div className="flex items-start gap-3 lg:block">
                      <span className="flex h-11 w-11 items-center justify-center rounded-md bg-zinc-100 text-sm font-bold text-zinc-700">
                        {index + 1}
                      </span>
                      <div className="lg:hidden">
                        <StatusPill label={assetTypeLabel(asset)} tone={assetTypeTone(asset)} />
                      </div>
                    </div>
                    <div className="min-w-0 space-y-3">
                      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="min-w-0 break-words text-base font-semibold leading-6 text-zinc-950">{assetName}</p>
                            <span className="hidden lg:inline-flex">
                              <StatusPill label={assetTypeLabel(asset)} tone={assetTypeTone(asset)} />
                            </span>
                            {piPlaybackLabel ? <StatusPill label={piPlaybackLabel} tone="good" /> : null}
                          </div>
                          <p className="mt-2 break-words text-sm leading-6 text-zinc-600">{fileName}</p>
                        </div>
                        <div className="flex flex-wrap gap-2 xl:justify-end">
                          <span className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-zinc-950 ring-1 ring-zinc-200">
                            {formatSeconds(asset.durationSeconds ?? 0)}
                          </span>
                          <span className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-zinc-950 ring-1 ring-zinc-200">
                            {piAssetIds.has(asset.assetId) ? "Reported" : "Pending"}
                          </span>
                          <LocalPlaylistControls
                            assetId={asset.assetId}
                            assetLabel={assetName}
                            isFirst={index === 0}
                            isLast={index === playlist.assets.length - 1}
                            isOnlyItem={playlist.assets.length === 1}
                          />
                        </div>
                      </div>
                      <LocalPlaylistItemEditor
                        assetId={asset.assetId}
                        defaultDurationSeconds={asset.durationSeconds ?? 30}
                        defaultTitle={assetName}
                      />
                      <dl className="grid gap-3 rounded-md bg-white/70 p-3 text-xs text-zinc-600 ring-1 ring-zinc-200 sm:grid-cols-2">
                        <div className="min-w-0">
                          <dt className="font-semibold uppercase text-zinc-500">Asset ID</dt>
                          <dd className="mt-1 break-all">{asset.assetId}</dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="font-semibold uppercase text-zinc-500">Path</dt>
                          <dd className="mt-1 break-words">{asset.uri}</dd>
                        </div>
                      </dl>
                    </div>
                  </li>
                  );
                })}
              </ul>
            </div>

            <div id="media" className="self-start rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
              <h2 className="text-xl font-semibold">Upload media</h2>
              <p className="mt-1 text-sm leading-6 text-zinc-600">
                Append local MP4/MOV video or JPEG/PNG images to the playlist. JPEG and PNG uploads are converted to Pi-safe MP4 still clips before VLC sees them.
              </p>
              <LocalUploadForm />
            </div>
          </section>

          <section
            aria-labelledby="playlist-builder-heading"
            className={selectedView === "playlist" ? "mt-4" : "hidden"}
          >
            <h2 id="playlist-builder-heading" className="sr-only">Playlist builder</h2>
            <LocalPlaylistBuilder playlistId={playlist.playlistId} />
          </section>

        </div>
      </div>
    </main>
  );
}
