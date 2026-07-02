import { promises as fs } from "node:fs";
import { Socket } from "node:net";
import { cookies } from "next/headers";
import { DashboardAutoRefresh } from "./dashboard-auto-refresh";
import { Metric, StatusPill } from "./dashboard-ui";
import { DeviceHealthFleetPanel } from "./device-health-fleet-panel";
import { readCloudHeartbeats } from "./lib/cloud-heartbeat";
import type { CloudHeartbeatState } from "./lib/cloud-heartbeat";
import { ensureLocalDataFoundation } from "./lib/local-data-store";
import type { DeviceRecord, DeviceStore, ScreenRecord, ScreenStore } from "./lib/local-data-store";
import { assignedPlaylistIdForDevice } from "./lib/inventory-assignment";
import { readInventory } from "./lib/inventory-store";
import { localStateDirectory, publishStatusPath, repoRoot, writeFileAtomic } from "./lib/local-playlist";
import type { Playlist, PlaylistAsset, PlaylistStore } from "./lib/local-playlist";
import { readPlaylistStore, selectPlaylist } from "./lib/playlist-store";
import { readPiConfig, runSsh } from "./lib/pi-local";
import type { PiConfig } from "./lib/pi-local";
import { piConfigForDevice } from "./lib/pi-targets";
import { isPlaybackSafeVideoFileName } from "./lib/playback-safety";
import {
  activeWorkspaceSession,
  workspaceContextFromSession,
  workspaceMembershipFor,
  type WorkspaceRole
} from "./lib/workspace";
import { LayoutsPanel } from "./layouts-panel";
import { MediaStorePanel } from "./media-store-panel";
import { LocalPlaylistBuilder, LocalPlaylistScreenAssignment } from "./local-playlist-builder";
import { LocalPlaylistCreateForm } from "./local-playlist-create-form";
import { LocalPlaylistDeleteButton } from "./local-playlist-delete-button";
import { LocalPlaylistDiscardButton } from "./local-playlist-discard-button";
import { LocalPlaylistRenameButton } from "./local-playlist-rename-button";
import { LocalPlaylistSwitcher } from "./local-playlist-switcher";
import { LocalPublishForm } from "./local-publish-form";
import { LocalPlaylistSequence } from "./local-playlist-sequence";
import { LocalPlaylistTimeline } from "./local-playlist-timeline";
import { SchedulingPanel } from "./scheduling-panel";
import { ScreenFocusSelect } from "./screen-focus-select";
import { ThemeCycleButton } from "./theme-cycle-button";
import { beamThemeCookieName, normalizeBeamThemeId } from "./theme";
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
  currentAssetDurationSeconds?: number | null;
  currentAssetId?: string | null;
  currentAssetPath?: string | null;
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
  cloudHeartbeats: Record<string, CloudHeartbeatState>;
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
  assetsChecked?: number;
  assetsCopied?: number;
  assetsRemoved?: number;
  assetsSkipped?: number;
  assetsVerifiedByChecksum?: number;
  assetsVerifiedBySize?: number;
  message: string;
  ok: boolean;
  piPublishEnabled: boolean;
  playlistId?: string;
  playlistName?: string;
  playlistVersion: number;
  timestamp: string;
};

type StatusTone = "good" | "warn" | "muted";

type CurrentPlaybackItem = {
  assetId: string;
  durationLabel: string | null;
  index: number;
  title: string;
  total: number;
  type: PlaylistAsset["type"];
};

type PlaylistSyncState = {
  detail: string;
  label: string;
  tone: StatusTone;
};

const execTimeoutMs = 4_000;
const sshReachabilityTimeoutMs = 750;
const probeCacheTtlMs = 10_000;
const staleStatusThresholdMs = 45_000;
const staleHeartbeatThresholdMs = 120_000;
const dashboardMode = process.env.BEAM_DASHBOARD_MODE === "cloud" ? "cloud" : "local";

type PiProbeCacheEntry = {
  pending: Promise<void> | null;
  probe: PiProbe;
  updatedAt: number;
};

const piProbeCache = new Map<string, PiProbeCacheEntry>();

type DashboardView =
  | "dashboard"
  | "media-store"
  | "layouts"
  | "playlist"
  | "screens"
  | "scheduling"
  | "troubleshooting";

type PlaylistWorkflowStepId = "playlist" | "media" | "screens" | "publish";

const playlistWorkflowStepIds: PlaylistWorkflowStepId[] = ["playlist", "media", "screens", "publish"];

type DashboardPageProps = {
  searchParams?: Promise<{
    playlist?: string | string[];
    playlistStep?: string | string[];
    screen?: string | string[];
    view?: string | string[];
  }>;
};

const navigationItems: Array<{ label: string; view: DashboardView }> = [
  { label: "What's Playing", view: "dashboard" },
  { label: "Library", view: "media-store" },
  { label: "Playlists", view: "playlist" },
  { label: "Screens", view: "screens" },
  { label: "Diagnostics", view: "troubleshooting" },
  { label: "Layouts", view: "layouts" },
  { label: "Scheduling", view: "scheduling" }
];

const viewCopy: Record<DashboardView, { eyebrow: string; title: string; description?: string }> = {
  dashboard: {
    eyebrow: "Overview",
    title: "What's Playing",
    description: "At-a-glance playback and health for every screen."
  },
  "media-store": {
    eyebrow: "Assets",
    title: "Library",
    description: "Upload, find, and organize media for your screens."
  },
  layouts: {
    eyebrow: "Compositions",
    title: "Layouts",
    description: "Compose local video layouts with text and regions before rendering."
  },
  playlist: {
    eyebrow: "Loops",
    title: "Playlists",
    description: "Create a playlist, choose screens, then publish."
  },
  screens: {
    eyebrow: "Operations",
    title: "Screens",
    description: "Screen inventory, health, assigned playlists, and recovery tools."
  },
  scheduling: {
    eyebrow: "Hours",
    title: "Scheduling"
  },
  troubleshooting: {
    eyebrow: "Support",
    title: "Diagnostics",
    description: "Live screen status, raw logs, and recovery history for deeper diagnostics."
  }
};

function dashboardViewFrom(value: string | string[] | undefined): DashboardView {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === "device-health") {
    return "troubleshooting";
  }

  return navigationItems.some((item) => item.view === candidate) ? (candidate as DashboardView) : "dashboard";
}

function playlistWorkflowStepFrom(value: string | string[] | undefined): PlaylistWorkflowStepId {
  const candidate = Array.isArray(value) ? value[0] : value;
  return playlistWorkflowStepIds.includes(candidate as PlaylistWorkflowStepId) ? (candidate as PlaylistWorkflowStepId) : "playlist";
}

function autoRefreshEnabledForView(view: DashboardView): boolean {
  return view === "dashboard" || view === "screens" || view === "troubleshooting";
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
  const minutes = totalSeconds > 0 ? Math.max(1, Math.round(totalSeconds / 60)) : 0;
  return `${minutes}m`;
}

function formatAssetDuration(totalSeconds: number | null | undefined): string | null {
  if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return null;
  }

  return formatSeconds(Math.round(totalSeconds));
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

function assetDisplayTitle(asset: PlaylistAsset): string {
  return asset.altText?.trim() || fileNameFromUri(asset.uri) || asset.assetId;
}

function currentPlaybackItemFromPlaylist(
  playlist: Playlist | null,
  currentAssetId: string | null | undefined
): CurrentPlaybackItem | null {
  if (!playlist || !currentAssetId) {
    return null;
  }

  const index = playlist.assets.findIndex((asset) => asset.assetId === currentAssetId);
  if (index === -1) {
    return null;
  }

  const asset = playlist.assets[index];
  return {
    assetId: asset.assetId,
    durationLabel: formatAssetDuration(asset.durationSeconds),
    index,
    title: assetDisplayTitle(asset),
    total: playlist.assets.length,
    type: asset.type
  };
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

function roleLabel(role: WorkspaceRole | null | undefined): string {
  const labels: Record<WorkspaceRole, string> = {
    "content-manager": "Content Manager",
    operator: "Operator",
    "platform-admin": "Platform Admin",
    viewer: "Viewer",
    "workspace-admin": "Workspace Admin"
  };

  return role ? labels[role] : "No role";
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

function canReachSshPort(host: string, timeoutMs = sshReachabilityTimeoutMs): Promise<boolean> {
  const trimmedHost = host.trim();
  if (!trimmedHost) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(22, trimmedHost);
    } catch {
      finish(false);
    }
  });
}

function unavailablePiProbe(config: PiConfig | null, message: string): PiProbe {
  return {
    configured: Boolean(config),
    reachable: false,
    host: config?.host ?? null,
    message,
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

function piProbeCacheKey(config: PiConfig): string {
  return `${config.user}@${config.host}:${config.root}:${config.cacheRoot}`;
}

function schedulePiProbeRefresh(config: PiConfig, entry: PiProbeCacheEntry | undefined): void {
  if (entry?.pending) {
    return;
  }

  const key = piProbeCacheKey(config);
  const pending = loadPiProbe(config)
    .then((probe) => {
      piProbeCache.set(key, {
        pending: null,
        probe,
        updatedAt: Date.now()
      });
    })
    .catch((error) => {
      piProbeCache.set(key, {
        pending: null,
        probe: unavailablePiProbe(
          config,
          error instanceof Error ? error.message : `Beam could not refresh ${config.host}.`
        ),
        updatedAt: Date.now()
      });
    });

  piProbeCache.set(key, {
    pending,
    probe:
      entry?.probe ??
      unavailablePiProbe(config, `Beam is checking ${config.host}. Last live status is not available yet.`),
    updatedAt: entry?.updatedAt ?? 0
  });
}

function loadCachedPiProbe(config: PiConfig | null): PiProbe {
  if (!config) {
    return unavailablePiProbe(null, "Add a local Pi in Screens, or configure Pi SSH in dashboard/.env.local.");
  }

  const key = piProbeCacheKey(config);
  const entry = piProbeCache.get(key);
  if (!entry || Date.now() - entry.updatedAt > probeCacheTtlMs) {
    schedulePiProbeRefresh(config, entry);
  }

  return piProbeCache.get(key)?.probe ?? unavailablePiProbe(config, `Beam is checking ${config.host}.`);
}

function piConfigFromInventory(inventory: { devices: DeviceStore; screens: ScreenStore }, playlistId?: string | null): PiConfig | null {
  const savedDevices = inventory.devices.items.filter((device) => {
    return Boolean(device.host.trim()) && device.host !== "Not configured";
  });
  const playlistScreenIds = new Set(
    playlistId
      ? inventory.screens.items
          .filter((screen) => screen.playlistId === playlistId)
          .map((screen) => screen.id)
      : []
  );
  const playlistDeviceIds = new Set(
    playlistId
      ? inventory.screens.items
          .filter((screen) => screen.playlistId === playlistId && screen.deviceId)
          .map((screen) => screen.deviceId as string)
      : []
  );
  const playlistDevices = savedDevices.filter((device) => {
    return (
      (device.playlistId !== null && device.playlistId === playlistId) ||
      playlistDeviceIds.has(device.id) ||
      (device.screenId ? playlistScreenIds.has(device.screenId) : false)
    );
  });
  const candidateDevices = playlistDevices.length > 0 ? playlistDevices : savedDevices;
  const reachableDevice =
    candidateDevices.find((device) => {
      const probe = piProbeCache.get(piProbeCacheKey(piConfigForDevice(device)))?.probe;
      return probe?.reachable;
    }) ?? null;
  const savedDevice = reachableDevice ?? candidateDevices[0] ?? null;
  const fallbackConfig = readPiConfig();

  if (!savedDevice) {
    return fallbackConfig;
  }

  return piConfigForDevice(savedDevice);
}

async function loadPiProbe(config: PiConfig | null): Promise<PiProbe> {
  if (!config) {
    return unavailablePiProbe(null, "Add a local Pi in Screens, or configure Pi SSH in dashboard/.env.local.");
  }

  const sshReachable = await canReachSshPort(config.host);
  if (!sshReachable) {
    return unavailablePiProbe(
      config,
      `Beam cannot reach SSH on ${config.host} from this network. The screen remains saved and will show offline until it is reachable again.`
    );
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

function cloudDeviceStatus(device: DeviceRecord, cloudHeartbeat: CloudHeartbeatState | undefined): DeviceLiveStatus | null {
  const heartbeat = cloudHeartbeat?.heartbeat;
  if (!cloudHeartbeat?.ok || !heartbeat || heartbeat.deviceId !== device.id) {
    return null;
  }

  const timestamp = heartbeat.receivedAt ?? heartbeat.timestamp ?? undefined;
  const ageMs = statusAgeMs(timestamp);
  const fresh = ageMs !== null && ageMs <= staleHeartbeatThresholdMs;
  const state = heartbeat.playbackState ?? "unknown";
  const deploymentReady =
    state === "ready-for-publishing" ||
    heartbeat.currentPlaylistId === "playlist-ready-for-publishing";
  const playbackHealthy = fresh && state === "playing";

  return {
    ageLabel: formatStatusAge(timestamp),
    host: heartbeat.localIpAddress ?? device.host,
    playbackHealthy,
    playbackLabel: playbackHealthy ? "Playing" : deploymentReady && fresh ? "Ready for deployment" : fresh ? "Cloud heartbeat" : "Stale",
    playerStatus: {
      currentAssetId: heartbeat.currentAssetId,
      playlistId: heartbeat.currentPlaylistId ?? undefined,
      playlistVersion: heartbeat.playlistVersion ?? undefined,
      state,
      updatedAt: timestamp
    },
    reachable: fresh && heartbeat.networkOnline,
    stale: !fresh,
    timestampLabel: formatTimestamp(timestamp)
  };
}

async function loadDeviceStatuses(
  inventory: DashboardState["inventory"],
  cloudHeartbeats: Record<string, CloudHeartbeatState>
): Promise<Record<string, DeviceLiveStatus>> {
  const entries = await Promise.all(
    inventory.devices.items.map(async (device) => {
      const cloudStatus = cloudDeviceStatus(device, cloudHeartbeats[device.id]);
      if (cloudStatus) {
        return [device.id, cloudStatus] as const;
      }

      const hostConfigured = Boolean(device.host.trim()) && device.host !== "Not configured";
      if (!hostConfigured) {
        return [device.id, null] as const;
      }

      const probe = loadCachedPiProbe(piConfigForDevice(device));
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
    readInventory(seedPlaylistId),
    readJsonFile<PublishStatus>(publishStatusPath())
  ]);
  const cloudHeartbeats = await readCloudHeartbeats(inventory.devices.items.map((device) => device.id));
  const primaryPiConfig = piConfigFromInventory(inventory, playlist.playlistId);
  const pi = loadCachedPiProbe(primaryPiConfig);
  const deviceStatuses = await loadDeviceStatuses(inventory, cloudHeartbeats);
  const lastKnownPlayback = await resolveLastKnownPlayback(pi);

  return { cloudHeartbeats, deviceStatuses, heartbeat, inventory, lastKnownPlayback, playlist, playlistStore, publishStatus, pi };
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
    "playlist-add-media": "Add media",
    "playlist-create": "Create playlist",
    "playlist-move-down": "Move down",
    "playlist-move-up": "Move up",
    "playlist-remove": "Remove",
    "playlist-reorder": "Reorder",
    "playlist-update-item": "Edit item",
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

function formatCount(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function publishAssetSyncDetail(publishStatus: PublishStatus | null): string {
  if (!publishStatus || typeof publishStatus.assetsChecked !== "number") {
    return "No asset diff recorded yet.";
  }

  const copied = formatCount(publishStatus.assetsCopied);
  const removed = formatCount(publishStatus.assetsRemoved);
  const skipped = formatCount(publishStatus.assetsSkipped);
  const hashVerified = formatCount(publishStatus.assetsVerifiedByChecksum);
  const sizeVerified = formatCount(publishStatus.assetsVerifiedBySize);
  const verification =
    hashVerified > 0
      ? `${hashVerified} hash-verified`
      : sizeVerified > 0
        ? `${sizeVerified} size-verified`
        : "verification not recorded";

  return `Checked ${publishStatus.assetsChecked} asset${publishStatus.assetsChecked === 1 ? "" : "s"}; copied ${copied}, skipped ${skipped}, removed ${removed} stale; ${verification}.`;
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
  assignedScreensLabel: string,
  deliveryMode: "cloud" | "local"
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
      detail: deliveryMode === "cloud"
        ? "Saved in AWS as a draft. Publish manually when this playlist is ready for assigned screens."
        : "Saved locally. Publish manually when this playlist is ready for the screen.",
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

type AttentionItem = {
  detail: string;
  label: string;
  tone: "good" | "warn" | "muted";
};

type FleetCommandRow = {
  assignedPlaylistAssetCount: number | null;
  assignedPlaylistDuration: string | null;
  assignedPlaylistName: string;
  currentItem: CurrentPlaybackItem | null;
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
  lastReportLabel: string;
  playbackLabel: string;
  reachable: boolean;
  screenId: string;
  screenName: string;
  reportedCurrentAssetId: string | null;
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
  playlistStore
}: {
  deviceStatuses: DashboardState["deviceStatuses"];
  inventory: DashboardState["inventory"];
  playlistStore: PlaylistStore;
}): FleetCommandRow[] {
  const screensByDeviceId = new Map<string, ScreenRecord>();
  const playlistsById = new Map(playlistStore.items.map((item) => [item.playlistId, item]));

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
      const assignedPlaylistId = assignedPlaylistIdForDevice(device, linkedScreen);
      const assignedPlaylist = assignedPlaylistId ? playlistsById.get(assignedPlaylistId) ?? null : null;
      const hostConfigured = Boolean(device.host.trim()) && device.host !== "Not configured";
      const deviceStatus = deviceStatuses[device.id];
      const isLive = Boolean(deviceStatus);
      const reachable = deviceStatus?.reachable ?? false;
      const reportedPlaylistId = deviceStatus?.playerStatus?.playlistId ?? null;
      const reportedPlaylistVersion = deviceStatus?.playerStatus?.playlistVersion;
      const rowPlaybackHealthy = deviceStatus?.playbackHealthy ?? false;
      const rowPlaybackLabel = deviceStatus?.playbackLabel ?? "Unknown";
      const livePlaybackStale = deviceStatus?.stale ?? false;
      const reportedPlaylist = reportedPlaylistId ? playlistsById.get(reportedPlaylistId) ?? null : null;
      const playbackStatusIsPlaying = deviceStatus?.playerStatus?.state === "playing";
      const reportedCurrentAssetId = playbackStatusIsPlaying ? deviceStatus?.playerStatus?.currentAssetId ?? null : null;
      const currentItem = currentPlaybackItemFromPlaylist(reportedPlaylist ?? assignedPlaylist, reportedCurrentAssetId);
      const healthLabel = !hostConfigured ? "No host" : isLive ? (reachable ? "Online" : "Offline") : "Not reporting";
      const healthTone = !hostConfigured ? "warn" : isLive ? (reachable ? "good" : "warn") : "muted";
      let syncDetail = "No playlist is assigned to this screen.";
      let syncLabel = "Unassigned";
      let syncTone: "good" | "warn" | "muted" = "warn";

      if (assignedPlaylistId && !assignedPlaylist) {
        syncDetail = "This screen points to a playlist Beam cannot find in the saved catalog.";
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
        const reportedPlaylistName = reportedPlaylist?.name ?? "another playlist";
        syncDetail = `Beam expects ${assignedPlaylist.name}; Pi reports ${reportedPlaylistName}. Publish required.`;
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
            : "Beam cannot reach this screen to verify playback or playlist state."
          : "This Pi is saved in Beam, but it is not checking in yet.";

      return {
        assignedPlaylistAssetCount: assignedPlaylist?.assets.length ?? null,
        assignedPlaylistDuration: assignedPlaylist ? formatDuration(assignedPlaylist.assets) : null,
        assignedPlaylistName: assignedPlaylist?.name ?? "No playlist assigned",
        currentItem,
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
        lastReportLabel: isLive ? deviceStatus?.ageLabel ?? "No timestamp" : "not checking in",
        playbackLabel: playback,
        reachable,
        reportedCurrentAssetId,
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

function screenLiveReportUrl(deviceId: string | null | undefined): string | null {
  return deviceId ? `/screen-player/${encodeURIComponent(deviceId)}` : null;
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const cookieStore = await cookies();
  const currentThemeId = normalizeBeamThemeId(cookieStore.get(beamThemeCookieName)?.value);
  const workspaceSession = activeWorkspaceSession();
  const workspaceContext = workspaceContextFromSession(workspaceSession);
  const activeWorkspace = workspaceSession.workspaces.find((workspace) => workspace.workspaceId === workspaceContext.activeWorkspaceId);
  const activeMembership = workspaceMembershipFor(workspaceContext.activeWorkspaceId, workspaceContext);
  const workspaceName = activeWorkspace?.name ?? workspaceContext.activeWorkspaceId;
  const workspaceRoleLabel = roleLabel(activeMembership?.role);
  const workspaceRoles = new Map(workspaceContext.memberships.map((membership) => [membership.workspaceId, membership.role]));
  const resolvedSearchParams = await searchParams;
  const selectedView = dashboardViewFrom(resolvedSearchParams?.view);
  const selectedPlaylistParam = scalarSearchParam(resolvedSearchParams?.playlist);
  const selectedPlaylistStep = playlistWorkflowStepFrom(resolvedSearchParams?.playlistStep);
  const currentViewCopy = viewCopy[selectedView];
  const { cloudHeartbeats, deviceStatuses, heartbeat, inventory, lastKnownPlayback, playlist, playlistStore, publishStatus, pi } =
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

    if (dashboardMode === "cloud") {
      const unpublished = screensForPlaylist.find((screen) => {
        const device = linkedDeviceForScreen(screen);
        const publishedPlaylistId = screen.publishedPlaylistId ?? device?.publishedPlaylistId ?? null;
        const publishedPlaylistVersion = screen.publishedPlaylistVersion ?? device?.publishedPlaylistVersion ?? null;
        return publishedPlaylistId !== option.playlistId || publishedPlaylistVersion !== option.version;
      });

      if (unpublished) {
        const device = linkedDeviceForScreen(unpublished);
        const publishedPlaylistVersion = unpublished.publishedPlaylistVersion ?? device?.publishedPlaylistVersion ?? null;
        return {
          detail:
            typeof publishedPlaylistVersion === "number"
              ? `${unpublished.name} is still on published v${publishedPlaylistVersion}; saved draft is v${option.version}.`
              : `${unpublished.name} has not received a manual publish for this playlist yet.`,
          label: "Needs publish",
          tone: "warn"
        };
      }
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
      const status = linkedDevice ? deviceStatuses[linkedDevice.id] ?? null : null;
      const reportedPlaylistId = status?.playerStatus?.playlistId ?? null;
      const reportsAssignedPlaylist = Boolean(
        assignedPlaylist?.playlistId && reportedPlaylistId === assignedPlaylist.playlistId
      );
      const liveSync = assignedPlaylist
        ? reportsAssignedPlaylist
          ? syncState(assignedPlaylist.version, status?.playerStatus?.playlistVersion, status?.reachable ?? false)
          : status
            ? {
                detail: `${screen.name} has not reported ${assignedPlaylist.name} yet.`,
                label: "Waiting",
                tone: "muted" as const
              }
            : {
                detail: `${screen.name} has not checked in with playlist evidence yet.`,
                label: "No check-in",
                tone: "muted" as const
              }
        : {
            detail: "No playlist is assigned to this screen.",
            label: "Unassigned",
            tone: "muted" as const
          };

      return {
        assignedPlaylistVersion: assignedPlaylist?.version ?? null,
        deviceHost: linkedDevice?.host ?? null,
        deviceId: linkedDevice?.id ?? null,
        deviceName: linkedDevice?.name ?? null,
        group: screen.group,
        id: screen.id,
        liveStatus: status
          ? {
              ageLabel: status.ageLabel,
              playbackHealthy: status.playbackHealthy,
              playbackLabel: status.playbackLabel,
              playlistId: status.playerStatus?.playlistId ?? null,
              playlistVersion: status.playerStatus?.playlistVersion ?? null,
              reachable: status.reachable,
              stale: status.stale,
              state: status.playerStatus?.state ?? null,
              timestampLabel: status.timestampLabel
            }
          : null,
        location: screen.location,
        name: screen.name,
        playlistName: assignedPlaylist?.name ?? null,
        syncDetail: liveSync.detail,
        syncLabel: liveSync.label,
        syncTone: liveSync.tone
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
  const selectedPlaylistHasUnpublishedChanges = Boolean(
    (publishStatusForSelected && !publishStatusForSelected.ok && !publishStatusForSelected.piPublishEnabled) ||
      (dashboardMode === "cloud" &&
        assignedScreens.some((screen) => {
          const device = linkedDeviceForScreen(screen);
          const publishedPlaylistId = screen.publishedPlaylistId ?? device?.publishedPlaylistId ?? null;
          const publishedPlaylistVersion = screen.publishedPlaylistVersion ?? device?.publishedPlaylistVersion ?? null;
          return publishedPlaylistId === playlist.playlistId && publishedPlaylistVersion !== playlist.version;
        }))
  );
  const selectedPlaylistLiveState = playlistLiveStatus(
    playlistSyncState,
    publishStatusForSelected,
    assignedScreensLabel,
    dashboardMode
  );
  const workflowSteps = [
    {
      detail: playlist.name,
      id: "playlist" as const,
      label: "Playlist",
      status: `${playlistOptions.length} saved`,
      tone: "good" as const
    },
    {
      detail: totalDuration,
      id: "media" as const,
      label: "Add media",
      status: playlist.assets.length > 0 ? `${playlist.assets.length} item${playlist.assets.length === 1 ? "" : "s"}` : "Empty",
      tone: playlist.assets.length > 0 ? "good" as const : "warn" as const
    },
    {
      detail: assignedScreensLabel,
      id: "screens" as const,
      label: "Screens",
      status: assignedScreens.length > 0 ? `${assignedScreens.length} assigned` : "Choose screens",
      tone: assignedScreens.length > 0 ? "good" as const : "warn" as const
    },
    {
      detail: shortScreenDetail(selectedPlaylistLiveState),
      id: "publish" as const,
      label: "Publish",
      status: selectedPlaylistLiveState.label,
      tone: selectedPlaylistLiveState.tone
    }
  ];
  function playlistWorkflowStepHref(stepId: PlaylistWorkflowStepId): string {
    const params = new URLSearchParams({
      playlist: playlist.playlistId,
      playlistStep: stepId,
      view: "playlist"
    });

    return `/?${params.toString()}`;
  }
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
    playlistStore
  });
  const onlineDeviceCount = fleetRows.filter((row) => row.healthLabel === "Online").length;
  const offlineDeviceCount = fleetRows.filter((row) => row.healthLabel === "Offline").length;
  const notReportingDeviceCount = fleetRows.filter((row) => row.healthLabel === "Not reporting").length;
  const disconnectedDeviceCount = offlineDeviceCount + notReportingDeviceCount;
  const playingDeviceCount = fleetRows.filter((row) => row.playbackLabel === "Playing").length;
  const staleDeviceCount = fleetRows.filter((row) => row.playbackLabel === "Stale").length;
  const syncIssueCount = fleetRows.filter((row) => row.syncTone === "warn").length;
  const screenCount = inventory.screens.items.length;
  const confirmedPlaybackLabel = screenCount > 0 ? `${playingDeviceCount}/${screenCount}` : "0";
  const onlineScreensLabel = screenCount > 0 ? `${onlineDeviceCount}/${screenCount}` : "0";
  const playingDetail = staleDeviceCount > 0
    ? `${staleDeviceCount} stale report`
    : playingDeviceCount === screenCount && screenCount > 0
      ? null
      : disconnectedDeviceCount > 0
      ? "no live connection"
      : "waiting for playback";
  const onlineScreensDetail = screenCount === 0
    ? "No screens registered"
    : offlineDeviceCount > 0
    ? `${offlineDeviceCount} offline`
    : notReportingDeviceCount > 0
      ? `${notReportingDeviceCount} not reporting`
      : onlineDeviceCount < screenCount
        ? `${screenCount - onlineDeviceCount} not online`
      : null;
  const firstSyncIssue = fleetRows.find((row) => row.syncTone === "warn");
  const playlistSyncLabel = syncIssueCount > 0 ? `${syncIssueCount} issue${syncIssueCount === 1 ? "" : "s"}` : "In sync";
  const playlistSyncDetail = firstSyncIssue
    ? `${firstSyncIssue.name}: ${firstSyncIssue.detail}`
    : screenCount === 0
      ? "Assign a screen to track playlist sync."
      : null;
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
    fleetRows.find((row) => row.reachable) ??
    fleetRows.find((row) => row.isLive) ??
    fleetRows[0] ??
    null;
  const focusedScreenIsLive = Boolean(focusedScreen?.isLive);
  const focusedScreenReachable = Boolean(focusedScreen?.reachable);
  const focusedScreenName = focusedScreen?.screenName ?? localScreenName;
  const focusedScreenLocation = focusedScreen
    ? `${focusedScreen.location} · ${focusedScreen.group}`
    : localLocationName;
  const focusedPlaybackLabel = focusedScreen?.playbackLabel ?? playbackLabel;
  const focusedSyncLabel = focusedScreen?.syncLabel ?? playlistSyncState.label;
  const focusedScreenHost = focusedScreen ? focusedScreen.host || "No host" : pi.host || "No host";
  const focusedCurrentItem = focusedScreen?.currentItem ?? null;
  const focusedPlaylistLoopLabel =
    `${focusedScreen?.assignedPlaylistName ?? playlist.name} · ${focusedScreen?.assignedPlaylistAssetCount ?? playlist.assets.length} items · ${focusedScreen?.assignedPlaylistDuration ?? totalDuration}`;
  const focusedCurrentItemLabel = focusedCurrentItem
    ? `${focusedCurrentItem.title}${focusedCurrentItem.durationLabel ? ` · ${focusedCurrentItem.durationLabel}` : ""}`
    : focusedScreen?.reportedCurrentAssetId
      ? "Reported but not matched"
      : "Not reported";
  const focusedScreenTitle = focusedScreenIsLive
    ? focusedScreenReachable
      ? focusedCurrentItem?.title ?? focusedScreen.assignedPlaylistName
      : "Screen offline"
    : "Waiting for check-in";
  let focusedScreenDetail = "This screen is saved in Beam. Once it checks in, its current playback will appear here.";
  if (focusedScreenIsLive && focusedScreen) {
    focusedScreenDetail = focusedScreen.detail;

    if (focusedScreenReachable) {
      if (focusedCurrentItem) {
        focusedScreenDetail = `VLC reports item ${focusedCurrentItem.index + 1} of ${focusedCurrentItem.total} from ${focusedScreen.assignedPlaylistName}${focusedCurrentItem.durationLabel ? ` (${focusedCurrentItem.durationLabel})` : ""}.`;
      } else if (focusedScreen.reportedCurrentAssetId) {
        focusedScreenDetail = "VLC reports a current item id, but Beam cannot match it to this playlist yet.";
      } else if (focusedScreen.syncTone === "good") {
        focusedScreenDetail = `VLC reports ${focusedScreen.assignedPlaylistName} is in sync. Current item is not reported yet for this screen.`;
      }
    }
  }
  const focusedLastReportLabel = focusedScreenIsLive
    ? focusedScreenReachable
      ? focusedScreen.lastReportLabel
      : "unavailable"
    : "not checking in";
  const focusedLiveSummary = focusedScreenIsLive
    ? focusedScreenReachable
      ? focusedPlaybackLabel === "Playing"
        ? "Playing live"
        : focusedPlaybackLabel
      : "Offline"
    : "Not reporting";
  const focusedScreenSummary = focusedScreenIsLive && focusedScreenReachable
    ? `${focusedLiveSummary} · ${focusedSyncLabel} · Last report ${focusedLastReportLabel}`
    : [focusedLiveSummary, focusedScreenIsLive ? "Playback unknown" : "No live report"].join(" · ");
  const previewEyebrow = focusedScreenIsLive && focusedScreenReachable ? "Showing now" : "Screen status";
  const focusedLiveReportUrl = focusedScreen ? screenLiveReportUrl(focusedScreen.id) : null;
  const screenFocusOptions = fleetRows.map((row) => ({
    location: row.location,
    screenId: row.screenId,
    screenName: row.screenName
  }));
  return (
    <main className="beam-shell min-h-screen [overflow-x:clip] text-zinc-950">
      <DashboardAutoRefresh enabled={autoRefreshEnabledForView(selectedView)} />
      <div className="min-h-screen">
        <aside className="beam-topbar border-b px-5 py-5 text-slate-950">
          <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <div className="inline-flex items-center gap-3" aria-label="Beam">
                <ThemeCycleButton initialThemeId={currentThemeId} />
                <span className="beam-wordmark bg-clip-text text-[2rem] font-black leading-none tracking-normal text-transparent [font-family:'Trebuchet_MS',ui-rounded,'Avenir_Next_Rounded','Arial_Rounded_MT_Bold',system-ui,sans-serif]">
                  Beam
                </span>
              </div>
              <details className="group relative mt-3 w-fit max-w-full">
                <summary
                  className="beam-session-summary flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 border-l-2 pl-3 text-xs outline-none transition focus-visible:ring-2 marker:hidden [&::-webkit-details-marker]:hidden"
                  aria-label={`Current workspace session: ${workspaceName}; ${workspaceRoleLabel}; ${workspaceSession.user.displayName}`}
                >
                  <span className="font-semibold text-slate-950">{workspaceName}</span>
                  <span>{workspaceRoleLabel}</span>
                  <span>{workspaceSession.user.displayName}</span>
                  <span className="beam-accent-text transition group-open:rotate-180" aria-hidden="true">v</span>
                </summary>
                <div className="beam-popover absolute left-0 z-20 mt-3 w-[min(22rem,calc(100vw-2.5rem))] rounded-md border bg-white p-4 text-sm shadow-lg">
                  <dl className="grid gap-3">
                    <div>
                      <dt className="text-xs font-semibold uppercase text-zinc-500">Workspace</dt>
                      <dd className="mt-1 font-semibold text-zinc-950">{workspaceName}</dd>
                      <dd className="mt-1 break-all text-xs text-zinc-600">{workspaceContext.activeWorkspaceId}</dd>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <dt className="text-xs font-semibold uppercase text-zinc-500">Role</dt>
                        <dd className="mt-1 text-zinc-800">{workspaceRoleLabel}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold uppercase text-zinc-500">User</dt>
                        <dd className="mt-1 text-zinc-800">{workspaceSession.user.displayName}</dd>
                      </div>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase text-zinc-500">Session</dt>
                      <dd className="mt-1 break-all text-xs text-zinc-600">{workspaceSession.sessionId}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase text-zinc-500">Available workspaces</dt>
                      <dd className="mt-2">
                        <ul className="grid gap-2">
                          {workspaceSession.workspaces.map((workspace) => {
                            const role = workspaceRoles.get(workspace.workspaceId);
                            const active = workspace.workspaceId === workspaceContext.activeWorkspaceId;

                            return (
                              <li key={workspace.workspaceId} className="rounded-md border border-zinc-200 p-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-medium text-zinc-950">{workspace.name}</span>
                                  <span className={active ? "beam-accent-text text-xs font-semibold" : "text-xs text-zinc-500"}>
                                    {active ? "Active" : roleLabel(role)}
                                  </span>
                                </div>
                                <p className="mt-1 break-all text-xs text-zinc-500">{workspace.workspaceId}</p>
                              </li>
                            );
                          })}
                        </ul>
                      </dd>
                    </div>
                  </dl>
                </div>
              </details>
            </div>
            <nav aria-label="Beam views" className="beam-nav grid grid-cols-4 gap-2 text-xs font-medium sm:text-sm lg:grid-cols-8 xl:flex xl:flex-wrap xl:justify-end">
              {navigationItems.map((item) => {
                const selected = item.view === selectedView;

                return (
                <a
                  key={item.view}
                  href={item.view === "dashboard" ? "/" : `/?view=${item.view}`}
                  aria-current={selected ? "page" : undefined}
                  className={`beam-nav-link flex min-h-10 items-center justify-center rounded-md px-2 py-2 text-center leading-tight transition focus:outline-none focus:ring-2 sm:px-3 ${
                    selected ? "beam-nav-link-active shadow-sm ring-1" : ""
                  }`}
                >
                  {item.label}
                </a>
                );
              })}
            </nav>
          </div>
        </aside>

        <div className="mx-auto w-full min-w-0 max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
          <header id="dashboard" className="flex flex-col gap-4 border-b border-zinc-200 pb-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              {currentViewCopy.eyebrow ? (
                <p className="beam-page-eyebrow text-sm font-semibold uppercase">{currentViewCopy.eyebrow}</p>
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
                <h2 id="operations-heading" className="text-2xl font-semibold">Screen overview</h2>
              </div>
              <p className={`text-sm font-semibold ${systemStatusTone === "good" ? "text-emerald-700" : systemStatusTone === "warn" ? "text-amber-800" : "text-zinc-600"}`}>
                {systemStatusLabel}
              </p>
            </div>
            <dl className="mt-4 grid gap-3 lg:grid-cols-3">
              <div className={`rounded-lg border p-4 shadow-sm ${playingDeviceCount > 0 ? "border-sky-200 bg-sky-50" : "border-zinc-200 bg-white"}`}>
                <dt className="text-xs font-semibold uppercase text-sky-800">Live playback</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{confirmedPlaybackLabel}</dd>
                {playingDetail ? <dd className="mt-1 text-sm text-zinc-600">{playingDetail}</dd> : null}
              </div>
              <div className={`rounded-lg border p-4 shadow-sm ${onlineDeviceCount === screenCount && screenCount > 0 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                <dt className={`text-xs font-semibold uppercase ${onlineDeviceCount === screenCount && screenCount > 0 ? "text-emerald-800" : "text-amber-800"}`}>Screens online</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{onlineScreensLabel}</dd>
                {onlineScreensDetail ? <dd className="mt-1 text-sm text-zinc-600">{onlineScreensDetail}</dd> : null}
              </div>
              <div className={`rounded-lg border p-4 shadow-sm ${syncIssueCount > 0 ? "border-amber-200 bg-amber-50" : "border-teal-200 bg-teal-50"}`}>
                <dt className={`text-xs font-semibold uppercase ${syncIssueCount > 0 ? "text-amber-800" : "text-teal-800"}`}>Playlist sync</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{playlistSyncLabel}</dd>
                {playlistSyncDetail ? <dd className="mt-1 break-words text-sm text-zinc-600">{playlistSyncDetail}</dd> : null}
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
                  <h2 id="now-playing-heading" className="mt-1 text-2xl font-semibold">{commandAttentionCount === 0 ? "All clear" : "Needs attention"}</h2>
                  <p className="mt-1 text-sm text-zinc-600">
                    {commandAttentionCount === 0
                      ? "Beam has nothing urgent to call out."
                      : "Screens or publish state that need a human check."}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <a
                    href="/?view=screens"
                    className="inline-flex min-h-10 items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-zinc-950 ring-1 ring-zinc-200 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    Screens
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
                    <h2 className="mt-1 text-2xl font-semibold">Selected screen</h2>
                    <p className="mt-1 text-sm text-zinc-600">{focusedScreenLocation} · {focusedScreenSummary}</p>
                  </div>
                  <ScreenFocusSelect
                    options={screenFocusOptions}
                    selectedScreenId={focusedScreen?.screenId ?? ""}
                  />
                </div>
                <div className="p-5">
                  <div className="rounded-[1.25rem] border border-zinc-700 bg-zinc-900 p-3 shadow-xl shadow-zinc-300/60">
                    <div className="beam-preview-panel relative overflow-hidden rounded-xl px-4 pb-9 pt-5 text-white shadow-inner ring-1 ring-white/20">
                      <div className="beam-preview-sheen absolute inset-0" />
                      <div className="relative flex min-h-[260px] flex-col justify-between gap-5">
                        <div>
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="beam-preview-overline text-sm font-semibold uppercase">{previewEyebrow}</p>
                              <p className="mt-2 break-words text-3xl font-black leading-tight sm:text-4xl">{focusedScreenTitle}</p>
                            </div>
                            {focusedLiveReportUrl ? (
                              <a
                                href={focusedLiveReportUrl}
                                target="_blank"
                                rel="noreferrer"
                                title="Open the selected screen's latest live report"
                                className="beam-preview-button inline-flex min-h-10 shrink-0 items-center justify-center rounded-md px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2"
                              >
                                Open live report
                              </a>
                            ) : null}
                          </div>
                          <p className="beam-preview-detail mt-3 max-w-sm text-sm leading-6">{focusedScreenDetail}</p>
                        </div>
                        <div className="grid gap-2 text-sm sm:grid-cols-2">
                          <div className="beam-preview-card rounded-lg p-3 ring-1">
                            <p className="beam-preview-card-label font-semibold">Current item</p>
                            <p className="mt-1 break-words font-semibold text-white">{focusedCurrentItemLabel}</p>
                          </div>
                          <div className="beam-preview-card rounded-lg p-3 ring-1">
                            <p className="beam-preview-card-label font-semibold">Playlist</p>
                            <p className="mt-1 break-words font-semibold text-white">{focusedPlaylistLoopLabel}</p>
                          </div>
                          <div className="beam-preview-card rounded-lg p-3 ring-1">
                            <p className="beam-preview-card-label font-semibold">Screen</p>
                            <p className="mt-1 break-words font-semibold text-white">{focusedScreenName}</p>
                          </div>
                          <div className="beam-preview-card rounded-lg p-3 ring-1">
                            <p className="beam-preview-card-label font-semibold">Host</p>
                            <p className="mt-1 break-words font-semibold text-white">{focusedScreenHost}</p>
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
            className={selectedView === "screens" ? "" : "hidden"}
          >
            <DeviceHealthFleetPanel
              dashboardMode={dashboardMode}
              deviceStatuses={deviceStatuses}
              devices={inventory.devices.items}
              screens={inventory.screens.items}
              playlists={playlistStore.items.map((item) => ({
                assetCount: item.assets.length,
                name: item.name,
                playlistId: item.playlistId,
                version: item.version
              }))}
            />
          </section>

          <section
            id="troubleshooting"
            aria-labelledby="troubleshooting-heading"
            className={selectedView === "troubleshooting" ? "mt-6" : "hidden"}
          >
            <h2 id="troubleshooting-heading" className="sr-only">Diagnostics</h2>
            <TroubleshootingPanel screens={troubleshootingScreens} />
          </section>

          <section
            id="media-store"
            aria-labelledby="media-store-heading"
            className={selectedView === "media-store" ? "mt-6" : "hidden"}
          >
            <h2 id="media-store-heading" className="sr-only">Library</h2>
            <MediaStorePanel mode={dashboardMode} />
          </section>

          <section
            id="layouts"
            aria-labelledby="layouts-heading"
            className={selectedView === "layouts" ? "mt-6" : "hidden"}
          >
            <h2 id="layouts-heading" className="sr-only">Layouts</h2>
            <LayoutsPanel
              playlists={playlistStore.items.map((item) => ({
                assetCount: item.assets.length,
                name: item.name,
                playlistId: item.playlistId
              }))}
            />
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
            className={selectedView === "playlist" ? "mt-6 space-y-5" : "hidden"}
          >
            <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-teal-700">Playlist workflow</p>
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
                </div>
                <div className="flex flex-wrap gap-2 xl:justify-end">
                  <StatusPill label={`${playlist.assets.length} items`} tone="muted" />
                  <StatusPill label={totalDuration} tone="muted" />
                  <StatusPill label={`${readyAssetCount} ready`} tone="good" />
                  {needsPrepAssetCount > 0 ? <StatusPill label={`${needsPrepAssetCount} needs prep`} tone="warn" /> : null}
                  <StatusPill label={selectedPlaylistLiveState.label} tone={selectedPlaylistLiveState.tone} />
                </div>
              </div>

              <ol className="mt-5 grid gap-2 md:grid-cols-4" aria-label="Playlist workflow steps">
                {workflowSteps.map((step, index) => {
                  const selected = step.id === selectedPlaylistStep;
                  const toneClassName = {
                    good: "border-emerald-200 bg-emerald-50 text-emerald-950",
                    muted: "border-zinc-200 bg-zinc-50 text-zinc-900",
                    warn: "border-amber-200 bg-amber-50 text-amber-950"
                  }[step.tone];
                  const stepClassName = selected
                    ? "border-teal-500 bg-teal-50 text-teal-950 shadow-sm ring-2 ring-teal-500 ring-offset-2 ring-offset-white"
                    : `${toneClassName} hover:border-teal-300 hover:bg-teal-50 hover:text-teal-950`;

                  return (
                    <li key={step.id} className="min-w-0">
                      <a
                        id={`playlist-workflow-step-${step.id}`}
                        href={playlistWorkflowStepHref(step.id)}
                        aria-current={selected ? "step" : undefined}
                        className={`block min-h-full rounded-md border p-3 transition focus:outline-none focus:ring-2 focus:ring-teal-500 ${stepClassName}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-sm font-bold ring-1 ring-inset ring-current">
                            {index + 1}
                          </span>
                          <span className="min-w-0 truncate text-sm font-semibold">{step.label}</span>
                        </div>
                        <p className="mt-2 text-sm font-semibold">{step.status}</p>
                        <p className="mt-1 line-clamp-2 text-xs opacity-80">{step.detail}</p>
                      </a>
                    </li>
                  );
                })}
              </ol>
            </div>

            <div id="playlist-workflow-panel" className="min-w-0">
              {selectedPlaylistStep === "playlist" ? (
                <section aria-labelledby="playlist-select-heading" className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                  <h3 id="playlist-select-heading" className="text-sm font-semibold uppercase text-zinc-600">1. Playlist</h3>
                  <div className="mt-4 grid gap-4">
                    <LocalPlaylistSwitcher currentPlaylistId={playlist.playlistId} playlists={playlistSwitchOptions} />
                    <div className="border-t border-zinc-200 pt-4">
                      <p className="text-sm font-semibold text-zinc-950">Create another playlist</p>
                      <div className="mt-3">
                        <LocalPlaylistCreateForm />
                      </div>
                    </div>
                  </div>
                </section>
              ) : null}

              {selectedPlaylistStep === "media" ? (
                <section aria-labelledby="playlist-add-media-heading" className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
                  <div className="border-b border-zinc-200 px-5 py-4">
                    <h3 id="playlist-add-media-heading" className="text-sm font-semibold uppercase text-zinc-600">2. Add media</h3>
                    <p className="mt-1 text-sm text-zinc-600">Choose from ready Pi-safe media and add it to this playlist.</p>
                  </div>
                  <LocalPlaylistBuilder
                    playlistAssetFileNames={playlistAssetFileNames}
                    playlistId={playlist.playlistId}
                  />
                </section>
              ) : null}

              {selectedPlaylistStep === "screens" ? (
                <section aria-labelledby="playlist-screens-heading" className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 shadow-sm">
                  <h3 id="playlist-screens-heading" className="text-sm font-semibold uppercase text-zinc-600">3. Screens</h3>
                  <p className="mt-1 text-sm text-zinc-600">Choose which screens should use this playlist before publishing.</p>
                  <div className="mt-4">
                    <LocalPlaylistScreenAssignment defaultOpen playlistId={playlist.playlistId} />
                  </div>
                </section>
              ) : null}

              {selectedPlaylistStep === "publish" ? (
                <section aria-labelledby="playlist-publish-heading" className="rounded-lg border border-teal-200 bg-teal-50 p-4 shadow-sm">
                  <h3 id="playlist-publish-heading" className="text-sm font-semibold uppercase text-teal-800">4. Publish</h3>
                  <p className="mt-1 text-sm text-teal-950">{playlist.name} · {shortScreenDetail(selectedPlaylistLiveState)}</p>
                  <LocalPublishForm
                    assetCount={playlist.assets.length}
                    assignedScreenCount={assignedScreens.length}
                    playlistId={playlist.playlistId}
                    screenAssignmentHref={playlistWorkflowStepHref("screens")}
                  />
                  {selectedPlaylistHasUnpublishedChanges ? (
                    <div className="mt-3">
                      <LocalPlaylistDiscardButton name={playlist.name} playlistId={playlist.playlistId} />
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>

            <section aria-labelledby="playlist-content-heading" className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="border-b border-zinc-200 px-5 py-4">
                <h3 id="playlist-content-heading" className="text-sm font-semibold uppercase text-zinc-600">Timeline and media list</h3>
                <p className="mt-1 text-sm text-zinc-600">Review the running order, then adjust names, durations, and order.</p>
              </div>
              {playlist.assets.length > 0 ? (
                <LocalPlaylistTimeline
                  assets={playlist.assets}
                  piAssetIds={Array.from(piAssetIds)}
                  playlistId={playlist.playlistId}
                />
              ) : (
                <div className="px-5 py-5 text-sm text-zinc-600">
                  Add local media to this playlist before publishing.
                </div>
              )}
              <LocalPlaylistSequence
                assets={playlist.assets}
                piAssetIds={Array.from(piAssetIds)}
                playlistId={playlist.playlistId}
              />
            </section>
          </section>

        </div>
      </div>
    </main>
  );
}
