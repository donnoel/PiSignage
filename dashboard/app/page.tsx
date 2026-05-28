import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { LocalPlaylistControls } from "./local-playlist-controls";
import { LocalUploadForm } from "./local-upload-form";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type PlaylistAsset = {
  assetId: string;
  type: "image" | "video";
  uri: string;
  durationSeconds?: number;
  altText?: string;
};

type Playlist = {
  playlistId: string;
  name: string;
  version: number;
  updatedAt: string;
  assets: PlaylistAsset[];
};

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

const fallbackDeviceId = "device-local-demo";
const localLocationName = "Home TV Field Test";
const localScreenName = "Living Room TV";
const execTimeoutMs = 4_000;

function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
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
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
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

function serviceLabel(activeState: string | null, subState: string | null): string {
  if (!activeState) {
    return "Unknown";
  }

  return subState ? `${activeState} / ${subState}` : activeState;
}

function serviceTone(activeState: string | null): "good" | "warn" | "muted" {
  return activeState === "active" ? "good" : "warn";
}

function bootRecoveryLabel(pi: PiProbe, isPlaying: boolean): string {
  if (!pi.reachable) {
    return "Unknown";
  }

  return isPlaying ? "Recovered" : "Check";
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

function quoteTclListValue(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\$/g, "\\$")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

async function runSshProbe(
  user: string,
  host: string,
  remoteCommand: string,
  password: string | undefined
): Promise<string> {
  const args = [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=2",
    ...(password ? [] : ["-o", "BatchMode=yes"]),
    `${user}@${host}`,
    remoteCommand
  ];

  if (!password) {
    const { stdout } = await execFileAsync("ssh", args, {
      maxBuffer: 1024 * 1024,
      timeout: execTimeoutMs
    });
    return stdout;
  }

  const commandArgs = ["ssh", ...args].map(quoteTclListValue).join(" ");
  const expectScript = `
set timeout 4
set password ${quoteTclListValue(password)}
set commandArgs [list ${commandArgs}]
spawn {*}$commandArgs
expect {
  -nocase "*password:*" { send -- "$password\\r"; exp_continue }
  -nocase "*permission denied*" { exit 13 }
  timeout { exit 124 }
  eof
}
catch wait result
exit [lindex $result 3]
`;

  const { stdout } = await execFileAsync("expect", ["-c", expectScript], {
    maxBuffer: 1024 * 1024,
    timeout: execTimeoutMs + 1_000
  });
  return stdout;
}

async function loadPiProbe(): Promise<PiProbe> {
  const host = process.env.PISIGNAGE_PI_HOST?.trim() || null;
  const user = process.env.PISIGNAGE_PI_USER?.trim() || "donnoel";
  const password = process.env.PISIGNAGE_PI_PASSWORD;

  if (!host) {
    return {
      configured: false,
      reachable: false,
      host,
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
    const stdout = cleanProbeOutput(await runSshProbe(user, host, remoteCommand, password));

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
      host,
      message: `Connected to ${host} over local SSH.`,
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
      ? `Pi SSH rejected the local probe for ${user}@${host}. Update SSH key access or local credentials for this network.`
      : message.includes("timed out") || message.includes("ETIMEDOUT")
        ? `Pi probe timed out for ${host}. Confirm the Pi is on this network and SSH is reachable.`
        : `Pi probe could not read local playback status from ${host}.`;

    return {
      configured: true,
      reachable: false,
      host,
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
  const playlistPath = path.join(root, "sample-content", "playlist.local.json");
  const heartbeatPath = path.join(root, "device-agent", "local-state", "heartbeat.json");
  const publishStatusPath = path.join(root, "dashboard", "local-state", "publish-status.json");
  const [playlist, heartbeat, publishStatus, pi] = await Promise.all([
    readJsonFile<Playlist>(playlistPath),
    readJsonFile<Heartbeat>(heartbeatPath),
    readJsonFile<PublishStatus>(publishStatusPath),
    loadPiProbe()
  ]);

  if (!playlist) {
    throw new Error(`Missing local playlist: ${playlistPath}`);
  }

  return { heartbeat, playlist, publishStatus, pi };
}

function StatusPill({ label, tone }: { label: string; tone: "good" | "warn" | "muted" }) {
  const className = {
    good: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    warn: "bg-amber-100 text-amber-900 ring-amber-200",
    muted: "bg-zinc-100 text-zinc-700 ring-zinc-200"
  }[tone];

  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${className}`}>{label}</span>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-zinc-950">{value}</p>
      {detail ? <p className="mt-1 text-sm text-zinc-600">{detail}</p> : null}
    </div>
  );
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
    remove: "Remove",
    "restore-baseline": "Restore baseline",
    upload: "Upload"
  }[action ?? ""] ?? "Not recorded";
}

export default async function DashboardPage() {
  const { heartbeat, playlist, publishStatus, pi } = await loadDashboardState();
  const playerStatus = pi.playerStatus;
  const playbackState = playerStatus?.state ?? (pi.reachable ? "unknown" : "unreachable");
  const isPlaying = playbackState === "playing";
  const currentAsset = assetLabel(playlist, heartbeat?.currentAssetId);
  const playerUpdatedAt = formatTimestamp(playerStatus?.updatedAt);
  const heartbeatUpdatedAt = formatTimestamp(heartbeat?.timestamp);
  const totalDuration = formatDuration(playlist.assets);
  const activeAssetCount = playerStatus?.assetCount ?? playlist.assets.length;
  const piPlaylistVersion = playerStatus?.playlistVersion;
  const playlistSyncState = syncState(playlist.version, piPlaylistVersion, pi.reachable);
  const lastPublishLabel = publishStatus
    ? `${actionLabel(publishStatus.action)} · ${formatTimestamp(publishStatus.timestamp)}`
    : "No publish recorded";

  return (
    <main className="min-h-screen bg-[#f4f6f8] text-zinc-950">
      <div className="grid min-h-screen lg:grid-cols-[220px_1fr]">
        <aside className="border-r border-zinc-200 bg-white px-5 py-6 lg:sticky lg:top-0 lg:h-screen">
          <div className="text-2xl font-black tracking-tight">PiSignage</div>
          <p className="mt-1 text-xs font-semibold uppercase text-teal-700">Local operations</p>
          <nav aria-label="Dashboard sections" className="mt-8 space-y-1 text-sm font-medium text-zinc-700">
            {[
              "Dashboard",
              "Locations",
              "Screens",
              "Playlist",
              "Recovery",
              "Media",
              "Device health"
            ].map((item) => (
              <a
                key={item}
                href={`#${item.toLowerCase().replace(/\s+/g, "-")}`}
                className="block rounded-md px-3 py-2 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {item}
              </a>
            ))}
          </nav>
        </aside>

        <div className="px-6 py-6 lg:px-8">
          <header id="dashboard" className="flex flex-col gap-4 border-b border-zinc-200 pb-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase text-teal-700">Local proof of concept</p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight">Operations Dashboard</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
                One local dashboard, one Raspberry Pi, one TV, and a VLC field player. Cloud services stay deferred until local playback and recovery are proven end to end.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill label={pi.reachable ? "Pi reachable" : "Pi unreachable"} tone={pi.reachable ? "good" : "warn"} />
              <StatusPill label={isPlaying ? "Playing" : playbackState} tone={isPlaying ? "good" : "muted"} />
            </div>
          </header>

          <section aria-labelledby="overview-heading" className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <h2 id="overview-heading" className="sr-only">Overview</h2>
            <Metric label="Playback" value={isPlaying ? "Live" : "Check"} detail={`Mode: ${playerStatus?.mode ?? "Local VLC"}`} />
            <Metric label="Playlist" value={`Local v${playlist.version}`} detail={`Pi ${piPlaylistVersion ? `v${piPlaylistVersion}` : "unknown"} · ${activeAssetCount} assets`} />
            <Metric label="Display" value={formatDisplayMode(playerStatus?.displayMode) ?? pi.displayMode ?? "Unknown"} detail={playerStatus?.displayOutput ?? "HDMI status from local probe"} />
            <Metric label="VLC load" value={pi.vlcCpuPercent ?? "Unknown"} detail={pi.vlcMemoryMb ? `${pi.vlcMemoryMb} memory` : "Pi probe unavailable"} />
          </section>

          <section aria-labelledby="sync-heading" className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
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
          </section>

          <section id="recovery" aria-labelledby="recovery-heading" className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="recovery-heading" className="text-xl font-semibold">Recovery evidence</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  Live local proof that boot recovery, the field player, display, and health checks are still reporting.
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
                <dd className="mt-2 text-lg font-semibold">{bootRecoveryLabel(pi, isPlaying)}</dd>
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

          <section id="locations" aria-labelledby="locations-heading" className="mt-6 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="border-b border-zinc-200 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 id="locations-heading" className="text-xl font-semibold">{localLocationName}</h2>
                    <p className="mt-1 text-sm text-zinc-600">Local field setup at the house</p>
                  </div>
                  <StatusPill label={pi.reachable ? "Online" : "Offline"} tone={pi.reachable ? "good" : "warn"} />
                </div>
              </div>
              <dl className="grid gap-0 divide-y divide-zinc-200 text-sm sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                <div className="p-5">
                  <dt className="font-semibold text-zinc-500">Screen</dt>
                  <dd className="mt-2 text-lg font-semibold">{localScreenName}</dd>
                  <dd className="mt-1 text-zinc-600">Device ID: {heartbeat?.deviceId ?? fallbackDeviceId}</dd>
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
                <Metric label="Disk free" value={formatBytes(heartbeat?.diskFreeBytes)} />
              </dl>
            </div>
          </section>

          <section id="screens" aria-labelledby="screens-heading" className="mt-6 rounded-lg border border-zinc-200 bg-white shadow-sm">
            <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 id="screens-heading" className="text-xl font-semibold">Screens</h2>
                <p className="mt-1 text-sm text-zinc-600">Local-only screen inventory for the proof of concept.</p>
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
                    <td className="px-5 py-4"><StatusPill label={isPlaying ? "Playing" : playbackState} tone={isPlaying ? "good" : "warn"} /></td>
                    <td className="px-5 py-4">VLC field player</td>
                    <td className="px-5 py-4">{playlist.name}</td>
                    <td className="px-5 py-4">{playerUpdatedAt}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="playlist" aria-labelledby="playlist-heading" className="mt-6 grid gap-4 xl:grid-cols-[1fr_360px]">
            <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 id="playlist-heading" className="text-xl font-semibold">{playlist.name}</h2>
                  <p className="mt-1 text-sm text-zinc-600">Playlist ID: {playlist.playlistId} · Version {playlist.version}</p>
                </div>
                <p className="text-sm font-semibold text-zinc-700">Total duration {totalDuration}</p>
              </div>
              <ul className="divide-y divide-zinc-200">
                {playlist.assets.map((asset, index) => (
                  <li key={asset.assetId} className="grid gap-3 px-5 py-4 text-sm md:grid-cols-[48px_1fr_auto_auto] md:items-center">
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-zinc-100 text-sm font-bold text-zinc-700">{index + 1}</span>
                    <div>
                      <p className="font-semibold text-zinc-950">{asset.altText ?? asset.assetId}</p>
                      <p className="mt-1 text-zinc-600">{asset.uri}</p>
                    </div>
                    <span className="text-zinc-600">{asset.type} · {asset.durationSeconds ?? 0}s</span>
                    <LocalPlaylistControls
                      assetId={asset.assetId}
                      assetLabel={asset.altText ?? asset.assetId}
                      isFirst={index === 0}
                      isLast={index === playlist.assets.length - 1}
                      isOnlyItem={playlist.assets.length === 1}
                    />
                  </li>
                ))}
              </ul>
            </div>

            <div id="media" className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
              <h2 className="text-xl font-semibold">Upload media</h2>
              <p className="mt-1 text-sm leading-6 text-zinc-600">
                Append a local MP4 to the playlist. If Pi publishing is configured and reachable, the upload is copied to the Pi and VLC reloads from the updated playlist.
              </p>
              <LocalUploadForm />
            </div>
          </section>

          <section aria-labelledby="local-contract-heading" className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
            <h2 id="local-contract-heading" className="text-xl font-semibold">Local contract</h2>
            <div className="mt-4 grid gap-4 text-sm text-zinc-700 md:grid-cols-3">
              <p className="rounded-md bg-zinc-50 p-4">No AWS resources. Playback and status stay local until the foundation is proven.</p>
              <p className="rounded-md bg-zinc-50 p-4">Heartbeat updated {heartbeatUpdatedAt}. Network flag: {heartbeat?.networkOnline ? "online" : "offline or not reported"}.</p>
              <p className="rounded-md bg-zinc-50 p-4">Current heartbeat asset: {currentAsset}.</p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
