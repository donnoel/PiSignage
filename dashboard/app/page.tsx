import { promises as fs } from "node:fs";
import { Metric, StatusPill } from "./dashboard-ui";
import { readDeviceLocation } from "./lib/local-device-location";
import type { DeviceLocation } from "./lib/local-device-location";
import { publishStatusPath, readLivePlaylist, repoRoot } from "./lib/local-playlist";
import type { Playlist, PlaylistAsset } from "./lib/local-playlist";
import { LocalDeviceLocationCapture } from "./local-device-location-capture";
import { LocalDeviceMap } from "./local-device-map";
import type { LocalMapDevice } from "./local-device-map";
import { readPiConfig, runSsh } from "./lib/pi-local";
import { LocalPublishForm } from "./local-publish-form";
import { LocalPlaylistControls } from "./local-playlist-controls";
import { LocalSystemActions } from "./local-system-actions";
import { LocalUploadForm } from "./local-upload-form";

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

type DashboardState = {
  heartbeat: Heartbeat | null;
  location: DeviceLocation | null;
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

type DashboardView = "dashboard" | "playlist" | "device-health" | "screens";

type DashboardPageProps = {
  searchParams?: Promise<{
    view?: string | string[];
  }>;
};

const navigationItems: Array<{ label: string; view: DashboardView }> = [
  { label: "Dashboard", view: "dashboard" },
  { label: "Playlist", view: "playlist" },
  { label: "Device health", view: "device-health" },
  { label: "Screens", view: "screens" }
];

const viewCopy: Record<DashboardView, { eyebrow: string; title: string; description?: string }> = {
  dashboard: {
    eyebrow: "Alpha operations",
    title: "Dashboard"
  },
  playlist: {
    eyebrow: "Content operations",
    title: "Playlist",
    description: "Content queue and publishing."
  },
  "device-health": {
    eyebrow: "System health",
    title: "Device Health",
    description: "Player and hardware diagnostics."
  },
  screens: {
    eyebrow: "Screen inventory",
    title: "Screens",
    description: "Map, status, and assignments."
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

function localConfigLabel(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

type MapBounds = {
  maxLatitude: number;
  maxLongitude: number;
  minLatitude: number;
  minLongitude: number;
};

function mapBounds(location: DeviceLocation): MapBounds {
  const latitudePadding = 0.012;
  const longitudePadding = 0.018;

  return {
    maxLatitude: location.latitude + latitudePadding,
    maxLongitude: location.longitude + longitudePadding,
    minLatitude: location.latitude - latitudePadding,
    minLongitude: location.longitude - longitudePadding
  };
}

function embeddedMapUrl(bounds: MapBounds): string {
  const url = new URL("https://www.openstreetmap.org/export/embed.html");

  url.searchParams.set(
    "bbox",
    [
      bounds.minLongitude,
      bounds.minLatitude,
      bounds.maxLongitude,
      bounds.maxLatitude
    ].join(",")
  );
  url.searchParams.set("layer", "mapnik");

  return url.toString();
}

function mapPoint(location: DeviceLocation, bounds: MapBounds): { xPercent: number; yPercent: number } {
  const xPercent = ((location.longitude - bounds.minLongitude) / (bounds.maxLongitude - bounds.minLongitude)) * 100;
  const yPercent = ((bounds.maxLatitude - location.latitude) / (bounds.maxLatitude - bounds.minLatitude)) * 100;

  return {
    xPercent: Math.min(92, Math.max(8, xPercent)),
    yPercent: Math.min(92, Math.max(12, yPercent))
  };
}

function coordinateLabel(location: DeviceLocation | null): string {
  if (!location) {
    return "Coordinates not captured";
  }

  return `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
}

function locationAccuracyLabel(location: DeviceLocation | null): string {
  if (!location?.accuracyMeters) {
    return "Accuracy not reported";
  }

  return `Accuracy about ${Math.round(location.accuracyMeters)} m`;
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

function currentAssetLabel(playlist: Playlist, heartbeat: Heartbeat | null, isHeartbeatFresh: boolean): string {
  if (!isHeartbeatFresh) {
    return "Current item unavailable";
  }

  return assetLabel(playlist, heartbeat?.currentAssetId);
}

function currentAssetDetail(heartbeat: Heartbeat | null, isHeartbeatFresh: boolean, playbackHealthy: boolean): string {
  if (isHeartbeatFresh) {
    return `Device agent updated ${formatStatusAge(heartbeat?.timestamp)}.`;
  }

  if (playbackHealthy) {
    return "VLC is playing. Current-item reporting is not available yet.";
  }

  return "Waiting for a fresh playback report.";
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
  const root = repoRoot();
  const heartbeatPath = `${root}/device-agent/local-state/heartbeat.json`;
  const [playlist, heartbeat, location, publishStatus, pi] = await Promise.all([
    readLivePlaylist(),
    readJsonFile<Heartbeat>(heartbeatPath),
    readDeviceLocation(),
    readJsonFile<PublishStatus>(publishStatusPath()),
    loadPiProbe()
  ]);

  return { heartbeat, location, playlist, publishStatus, pi };
}

function syncState(localVersion: number, piVersion: number | undefined, piReachable: boolean) {
  if (!piReachable || typeof piVersion !== "number") {
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

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const resolvedSearchParams = await searchParams;
  const selectedView = dashboardViewFrom(resolvedSearchParams?.view);
  const currentViewCopy = viewCopy[selectedView];
  const { heartbeat, location, playlist, publishStatus, pi } = await loadDashboardState();
  const playerStatus = pi.playerStatus;
  const playbackState = playerStatus?.state ?? (pi.reachable ? "unknown" : "unreachable");
  const isPlaying = playbackState === "playing";
  const playerStatusAgeMs = statusAgeMs(playerStatus?.updatedAt);
  const isPlayerStatusFresh = playerStatusAgeMs !== null && playerStatusAgeMs <= staleStatusThresholdMs;
  const heartbeatAgeMs = statusAgeMs(heartbeat?.timestamp);
  const isHeartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= staleHeartbeatThresholdMs;
  const playbackHealthy = isPlaying && isPlayerStatusFresh;
  const playbackLabel = playbackHealthy ? "Playing" : isPlaying ? "Stale" : playbackState;
  const playbackMetric = playbackHealthy ? "Live" : isPlaying ? "Stale" : "Check";
  const playerFreshnessDetail = statusFreshnessDetail(pi, playerStatus, isPlayerStatusFresh);
  const currentAsset = currentAssetLabel(playlist, heartbeat, isHeartbeatFresh);
  const currentAssetStatus = currentAssetDetail(heartbeat, isHeartbeatFresh, playbackHealthy);
  const localScreenName = screenLabel(pi, heartbeat, isHeartbeatFresh);
  const localLocationName = locationLabel();
  const localDeviceIdentifier = deviceIdentifier(pi, heartbeat, isHeartbeatFresh);
  const bounds = location ? mapBounds(location) : null;
  const mapUrl = bounds ? embeddedMapUrl(bounds) : null;
  const mapDevices: LocalMapDevice[] = location && bounds
    ? [
        {
          accuracy: locationAccuracyLabel(location),
          capturedAt: formatTimestamp(location.capturedAt),
          coordinates: coordinateLabel(location),
          currentAsset,
          host: localDeviceIdentifier,
          id: localDeviceIdentifier,
          label: localScreenName,
          location: localLocationName,
          playlist: `${playlist.name} · v${playlist.version}`,
          status: playbackLabel,
          statusTone: playbackHealthy ? "good" : "warn",
          ...mapPoint(location, bounds)
        }
      ]
    : [];
  const playerUpdatedAt = formatTimestamp(playerStatus?.updatedAt);
  const totalDuration = formatDuration(playlist.assets);
  const piPlaylistVersion = playerStatus?.playlistVersion;
  const playlistSyncState = syncState(playlist.version, piPlaylistVersion, pi.reachable);
  const lastPublishLabel = publishStatus
    ? `${actionLabel(publishStatus.action)} · ${formatTimestamp(publishStatus.timestamp)}`
    : "No publish recorded";
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

  if (!location) {
    attentionItems.push({
      detail: "Capture real coordinates for this screen.",
      label: "Location missing",
      tone: "warn"
    });
  }

  if (publishStatus && !publishStatus.ok) {
    attentionItems.push({
      detail: publishStatus.message,
      label: "Publish failed",
      tone: "warn"
    });
  }

  const screenSummary = pi.reachable ? "1 online" : pi.configured ? "1 offline" : "0 configured";
  const attentionSummary = attentionItems.length === 0 ? "Clear" : pluralize(attentionItems.length, "item");
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
    <main className="min-h-screen bg-[#f6f7f9] text-zinc-950">
      <div className="grid min-h-screen lg:grid-cols-[220px_1fr]">
        <aside className="border-b border-zinc-200 bg-white px-5 py-5 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:py-6">
          <div className="flex flex-wrap items-end justify-between gap-2 lg:block">
            <div>
              <div className="text-2xl font-black tracking-tight">PiSignage</div>
              <p className="mt-1 text-xs font-semibold uppercase text-teal-700">Local operations</p>
            </div>
            <StatusPill label="Alpha" tone="muted" />
          </div>
          <nav aria-label="Dashboard views" className="mt-5 flex gap-2 overflow-x-auto pb-1 text-sm font-medium text-zinc-700 lg:mt-8 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0">
            {navigationItems.map((item) => {
              const selected = item.view === selectedView;

              return (
              <a
                key={item.view}
                href={item.view === "dashboard" ? "/" : `/?view=${item.view}`}
                aria-current={selected ? "page" : undefined}
                className={`block whitespace-nowrap rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-600 ${
                  selected ? "bg-teal-50 text-teal-800 ring-1 ring-teal-100" : "hover:bg-zinc-100"
                }`}
              >
                {item.label}
              </a>
              );
            })}
          </nav>
        </aside>

        <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
          <header id="dashboard" className="flex flex-col gap-4 border-b border-zinc-200 pb-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase text-teal-700">{currentViewCopy.eyebrow}</p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight text-zinc-950 sm:text-4xl">{currentViewCopy.title}</h1>
              {currentViewCopy.description ? (
                <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
                  {currentViewCopy.description}
                </p>
              ) : null}
            </div>
            <div className="grid gap-3 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-sm sm:min-w-80">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label={pi.reachable ? "Pi reachable" : "Pi unreachable"} tone={pi.reachable ? "good" : "warn"} />
                <StatusPill label={playbackLabel} tone={playbackHealthy ? "good" : "warn"} />
              </div>
              <p className="text-zinc-600">
                {pi.host ? `${pi.host} · ` : ""}{playerFreshnessDetail} · Playlist v{playlist.version}
              </p>
            </div>
          </header>

          <section
            aria-labelledby="operations-heading"
            className={selectedView === "dashboard" ? "mt-5" : "hidden"}
          >
            <h2 id="operations-heading" className="sr-only">Operational status</h2>
            <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Screens</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{screenSummary}</dd>
                <dd className="mt-1 text-sm text-zinc-600">{localScreenName}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Playback</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{playbackMetric}</dd>
                <dd className="mt-1 text-sm text-zinc-600">{formatStatusAge(playerStatus?.updatedAt)}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Playlist</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">v{playlist.version}</dd>
                <dd className="mt-1 text-sm text-zinc-600">{playlistSyncState.label}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <dt className="text-xs font-semibold uppercase text-zinc-500">Needs attention</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{attentionSummary}</dd>
                <dd className="mt-1 text-sm text-zinc-600">{attentionItems[0]?.label ?? "No action needed"}</dd>
              </div>
            </dl>
          </section>

          <section
            aria-labelledby="now-playing-heading"
            className={selectedView === "dashboard" ? "mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]" : "hidden"}
          >
            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase text-teal-700">Live screen</p>
                  <h2 id="now-playing-heading" className="mt-1 text-2xl font-semibold">Now playing</h2>
                </div>
                <StatusPill label={playbackLabel} tone={playbackHealthy ? "good" : "warn"} />
              </div>
              <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0">
                  <p className="break-words text-3xl font-semibold leading-tight text-zinc-950 sm:text-4xl">{currentAsset}</p>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600">{currentAssetStatus}</p>
                  <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
                    <div className="rounded-md bg-zinc-50 p-3">
                      <dt className="font-semibold text-zinc-500">Playlist</dt>
                      <dd className="mt-1 text-zinc-950">{playlist.name} · v{playlist.version}</dd>
                    </div>
                    <div className="rounded-md bg-zinc-50 p-3">
                      <dt className="font-semibold text-zinc-500">Loop</dt>
                      <dd className="mt-1 text-zinc-950">{playlist.assets.length} items · {totalDuration}</dd>
                    </div>
                    <div className="rounded-md bg-zinc-50 p-3">
                      <dt className="font-semibold text-zinc-500">Last report</dt>
                      <dd className="mt-1 text-zinc-950">{formatStatusAge(playerStatus?.updatedAt)}</dd>
                    </div>
                  </dl>
                </div>
                <dl className="grid content-start gap-3 text-sm">
                  <div className="rounded-md bg-zinc-50 p-3">
                    <dt className="font-semibold text-zinc-500">Screen</dt>
                    <dd className="mt-1 text-zinc-950">{localScreenName}</dd>
                  </div>
                  <div className="rounded-md bg-zinc-50 p-3">
                    <dt className="font-semibold text-zinc-500">Device</dt>
                    <dd className="mt-1 text-zinc-950">{localDeviceIdentifier}</dd>
                  </div>
                  <div className="rounded-md bg-zinc-50 p-3">
                    <dt className="font-semibold text-zinc-500">Freshness</dt>
                    <dd className="mt-1 text-zinc-950">{playerFreshnessDetail}</dd>
                  </div>
                </dl>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
                <div className="flex items-start justify-between gap-3 border-b border-zinc-200 p-5">
                  <div>
                    <p className="text-sm font-semibold uppercase text-teal-700">Attention</p>
                    <h2 className="mt-1 text-2xl font-semibold">Needs attention</h2>
                  </div>
                  <StatusPill label={attentionSummary} tone={attentionItems.length === 0 ? "good" : "warn"} />
                </div>
                {attentionItems.length > 0 ? (
                  <ol className="divide-y divide-zinc-200">
                    {attentionItems.map((item) => (
                      <li key={`${item.label}-${item.detail}`} className="grid gap-2 p-5 text-sm">
                        <div className="flex items-start justify-between gap-3">
                          <p className="font-semibold text-zinc-950">{item.label}</p>
                          <StatusPill label="Check" tone={item.tone} />
                        </div>
                        <p className="leading-6 text-zinc-600">{item.detail}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="p-5 text-sm">
                    <p className="font-semibold text-zinc-950">All clear</p>
                    <p className="mt-1 text-zinc-600">Playback, status, and playlist sync are healthy.</p>
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
                <div className="flex items-start justify-between gap-3 border-b border-zinc-200 p-5">
                  <div>
                    <p className="text-sm font-semibold uppercase text-teal-700">Evidence</p>
                    <h2 className="mt-1 text-2xl font-semibold">Recent activity</h2>
                  </div>
                  <StatusPill label={playbackHealthy && playlistSyncState.tone === "good" ? "OK" : "Review"} tone={playbackHealthy && playlistSyncState.tone === "good" ? "good" : "warn"} />
                </div>
                <ol className="divide-y divide-zinc-200">
                  {recoveryEvidence.slice(0, 4).map((item) => (
                    <li key={item.label} className="grid gap-2 p-4 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-semibold text-zinc-950">{item.label}</p>
                        <StatusPill label={item.tone === "good" ? "OK" : item.tone === "warn" ? "Check" : "Info"} tone={item.tone} />
                      </div>
                      <p className="text-zinc-950">{item.value}</p>
                      <p className="leading-6 text-zinc-600">{item.detail}</p>
                    </li>
                  ))}
                </ol>
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
            id="recovery"
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
            id="locations"
            aria-labelledby="locations-heading"
            className={selectedView === "device-health" ? "mt-6 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]" : "hidden"}
          >
            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="border-b border-zinc-200 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 id="locations-heading" className="text-xl font-semibold">{localLocationName}</h2>
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
            aria-labelledby="device-map-heading"
            className={selectedView === "screens" ? "mt-6 rounded-lg border border-zinc-200 bg-white shadow-sm" : "hidden"}
          >
            <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="device-map-heading" className="text-xl font-semibold">Device map</h2>
                <p className="mt-1 text-sm text-zinc-600">Select a Pi pin for playback and health details.</p>
              </div>
              <StatusPill label={mapUrl ? "Real coordinates" : "Location needed"} tone={mapUrl ? "good" : "warn"} />
            </div>
            <div className="p-5">
              {mapUrl ? (
                <LocalDeviceMap devices={mapDevices} mapSrc={mapUrl} />
              ) : (
                <div className="flex min-h-80 flex-col justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-5 text-sm">
                  <p className="text-lg font-semibold text-zinc-950">Coordinates not captured</p>
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md bg-white p-3">
                      <dt className="font-semibold text-zinc-500">Screen</dt>
                      <dd className="mt-1 text-zinc-950">{localScreenName}</dd>
                    </div>
                    <div className="rounded-md bg-white p-3">
                      <dt className="font-semibold text-zinc-500">Device</dt>
                      <dd className="mt-1 text-zinc-950">{localDeviceIdentifier}</dd>
                    </div>
                  </dl>
                </div>
              )}
              <LocalDeviceLocationCapture hasLocation={Boolean(location)} />
            </div>
          </section>

          <section
            id="screens"
            aria-labelledby="screens-heading"
            className={selectedView === "screens" ? "mt-6 rounded-lg border border-zinc-200 bg-white shadow-sm" : "hidden"}
          >
            <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 id="screens-heading" className="text-xl font-semibold">Screens</h2>
                <p className="mt-1 text-sm text-zinc-600">Screen inventory and playback assignment.</p>
              </div>
              <StatusPill label="Local only" tone="muted" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-5 py-3">Name</th>
                    <th className="px-5 py-3">Player status</th>
                    <th className="px-5 py-3">Player type</th>
                    <th className="px-5 py-3">Content</th>
                    <th className="px-5 py-3">Last update</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200">
                  <tr>
                    <td className="px-5 py-4 font-semibold">{localScreenName}</td>
                    <td className="px-5 py-4"><StatusPill label={playbackLabel} tone={playbackHealthy ? "good" : "warn"} /></td>
                    <td className="px-5 py-4">VLC field player</td>
                    <td className="px-5 py-4">{playlist.name}</td>
                    <td className="px-5 py-4">{playerUpdatedAt}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section
            id="playlist"
            aria-labelledby="playlist-heading"
            className={selectedView === "playlist" ? "mt-6 grid gap-4 xl:grid-cols-[1fr_360px]" : "hidden"}
          >
            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
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
                  <p className="mt-1 text-zinc-600">VLC receives MP4 assets only; JPEG and PNG uploads are converted before publish.</p>
                </div>
              </div>
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
                Append a local MP4, JPEG, or PNG to the playlist. JPEG and PNG uploads are converted to Pi-safe MP4 still clips before VLC sees them.
              </p>
              <LocalUploadForm />
            </div>
          </section>

        </div>
      </div>
    </main>
  );
}
