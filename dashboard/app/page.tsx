import { promises as fs } from "node:fs";
import { Socket } from "node:net";
import { DashboardAutoRefresh } from "./dashboard-auto-refresh";
import { Metric, StatusPill } from "./dashboard-ui";
import { DeviceHealthFleetPanel } from "./device-health-fleet-panel";
import { readCloudBillingSummary, type CloudBillingSummary } from "./lib/cloud-billing-store";
import { readCloudHeartbeats } from "./lib/cloud-heartbeat";
import type { CloudHeartbeatState } from "./lib/cloud-heartbeat";
import { readCloudTransferSummary, type CloudTransferSummary } from "./lib/cloud-release-store";
import { ensureLocalDataFoundation } from "./lib/local-data-store";
import type { DeviceRecord, DeviceStore, ScreenRecord, ScreenStore } from "./lib/local-data-store";
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
import { LocalPlaylistRenameButton } from "./local-playlist-rename-button";
import { LocalPlaylistResetButton } from "./local-playlist-reset-button";
import { LocalPlaylistSwitcher } from "./local-playlist-switcher";
import { LocalPublishForm } from "./local-publish-form";
import { LocalPlaylistSequence } from "./local-playlist-sequence";
import { LocalPlaylistTimeline } from "./local-playlist-timeline";
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
  cloudBilling: CloudBillingSummary;
  cloudHeartbeats: Record<string, CloudHeartbeatState>;
  cloudTransfer: CloudTransferSummary;
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

type PlaylistSyncState = {
  detail: string;
  label: string;
  tone: StatusTone;
};

type CloudHeartbeatFleetSummary = {
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

type DashboardPageProps = {
  searchParams?: Promise<{
    playlist?: string | string[];
    screen?: string | string[];
    view?: string | string[];
  }>;
};

const navigationItems: Array<{ label: string; view: DashboardView }> = [
  { label: "What's Playing", view: "dashboard" },
  { label: "Library", view: "media-store" },
  { label: "Playlists", view: "playlist" },
  { label: "Screens", view: "screens" },
  { label: "Troubleshooting", view: "troubleshooting" },
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
    title: "Troubleshooting",
    description: "Pi evidence, setup details, logs, and recovery history for deeper troubleshooting."
  }
};

function dashboardViewFrom(value: string | string[] | undefined): DashboardView {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === "device-health") {
    return "troubleshooting";
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

function formatCurrency(value: number | null | undefined, currency: string = "USD"): string {
  if (typeof value !== "number") {
    return "Not reported";
  }

  return new Intl.NumberFormat("en", {
    currency,
    maximumFractionDigits: 2,
    style: "currency"
  }).format(value);
}

function formatDuration(assets: PlaylistAsset[]): string {
  const totalSeconds = assets.reduce((total, asset) => total + (asset.durationSeconds ?? 0), 0);
  const minutes = totalSeconds > 0 ? Math.max(1, Math.round(totalSeconds / 60)) : 0;
  return `${minutes}m`;
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
  return `${config.user}@${config.host}:${config.root}`;
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

  return {
    host: savedDevice.host.trim(),
    password: fallbackConfig?.password,
    root: savedDevice.rootPath?.trim() && savedDevice.rootPath !== "~" ? savedDevice.rootPath.trim() : fallbackConfig?.root ?? "/home/donnoel/PiSignage",
    user: savedDevice.sshUser?.trim() || fallbackConfig?.user || "donnoel"
  };
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
  const state = heartbeat.playbackState ?? (heartbeat.currentAssetId ? "playing" : "unknown");
  const playbackHealthy = fresh && state === "playing";

  return {
    ageLabel: formatStatusAge(timestamp),
    host: heartbeat.localIpAddress ?? device.host,
    playbackHealthy,
    playbackLabel: playbackHealthy ? "Playing" : fresh ? "Cloud heartbeat" : "Stale",
    playerStatus: {
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

function cloudHeartbeatTimestamp(cloudHeartbeat: CloudHeartbeatState | undefined): string | null {
  return cloudHeartbeat?.heartbeat?.receivedAt ?? cloudHeartbeat?.heartbeat?.timestamp ?? null;
}

function compactDeviceNames(devices: DeviceRecord[]): string {
  const names = devices.slice(0, 2).map((device) => device.name || device.id);
  const remainingCount = devices.length - names.length;

  return remainingCount > 0 ? `${names.join(", ")} +${remainingCount} more` : names.join(", ");
}

function expectedPlaylistForDevice(device: DeviceRecord, screens: ScreenRecord[], playlistStore: PlaylistStore): Playlist | null {
  const linkedScreen =
    (device.screenId ? screens.find((screen) => screen.id === device.screenId) : null) ??
    screens.find((screen) => screen.deviceId === device.id) ??
    null;
  const playlistId = linkedScreen?.playlistId ?? device.playlistId;

  return playlistId ? playlistStore.items.find((playlist) => playlist.playlistId === playlistId) ?? null : null;
}

function cloudHeartbeatFleetSummary(
  devices: DeviceRecord[],
  screens: ScreenRecord[],
  playlistStore: PlaylistStore,
  cloudHeartbeats: Record<string, CloudHeartbeatState>,
  isCloudDashboard: boolean
): CloudHeartbeatFleetSummary {
  if (!isCloudDashboard) {
    return {
      detail: "AWS heartbeat monitoring is only active in cloud mode.",
      label: "Local mode",
      tone: "muted"
    };
  }

  if (devices.length === 0) {
    return {
      detail: "No devices are registered for cloud heartbeat monitoring yet.",
      label: "No devices",
      tone: "muted"
    };
  }

  const entries = devices.map((device) => ({
    device,
    state: cloudHeartbeats[device.id]
  }));
  const firstState = entries.find((entry) => entry.state)?.state;

  if (entries.every((entry) => entry.state?.status === "not_configured")) {
    return {
      detail: firstState?.message ?? "AWS heartbeat monitoring is not configured.",
      label: "Not configured",
      tone: "muted"
    };
  }

  const freshEntries = entries.filter((entry) => {
    const timestamp = cloudHeartbeatTimestamp(entry.state);
    const ageMs = statusAgeMs(timestamp);

    return Boolean(entry.state?.ok && entry.state.heartbeat && ageMs !== null && ageMs <= staleHeartbeatThresholdMs);
  });
  const staleEntries = entries.filter((entry) => {
    const timestamp = cloudHeartbeatTimestamp(entry.state);
    const ageMs = statusAgeMs(timestamp);

    return Boolean(entry.state?.ok && entry.state.heartbeat && (ageMs === null || ageMs > staleHeartbeatThresholdMs));
  });
  const missingEntries = entries.filter((entry) => entry.state?.status === "not_found" || !entry.state);
  const errorEntries = entries.filter((entry) => entry.state?.status === "error");
  const playlistMismatchEntries = freshEntries.filter((entry) => {
    const expectedPlaylist = expectedPlaylistForDevice(entry.device, screens, playlistStore);
    const heartbeat = entry.state?.heartbeat;

    if (!expectedPlaylist || !heartbeat) {
      return false;
    }

    if (heartbeat.currentPlaylistId !== expectedPlaylist.playlistId) {
      return true;
    }

    return typeof heartbeat.playlistVersion === "number" && heartbeat.playlistVersion !== expectedPlaylist.version;
  });
  const currentCount = freshEntries.length;
  const label = `${currentCount}/${devices.length} current`;

  if (currentCount === devices.length && playlistMismatchEntries.length === 0) {
    const oldestEntry = freshEntries
      .slice()
      .sort((left, right) => {
        const leftTimestamp = new Date(cloudHeartbeatTimestamp(left.state) ?? 0).getTime();
        const rightTimestamp = new Date(cloudHeartbeatTimestamp(right.state) ?? 0).getTime();

        return leftTimestamp - rightTimestamp;
      })[0];
    const expectedPlaylist = oldestEntry ? expectedPlaylistForDevice(oldestEntry.device, screens, playlistStore) : null;
    const heartbeat = oldestEntry?.state?.heartbeat;
    const playlistLabel = expectedPlaylist?.name ?? heartbeat?.currentPlaylistId ?? "playlist not reported";
    const versionLabel = typeof heartbeat?.playlistVersion === "number" ? ` v${heartbeat.playlistVersion}` : "";

    return {
      detail: oldestEntry
        ? `Oldest: ${oldestEntry.device.name || oldestEntry.device.id} · ${formatStatusAge(cloudHeartbeatTimestamp(oldestEntry.state))} · ${playlistLabel}${versionLabel}.`
        : "All cloud heartbeats are current.",
      label,
      tone: "good"
    };
  }

  const issueDetails = [
    playlistMismatchEntries.length > 0 ? `${compactDeviceNames(playlistMismatchEntries.map((entry) => entry.device))} playlist mismatch` : null,
    staleEntries.length > 0
      ? `${staleEntries[0].device.name || staleEntries[0].device.id} stale ${formatStatusAge(cloudHeartbeatTimestamp(staleEntries[0].state))}`
      : null,
    missingEntries.length > 0 ? `${compactDeviceNames(missingEntries.map((entry) => entry.device))} missing` : null,
    errorEntries.length > 0 ? `${compactDeviceNames(errorEntries.map((entry) => entry.device))} unavailable` : null
  ].filter((detail): detail is string => Boolean(detail));

  return {
    detail: issueDetails.length > 0
      ? `${issueDetails.slice(0, 3).join("; ")}. ${currentCount}/${devices.length} fresh.`
      : `${currentCount}/${devices.length} fresh; waiting for complete fleet reports.`,
    label,
    tone: "warn"
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
  const [cloudBilling, cloudHeartbeats, cloudTransfer] = await Promise.all([
    readCloudBillingSummary(),
    readCloudHeartbeats(inventory.devices.items.map((device) => device.id)),
    readCloudTransferSummary()
  ]);
  const primaryPiConfig = piConfigFromInventory(inventory, playlist.playlistId);
  const pi = loadCachedPiProbe(primaryPiConfig);
  const deviceStatuses = await loadDeviceStatuses(inventory, cloudHeartbeats);
  const lastKnownPlayback = await resolveLastKnownPlayback(pi);

  return { cloudBilling, cloudHeartbeats, cloudTransfer, deviceStatuses, heartbeat, inventory, lastKnownPlayback, playlist, playlistStore, publishStatus, pi };
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
  lastReportLabel: string;
  playbackLabel: string;
  reachable: boolean;
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
      const assignedPlaylistId = linkedScreen?.playlistId ?? device.playlistId;
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
            : "Beam cannot reach this screen to verify playback or playlist state."
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
        lastReportLabel: isLive ? deviceStatus?.ageLabel ?? "No timestamp" : "not checking in",
        playbackLabel: playback,
        reachable,
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
  const isCloudDashboard = dashboardMode === "cloud";
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
  const currentViewCopy = viewCopy[selectedView];
  const { cloudBilling, cloudHeartbeats, cloudTransfer, deviceStatuses, heartbeat, inventory, lastKnownPlayback, playlist, playlistStore, publishStatus, pi } =
    await loadDashboardState(selectedPlaylistParam);
  const selectedScreenParam = scalarSearchParam(resolvedSearchParams?.screen);
  const playerStatus = pi.playerStatus;
  const playbackState = playerStatus?.state ?? (pi.reachable ? "unknown" : "unreachable");
  const isPlaying = playbackState === "playing";
  const playerStatusAgeMs = statusAgeMs(playerStatus?.updatedAt);
  const isPlayerStatusFresh = playerStatusAgeMs !== null && playerStatusAgeMs <= staleStatusThresholdMs;
  const heartbeatAgeMs = statusAgeMs(heartbeat?.timestamp);
  const isHeartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= staleHeartbeatThresholdMs;
  const cloudHeartbeatSummary = cloudHeartbeatFleetSummary(
    inventory.devices.items,
    inventory.screens.items,
    playlistStore,
    cloudHeartbeats,
    isCloudDashboard
  );
  const cloudTransferTone: "good" | "warn" | "muted" =
    !isCloudDashboard || !cloudTransfer.latestRelease
      ? "muted"
      : cloudTransfer.unexpectedBytesToday > 0
        ? "warn"
        : "good";
  const cloudTransferLabel =
    !isCloudDashboard
      ? "Local mode"
      : cloudTransfer.latestRelease
        ? formatBytes(cloudTransfer.downloadedBytesToday)
        : "No releases";
  const cloudTransferDetail =
    !isCloudDashboard
      ? "AWS transfer ledger is only active in cloud mode."
      : cloudTransfer.latestRelease
        ? `Planned ${formatBytes(cloudTransfer.plannedBytesToday)} today from ${cloudTransfer.releasesToday} publish release${cloudTransfer.releasesToday === 1 ? "" : "s"}; ${formatBytes(cloudTransfer.unexpectedBytesToday)} unexpected by Beam ledger.`
        : "No cloud release has been manually published today.";
  const cloudBillingTone: "good" | "warn" | "muted" =
    !isCloudDashboard || cloudBilling.status === "local" || cloudBilling.status === "manual"
      ? "muted"
      : cloudBilling.status === "available"
        ? "good"
        : "warn";
  const cloudBillingLabel =
    cloudBilling.status === "available"
      ? formatCurrency(cloudBilling.amountUsd, cloudBilling.currency)
      : cloudBilling.status === "manual"
        ? "Budget alerts"
      : cloudBilling.status === "local"
        ? "Local mode"
        : "Unavailable";
  const cloudBillingDetail =
    cloudBilling.status === "available"
      ? `${cloudBilling.estimated ? "Estimated" : "Actual"} month-to-date AWS account cost.`
      : cloudBilling.message;
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
    assignedScreensLabel,
    dashboardMode
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
    playlistStore
  });
  const onlineDeviceCount = fleetRows.filter((row) => row.healthLabel === "Online").length;
  const offlineDeviceCount = fleetRows.filter((row) => row.healthLabel === "Offline").length;
  const notReportingDeviceCount = fleetRows.filter((row) => row.healthLabel === "Not reporting").length;
  const disconnectedDeviceCount = offlineDeviceCount + notReportingDeviceCount;
  const playingDeviceCount = fleetRows.filter((row) => row.playbackLabel === "Playing").length;
  const staleDeviceCount = fleetRows.filter((row) => row.playbackLabel === "Stale").length;
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
  const focusedScreenTitle = focusedScreenIsLive
    ? focusedScreenReachable
      ? focusedScreen.assignedPlaylistName
      : "Screen offline"
    : "Waiting for check-in";
  const focusedScreenDetail = focusedScreenIsLive
    ? focusedScreenReachable
      ? focusedScreen.syncTone === "good"
        ? `VLC reports ${focusedScreen.assignedPlaylistName} is in sync. Exact item position is not reported yet across the ${pluralize(focusedScreen.assignedPlaylistAssetCount ?? 0, "item")} loop.`
        : focusedScreen.detail
      : focusedScreen.detail
    : "This screen is saved in Beam. Once it checks in, its current playback will appear here.";
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
  const focusedPlayerUrl =
    focusedScreen?.host && focusedScreen.host !== "Not configured"
      ? `http://${focusedScreen.host}:5173/?playlist=/playlist.local.json`
      : !focusedScreen && piPlayerUrl
        ? piPlayerUrl
        : null;
  const setupLocationName = focusedScreen?.location ?? localLocationName;
  const setupScreenName = focusedScreen?.screenName ?? localScreenName;
  const setupDeviceIdentifier =
    focusedScreen ? focusedScreen.host || "No host" : localDeviceIdentifier;
  const focusedScreenMatchesPrimaryPi = Boolean(
    focusedScreen?.host &&
      pi.host &&
      normalizeIdentity(focusedScreen.host) === normalizeIdentity(pi.host)
  );
  const setupStatusLabel = focusedScreen
    ? focusedScreen.reachable
      ? "Online"
      : focusedScreen.isLive
        ? "Offline"
        : "Not reporting"
    : pi.reachable
      ? "Online"
      : "Offline";
  const setupStatusTone: "good" | "warn" | "muted" = focusedScreen?.reachable || (!focusedScreen && pi.reachable)
    ? "good"
    : focusedScreen?.isLive || !focusedScreen
      ? "warn"
      : "muted";
  const setupStatusTimestamp = focusedScreen ? focusedScreen.lastReportLabel : playerUpdatedAt;
  const setupStatusDetail = focusedScreen ? focusedScreen.detail : pi.message;
  const setupTemperature = focusedScreenMatchesPrimaryPi ? formatTemperature(pi.temp) : "Not reported";
  const setupThrottle = focusedScreenMatchesPrimaryPi ? formatThrottle(pi.throttled) : "Not reported";
  const setupUptime = focusedScreenMatchesPrimaryPi ? pi.uptime ?? "Unknown" : "Not reported";
  const setupDiskFree =
    focusedScreenMatchesPrimaryPi && isHeartbeatFresh ? formatBytes(heartbeat?.diskFreeBytes) : "Not reported";
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
        ? `${actionLabel(publishStatusForSelected.action)} wrote playlist v${publishStatusForSelected.playlistVersion}. ${publishStatusDisplayMessage(publishStatusForSelected)} ${publishAssetSyncDetail(publishStatusForSelected)}`
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
      <div className="min-h-screen">
        <aside className="border-b border-cyan-200 bg-[radial-gradient(circle_at_top_left,rgba(94,234,212,0.34),transparent_44%),linear-gradient(180deg,#e4fbf7_0%,#f1fbff_48%,#ffffff_100%)] px-5 py-5 text-slate-950 shadow-[inset_0_-1px_0_rgba(20,184,166,0.2)]">
          <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
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
              <details className="group relative mt-3 w-fit max-w-full">
                <summary
                  className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-teal-500 pl-3 text-xs text-slate-700 outline-none transition hover:text-teal-950 focus-visible:ring-2 focus-visible:ring-teal-500 marker:hidden [&::-webkit-details-marker]:hidden"
                  aria-label={`Current workspace session: ${workspaceName}; ${workspaceRoleLabel}; ${workspaceSession.user.displayName}`}
                >
                  <span className="font-semibold text-slate-950">{workspaceName}</span>
                  <span>{workspaceRoleLabel}</span>
                  <span>{workspaceSession.user.displayName}</span>
                  <span className="text-teal-700 transition group-open:rotate-180" aria-hidden="true">v</span>
                </summary>
                <div className="absolute left-0 z-20 mt-3 w-[min(22rem,calc(100vw-2.5rem))] rounded-md border border-cyan-200 bg-white p-4 text-sm shadow-lg">
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
                                  <span className={active ? "text-xs font-semibold text-teal-700" : "text-xs text-zinc-500"}>
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
            <nav aria-label="Beam views" className="grid grid-cols-4 gap-2 text-xs font-medium text-slate-700 sm:text-sm lg:grid-cols-8 xl:flex xl:flex-wrap xl:justify-end">
              {navigationItems.map((item) => {
                const selected = item.view === selectedView;

                return (
                <a
                  key={item.view}
                  href={item.view === "dashboard" ? "/" : `/?view=${item.view}`}
                  aria-current={selected ? "page" : undefined}
                  className={`flex min-h-10 items-center justify-center rounded-md px-2 py-2 text-center leading-tight transition focus:outline-none focus:ring-2 focus:ring-teal-500 sm:px-3 ${
                    selected ? "bg-white text-teal-950 shadow-sm ring-1 ring-cyan-200" : "hover:bg-white/70 hover:text-teal-950"
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
                <h2 id="operations-heading" className="text-2xl font-semibold">Screen overview</h2>
              </div>
              <p className={`text-sm font-semibold ${systemStatusTone === "good" ? "text-emerald-700" : systemStatusTone === "warn" ? "text-amber-800" : "text-zinc-600"}`}>
                {systemStatusLabel}
              </p>
            </div>
            <dl className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
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
              <div className={`rounded-lg border p-4 shadow-sm ${cloudHeartbeatSummary.tone === "good" ? "border-emerald-200 bg-emerald-50" : cloudHeartbeatSummary.tone === "warn" ? "border-amber-200 bg-amber-50" : "border-zinc-200 bg-white"}`}>
                <dt className="text-xs font-semibold uppercase text-zinc-600">AWS heartbeat</dt>
                <dd className="mt-2 flex items-center gap-2 text-2xl font-semibold text-zinc-950">
                  {cloudHeartbeatSummary.label}
                </dd>
                <dd className="mt-1 break-words text-sm text-zinc-600">{cloudHeartbeatSummary.detail}</dd>
              </div>
              <div className={`rounded-lg border p-4 shadow-sm ${cloudTransferTone === "good" ? "border-emerald-200 bg-emerald-50" : cloudTransferTone === "warn" ? "border-amber-200 bg-amber-50" : "border-zinc-200 bg-white"}`}>
                <dt className="text-xs font-semibold uppercase text-zinc-600">AWS transfer</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{cloudTransferLabel}</dd>
                <dd className="mt-1 break-words text-sm text-zinc-600">{cloudTransferDetail}</dd>
              </div>
              <div className={`rounded-lg border p-4 shadow-sm ${cloudBillingTone === "good" ? "border-emerald-200 bg-emerald-50" : cloudBillingTone === "warn" ? "border-amber-200 bg-amber-50" : "border-zinc-200 bg-white"}`}>
                <dt className="text-xs font-semibold uppercase text-zinc-600">AWS bill</dt>
                <dd className="mt-2 text-2xl font-semibold text-zinc-950">{cloudBillingLabel}</dd>
                <dd className="mt-1 break-words text-sm text-zinc-600">{cloudBillingDetail}</dd>
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
            className={selectedView === "screens" ? "" : "hidden"}
          >
            <DeviceHealthFleetPanel
              dashboardMode={dashboardMode}
              deviceStatuses={deviceStatuses}
              devices={inventory.devices.items}
              screens={inventory.screens.items}
              liveHost={pi.host}
              livePlayerUrl={piPlayerUrl}
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
            className={selectedView === "troubleshooting" ? "mt-6 space-y-6" : "hidden"}
          >
            <h2 id="troubleshooting-heading" className="sr-only">Troubleshooting</h2>
            <section aria-labelledby="recovery-history-heading" className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="flex flex-col gap-2 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 id="recovery-history-heading" className="text-xl font-semibold">Playback evidence</h3>
                  <p className="mt-1 text-sm text-zinc-600">
                    Detailed local evidence from the connected Pi. Items that need attention appear first.
                  </p>
                </div>
                <StatusPill
                  label={
                    supportAttentionCount === 0
                      ? "All clear"
                      : `${supportAttentionCount} ${supportAttentionCount === 1 ? "item needs" : "items need"} attention`
                  }
                  tone={supportAttentionCount === 0 ? "good" : "warn"}
                />
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
                </section>

                <section id="field-setup" aria-labelledby="field-setup-heading" className="rounded-lg border border-zinc-200 bg-white shadow-sm">
                  <div className="border-b border-zinc-200 p-5">
                    <h3 id="field-setup-heading" className="text-xl font-semibold">Setup and Pi details</h3>
                  </div>
                  <div className="grid gap-4 p-5 xl:grid-cols-[1.1fr_0.9fr]">
                    <div className="rounded-md border border-zinc-200 bg-zinc-50">
                      <div className="border-b border-zinc-200 p-5">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <h4 className="text-lg font-semibold">{setupLocationName}</h4>
                            <p className="mt-1 text-sm text-zinc-600">Local setup from saved configuration and the latest Pi check.</p>
                          </div>
                          <StatusPill label={setupStatusLabel} tone={setupStatusTone} />
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
                          <dd className="mt-2 text-lg font-semibold">{setupStatusTimestamp}</dd>
                          <dd className="mt-1 text-zinc-600">{setupStatusDetail}</dd>
                        </div>
                      </dl>
                    </div>

                    <div id="device-health" className="rounded-md border border-zinc-200 bg-zinc-50 p-5">
                      <h4 className="text-lg font-semibold">Pi readings</h4>
                      <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                        <Metric label="Temperature" value={setupTemperature} />
                        <Metric label="Throttle" value={setupThrottle} />
                        <Metric label="Uptime" value={setupUptime} />
                        <Metric label="Disk free" value={setupDiskFree} />
                      </dl>
                    </div>
                  </div>
                </section>

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
            className={selectedView === "playlist" ? "mt-6 space-y-4" : "hidden"}
          >
            <div className="grid gap-4 xl:grid-cols-[minmax(260px,0.8fr)_minmax(360px,1fr)_minmax(360px,1fr)] xl:items-start">
              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
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
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusPill label={`${playlist.assets.length} items`} tone="muted" />
                  <StatusPill label={totalDuration} tone="muted" />
                  <StatusPill label={`${readyAssetCount} ready`} tone="good" />
                  {needsPrepAssetCount > 0 ? <StatusPill label={`${needsPrepAssetCount} needs prep`} tone="warn" /> : null}
                  <StatusPill label={selectedPlaylistLiveState.label} tone={selectedPlaylistLiveState.tone} />
                </div>
                <div className="mt-4">
                  <LocalPlaylistCreateForm />
                </div>
              </div>

              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 shadow-sm">
                <h3 className="text-sm font-semibold uppercase text-teal-800">Ready to send</h3>
                <p className="mt-1 text-sm text-teal-950">{playlist.name} · {shortScreenDetail(selectedPlaylistLiveState)}</p>
                <LocalPublishForm
                  assetCount={playlist.assets.length}
                  assignedScreenCount={assignedScreens.length}
                  assignmentTargetId="playlist-screen-assignment"
                  playlistId={playlist.playlistId}
                />
              </div>

              <div className="grid min-w-0 gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <LocalPlaylistSwitcher currentPlaylistId={playlist.playlistId} playlists={playlistSwitchOptions} />
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <LocalPlaylistResetButton playlistCount={playlistOptions.length} />
                </div>
              </div>
            </div>

            <LocalPlaylistScreenAssignment playlistId={playlist.playlistId} />

            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="min-w-0">
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
                    Add local media to this playlist before publishing.
                  </div>
                )}
                <LocalPlaylistSequence
                  assets={playlist.assets}
                  piAssetIds={Array.from(piAssetIds)}
                  playlistId={playlist.playlistId}
                />
              </div>
            </div>

          </section>

        </div>
      </div>
    </main>
  );
}
