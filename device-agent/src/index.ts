import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type PlaylistAsset = {
  assetId: string;
  type: "image" | "video";
  uri: string;
  durationSeconds?: number;
  altText?: string;
  assetUrlEndpoint?: string;
  checksumSha256?: string;
  downloadUrl?: string;
  fileName?: string;
  sizeBytes?: number;
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
  hostname: string | null;
  localIpAddress: string | null;
  networkOnline: boolean;
  playbackState: string | null;
  playlistVersion: number | null;
};

type PlayerStatus = {
  currentAssetId?: string | null;
  playlistId?: string;
  playlistVersion?: unknown;
  state?: string;
};

type CloudHeartbeatConfig = {
  apiKey: string;
  baseUrl: string;
};

type CloudPlaylistResponse = {
  command?: DeviceCommand | null;
  localFirst?: boolean;
  playlist?: Playlist | null;
  release?: CloudReleaseCheck | null;
  schedule?: CloudScheduleStore | null;
  unchanged?: boolean;
};

type CloudScheduleStore = {
  items: unknown[];
  updatedAt?: string;
  version?: number;
};

type CloudReleaseCheck = {
  assetCount: number;
  manifestChecksum: string;
  manifestUrl: string;
  plannedBytes: number;
  playlistId: string;
  playlistName: string;
  playlistVersion: number;
  publishedAt: string;
  releaseId: string;
};

type CloudReleaseManifestResponse = {
  assets: PlaylistAsset[];
  manifestChecksum: string;
  playlist: Playlist;
  releaseId: string;
  syncResultUrl?: string;
};

type CachedReleaseState = {
  manifestChecksum: string;
  releaseId: string;
  syncedAt: string;
};

type ReleaseSyncStats = {
  downloadedBytes: number;
  failedAssetIds: string[];
  skippedBytes: number;
};

type AssetUrlResponse = {
  checksumSha256?: string | null;
  fileName: string;
  sizeBytes?: number;
  url: string;
};

type DeviceCommand = {
  id: string;
  requestedAt: string;
  status: "pending" | "running";
  statusUrl?: string;
  type: "collect-diagnostics" | "mute-audio" | "reboot-device" | "reset-device" | "restart-playback" | "run-recovery" | "unmute-audio";
};

type CommandStatus = "failed" | "running" | "succeeded";

type DiagnosticProbe = {
  detail: string;
  label: string;
  ok: boolean;
};

const appVersion = "0.1.0";
const currentPlaylistFileName = "current.json";
const currentReleaseFileName = "current-release.json";
const execFileAsync = promisify(execFile);
let stopping = false;

function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      level,
      event,
      timestamp: new Date().toISOString(),
      ...details
    })
  );
}

function parsePlaylist(rawPlaylist: string, source: string): Playlist {
  const parsed = JSON.parse(rawPlaylist) as Partial<Playlist>;

  if (
    typeof parsed.playlistId !== "string" ||
    typeof parsed.name !== "string" ||
    typeof parsed.version !== "number" ||
    typeof parsed.updatedAt !== "string" ||
    !Array.isArray(parsed.assets)
  ) {
    throw new Error(`Invalid playlist shape: ${source}`);
  }

  return parsed as Playlist;
}

async function readPlaylist(playlistPath: string): Promise<Playlist> {
  return parsePlaylist(await fs.readFile(playlistPath, "utf8"), playlistPath);
}

async function diskFreeBytes(rootPath: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(rootPath);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await fs.writeFile(temporaryPath, body, "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeBufferAtomic(filePath: string, value: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, value);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function playlistCachePath(cacheDirectory: string, playlistId: string): string {
  return path.join(cacheDirectory, "playlists", `${playlistId}.json`);
}

function currentPlaylistCachePath(cacheDirectory: string): string {
  return path.join(cacheDirectory, "playlists", currentPlaylistFileName);
}

function currentReleaseStatePath(cacheDirectory: string): string {
  return path.join(cacheDirectory, "releases", currentReleaseFileName);
}

function commandStatusPath(cacheDirectory: string, commandId: string): string {
  const safeCommandId = commandId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(cacheDirectory, "commands", `${safeCommandId}.json`);
}

function scheduleStorePath(root: string): string {
  return path.join(
    root,
    "sample-content",
    process.env.PISIGNAGE_SCHEDULE_FILE ?? "schedules.local.json"
  );
}

function localIpAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return null;
}

function normalizedCloudScheduleStore(input: CloudScheduleStore): CloudScheduleStore {
  return {
    items: Array.isArray(input.items) ? input.items : [],
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString(),
    version: typeof input.version === "number" && Number.isFinite(input.version) ? input.version : 0
  };
}

async function syncCloudScheduleStore(root: string, schedule: CloudScheduleStore): Promise<void> {
  const normalized = normalizedCloudScheduleStore(schedule);
  const filePath = scheduleStorePath(root);
  const current = await fs.readFile(filePath, "utf8")
    .then((value) => normalizedCloudScheduleStore(JSON.parse(value) as CloudScheduleStore))
    .catch(() => null);
  if (current && JSON.stringify(current) === JSON.stringify(normalized)) {
    return;
  }

  await writeJsonAtomic(filePath, normalized);
  log("info", "cloud.schedule.synced", {
    itemCount: normalized.items.length,
    version: normalized.version
  });

  await execFileAsync("systemctl", ["--user", "start", "--no-block", "pisignage-schedule.service"], {
    timeout: 10_000
  }).catch((error) => {
    log("error", "cloud.schedule.enforce_start_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
}

async function cachePlaylist(cacheDirectory: string, playlist: Playlist): Promise<void> {
  await writeJsonAtomic(playlistCachePath(cacheDirectory, playlist.playlistId), playlist);
  await writeJsonAtomic(currentPlaylistCachePath(cacheDirectory), playlist);
}

async function readCachedPlaylist(cacheDirectory: string): Promise<Playlist> {
  return readPlaylist(currentPlaylistCachePath(cacheDirectory));
}

function standbyPlaylist(): Playlist {
  return {
    assets: [],
    name: "Ready for publishing",
    playlistId: "playlist-ready-for-publishing",
    updatedAt: new Date().toISOString(),
    version: 0
  };
}

async function readCurrentReleaseState(cacheDirectory: string): Promise<CachedReleaseState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(currentReleaseStatePath(cacheDirectory), "utf8")) as Partial<CachedReleaseState>;
    if (
      typeof parsed.releaseId === "string" &&
      typeof parsed.manifestChecksum === "string" &&
      typeof parsed.syncedAt === "string"
    ) {
      return parsed as CachedReleaseState;
    }
  } catch {
    // Missing or malformed release state should not block cached playback.
  }

  return null;
}

async function writeCurrentReleaseState(cacheDirectory: string, value: CachedReleaseState): Promise<void> {
  await writeJsonAtomic(currentReleaseStatePath(cacheDirectory), value);
}

function safeRelativeAssetPath(uri: string): string | null {
  const normalized = path.normalize(uri);
  if (
    path.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    return null;
  }

  return normalized;
}

async function cacheLocalPlaylistAssets(
  playlistPath: string,
  cacheDirectory: string,
  playlist: Playlist
): Promise<void> {
  const playlistDirectory = path.dirname(playlistPath);

  for (const asset of playlist.assets) {
    const relativePath = safeRelativeAssetPath(asset.uri);
    if (!relativePath) {
      throw new Error(`Playlist asset path is not local: ${asset.assetId}`);
    }

    const sourcePath = path.join(playlistDirectory, relativePath);
    const targetPath = path.join(cacheDirectory, relativePath);
    const bytes = await fs.readFile(sourcePath);
    await writeBufferAtomic(targetPath, bytes);
  }
}

async function loadPlaylistWithCache(
  playlistPath: string,
  cacheDirectory: string
): Promise<{ playlist: Playlist; source: "playlist" | "cache" }> {
  try {
    const playlist = await readPlaylist(playlistPath);
    await cacheLocalPlaylistAssets(playlistPath, cacheDirectory, playlist);
    await cachePlaylist(cacheDirectory, playlist);
    return { playlist, source: "playlist" };
  } catch (error) {
    log("error", "playlist.read.failed", {
      playlistPath,
      message: error instanceof Error ? error.message : String(error)
    });

    const cachedPath = currentPlaylistCachePath(cacheDirectory);
    const playlist = await readPlaylist(cachedPath);
    return { playlist, source: "cache" };
  }
}

function cloudPlaylistUrl(): string | null {
  const url = process.env.PISIGNAGE_CLOUD_PLAYLIST_URL?.trim();
  return url ? url : null;
}

function cloudHeartbeatConfigured(): boolean {
  const baseUrl = process.env.PISIGNAGE_CLOUD_API_URL?.trim();
  const apiKey = process.env.PISIGNAGE_CLOUD_API_KEY?.trim();
  return Boolean(baseUrl || apiKey);
}

function cloudModeConfigured(): boolean {
  return Boolean(cloudPlaylistUrl() || cloudHeartbeatConfigured());
}

function configuredDeviceId(): string {
  const deviceId = process.env.PISIGNAGE_DEVICE_ID?.trim();

  if (deviceId) {
    if (deviceId === "device-local-demo" && cloudModeConfigured()) {
      log("error", "device.identity.demo_id_in_cloud", {
        message:
          "Cloud mode is using device-local-demo. Provision this Pi with a unique PISIGNAGE_DEVICE_ID before adding more devices."
      });
    }

    return deviceId;
  }

  if (cloudModeConfigured()) {
    throw new Error(
      "PISIGNAGE_DEVICE_ID is required when cloud playlist or cloud heartbeat is configured. Run device/pi/bin/pisignage-provision-device.sh on this Pi."
    );
  }

  return "device-local-demo";
}

function assetFileName(asset: PlaylistAsset): string {
  const candidate = asset.fileName ?? path.basename(asset.uri);
  return path.basename(candidate);
}

function cloudPlaylistUrlWithReleaseState(baseUrl: string, state: CachedReleaseState | null): string {
  if (!state) {
    return baseUrl;
  }

  const url = new URL(baseUrl);
  url.searchParams.set("currentReleaseId", state.releaseId);
  url.searchParams.set("manifestChecksum", state.manifestChecksum);
  return url.toString();
}

async function sha256ForFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function sha256ForBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function cachedAssetMatches(filePath: string, asset: PlaylistAsset): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (typeof asset.sizeBytes === "number" && asset.sizeBytes > 0 && stat.size !== asset.sizeBytes) {
      return false;
    }
    if (asset.checksumSha256 && (await sha256ForFile(filePath)) !== asset.checksumSha256) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function downloadCloudAsset(cacheDirectory: string, asset: PlaylistAsset): Promise<PlaylistAsset> {
  if (!asset.downloadUrl) {
    return asset;
  }

  const fileName = assetFileName(asset);
  const targetPath = path.join(cacheDirectory, "assets", fileName);
  if (await cachedAssetMatches(targetPath, { ...asset, fileName })) {
    return {
      ...asset,
      downloadUrl: undefined,
      fileName,
      uri: `assets/${fileName}`
    };
  }

  const response = await fetch(asset.downloadUrl);
  if (!response.ok) {
    throw new Error(`Asset ${asset.assetId} returned ${response.status}.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (typeof asset.sizeBytes === "number" && asset.sizeBytes > 0 && bytes.byteLength !== asset.sizeBytes) {
    throw new Error(`Asset ${asset.assetId} returned ${bytes.byteLength} bytes, expected ${asset.sizeBytes}.`);
  }
  if (asset.checksumSha256 && sha256ForBuffer(bytes) !== asset.checksumSha256) {
    throw new Error(`Asset ${asset.assetId} checksum did not match the release manifest.`);
  }
  await writeBufferAtomic(targetPath, bytes);

  return {
    ...asset,
    downloadUrl: undefined,
    fileName,
    uri: `assets/${fileName}`
  };
}

async function signedAssetUrl(asset: PlaylistAsset): Promise<AssetUrlResponse> {
  if (!asset.assetUrlEndpoint) {
    throw new Error(`Release asset ${asset.assetId} did not include an asset URL endpoint.`);
  }

  const response = await fetch(asset.assetUrlEndpoint);
  if (!response.ok) {
    throw new Error(`Asset URL endpoint for ${asset.assetId} returned ${response.status}.`);
  }

  const body = (await response.json()) as Partial<AssetUrlResponse>;
  if (typeof body.url !== "string" || typeof body.fileName !== "string") {
    throw new Error(`Asset URL endpoint for ${asset.assetId} returned an invalid response.`);
  }

  return body as AssetUrlResponse;
}

async function syncReleaseAsset(
  cacheDirectory: string,
  asset: PlaylistAsset
): Promise<{ asset: PlaylistAsset; downloadedBytes: number; skippedBytes: number }> {
  const fileName = assetFileName(asset);
  const targetPath = path.join(cacheDirectory, "assets", fileName);
  const normalizedAsset = { ...asset, fileName };

  if (await cachedAssetMatches(targetPath, normalizedAsset)) {
    return {
      asset: {
        ...normalizedAsset,
        assetUrlEndpoint: undefined,
        downloadUrl: undefined,
        uri: `assets/${fileName}`
      },
      downloadedBytes: 0,
      skippedBytes: asset.sizeBytes ?? 0
    };
  }

  const signed = await signedAssetUrl(asset);
  const response = await fetch(signed.url);
  if (!response.ok) {
    throw new Error(`Asset ${asset.assetId} returned ${response.status}.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const expectedSize = asset.sizeBytes ?? signed.sizeBytes;
  const expectedChecksum = asset.checksumSha256 ?? signed.checksumSha256 ?? undefined;
  if (typeof expectedSize === "number" && expectedSize > 0 && bytes.byteLength !== expectedSize) {
    throw new Error(`Asset ${asset.assetId} returned ${bytes.byteLength} bytes, expected ${expectedSize}.`);
  }
  if (expectedChecksum && sha256ForBuffer(bytes) !== expectedChecksum) {
    throw new Error(`Asset ${asset.assetId} checksum did not match the release manifest.`);
  }

  await writeBufferAtomic(targetPath, bytes);
  return {
    asset: {
      ...normalizedAsset,
      assetUrlEndpoint: undefined,
      downloadUrl: undefined,
      uri: `assets/${fileName}`
    },
    downloadedBytes: bytes.byteLength,
    skippedBytes: 0
  };
}

async function postReleaseSyncResult(
  manifest: CloudReleaseManifestResponse,
  stats: ReleaseSyncStats,
  result: "error" | "success" | "warning",
  message: string
): Promise<void> {
  if (!manifest.syncResultUrl) {
    return;
  }

  try {
    const response = await fetch(manifest.syncResultUrl, {
      body: JSON.stringify({
        assetCount: manifest.assets.length,
        downloadedBytes: stats.downloadedBytes,
        failedAssetIds: stats.failedAssetIds,
        message,
        result,
        skippedBytes: stats.skippedBytes
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });
    if (!response.ok) {
      throw new Error(`Sync result returned ${response.status}.`);
    }
  } catch (error) {
    log("error", "cloud.release.sync_result.failed", {
      message: error instanceof Error ? error.message : String(error),
      releaseId: manifest.releaseId
    });
  }
}

function resetScriptPath(root: string): string {
  return process.env.PISIGNAGE_RESET_SCRIPT_PATH?.trim() || path.join(root, "device", "pi", "bin", "pisignage-reset-device.sh");
}

function resetRebootEnabled(): boolean {
  return process.env.PISIGNAGE_RESET_REBOOT_AFTER_SUCCESS?.trim().toLowerCase() !== "false";
}

function shutdownBinaryPath(): string {
  return process.env.PISIGNAGE_RESET_SHUTDOWN_PATH?.trim() || "/usr/sbin/shutdown";
}

function summarizeOutput(stdout: string | undefined, stderr: string | undefined): string {
  const lines = `${stdout ?? ""}\n${stderr ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-12).join(" ") || "No reset output was returned.";
}

function truncateDiagnosticDetail(value: string, maxLength = 2_000): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Not reported.";
  }

  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength)}\n...truncated...`
    : trimmed;
}

async function readDiagnosticFile(label: string, filePath: string, fallback: string): Promise<DiagnosticProbe> {
  try {
    return {
      detail: truncateDiagnosticDetail(await fs.readFile(filePath, "utf8"), 3_000),
      label,
      ok: true
    };
  } catch {
    return {
      detail: fallback,
      label,
      ok: false
    };
  }
}

async function runReadOnlyProbe(label: string, command: string, timeoutMs = 10_000): Promise<DiagnosticProbe> {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-lc", command], {
      timeout: timeoutMs,
      maxBuffer: 128 * 1024
    });
    const detail = truncateDiagnosticDetail(`${stdout}\n${stderr}`);
    return {
      detail,
      label,
      ok: !/not-found|missing|failed|inactive|degraded/i.test(detail)
    };
  } catch (error) {
    const execError = error as Error & { stderr?: string; stdout?: string };
    return {
      detail: truncateDiagnosticDetail(`${execError.message}\n${execError.stdout ?? ""}\n${execError.stderr ?? ""}`),
      label,
      ok: false
    };
  }
}

async function collectRemoteDiagnostics(cacheDirectory: string): Promise<{
  capturedAt: string;
  deviceId: string;
  hostname: string | null;
  localIpAddress: string | null;
  probes: DiagnosticProbe[];
}> {
  const statusRoot = process.env.PISIGNAGE_STATUS_DIR?.trim() || path.join(os.homedir(), ".local", "state", "pisignage");
  const playerStatusPath = process.env.PISIGNAGE_PLAYER_STATUS_PATH?.trim() || path.join(statusRoot, "player-status.json");
  const heartbeatPath = process.env.PISIGNAGE_HEARTBEAT_PATH ?? path.join(statusRoot, "heartbeat.json");
  const scheduleStatusPath = process.env.PISIGNAGE_SCHEDULE_STATUS_PATH?.trim() || path.join(statusRoot, "schedule-status.json");
  const playlistPath = currentPlaylistCachePath(cacheDirectory);
  const assetsPath = path.join(cacheDirectory, "assets");
  const quotedPlaylistPath = JSON.stringify(playlistPath);
  const quotedAssetsPath = JSON.stringify(assetsPath);
  const probes: DiagnosticProbe[] = [
    await readDiagnosticFile("Player status", playerStatusPath, "player-status.json is missing."),
    await readDiagnosticFile("Heartbeat", heartbeatPath, "heartbeat.json is missing."),
    await readDiagnosticFile("Schedule status", scheduleStatusPath, "schedule-status.json is missing."),
    await runReadOnlyProbe(
      "VLC service",
      "systemctl --user show pisignage-vlc.service --property=ActiveState --property=SubState --property=NRestarts 2>/dev/null || echo service-status-unavailable"
    ),
    await runReadOnlyProbe(
      "Display",
      "kmsprint 2>/dev/null | sed -n '1,24p' || echo display-status-unavailable"
    ),
    await runReadOnlyProbe(
      "Health",
      "printf 'uptime='; uptime -p 2>/dev/null || uptime; printf '\\ntemp='; vcgencmd measure_temp 2>/dev/null || echo temp-unavailable; printf '\\nthrottle='; vcgencmd get_throttled 2>/dev/null || echo throttle-unavailable"
    ),
    await runReadOnlyProbe(
      "Network",
      "printf 'defaultRoute='; ip route get 1.1.1.1 2>/dev/null | head -n 1 || echo route-unavailable; printf '\\ninterfaces\\n'; for iface in eth0 wlan0; do ip -br -4 addr show dev \"$iface\" 2>/dev/null | awk '{print $1\" \"$2\" \"$3}'; done"
    ),
    await runReadOnlyProbe(
      "Playback cache",
      `printf 'playlistSha='; sha256sum ${quotedPlaylistPath} 2>/dev/null || echo playlist-missing; printf '\\nassetFiles='; find ${quotedAssetsPath} -maxdepth 1 -type f 2>/dev/null | wc -l`
    ),
    await runReadOnlyProbe(
      "Recent VLC logs",
      "journalctl --user -u pisignage-vlc.service -n 40 --no-pager 2>/dev/null || echo logs-unavailable",
      15_000
    )
  ];

  return {
    capturedAt: new Date().toISOString(),
    deviceId: configuredDeviceId(),
    hostname: os.hostname() || null,
    localIpAddress: localIpAddress(),
    probes
  };
}

async function postCommandStatus(
  command: DeviceCommand,
  status: CommandStatus,
  input: {
    finishedAt?: string;
    message: string;
    result?: unknown;
    startedAt: string;
  }
): Promise<void> {
  if (!command.statusUrl) {
    log("error", "cloud.command.status_url.missing", {
      commandId: command.id,
      status
    });
    return;
  }

  const response = await fetch(command.statusUrl, {
    body: JSON.stringify({
      commandId: command.id,
      finishedAt: input.finishedAt,
      message: input.message,
      result: input.result,
      startedAt: input.startedAt,
      status
    }),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Command status returned ${response.status}.`);
  }
}

async function assertResetRebootPermission(): Promise<void> {
  const shutdownPath = shutdownBinaryPath();
  await execFileAsync("/usr/bin/sudo", ["-n", "-l", shutdownPath], {
    timeout: 10_000
  });
}

async function requestResetReboot(): Promise<string> {
  const shutdownPath = shutdownBinaryPath();
  await execFileAsync("/usr/bin/sudo", [
    "-n",
    shutdownPath,
    "-r",
    "now",
    "Beam deployment reset complete"
  ], {
    timeout: 10_000
  });
  return "reboot_requested=true reboot_delay=now";
}

async function requestCommandReboot(): Promise<string> {
  const shutdownPath = shutdownBinaryPath();
  await execFileAsync("/usr/bin/sudo", [
    "-n",
    shutdownPath,
    "-r",
    "now",
    "Beam reboot requested"
  ], {
    timeout: 10_000
  });
  return "Reboot requested. The Pi should check in again after it restarts.";
}

async function restartPlaybackService(): Promise<string> {
  await execFileAsync("systemctl", ["--user", "restart", "pisignage-vlc.service"], {
    timeout: 45_000
  });
  const { stdout } = await execFileAsync("systemctl", ["--user", "is-active", "pisignage-vlc.service"], {
    timeout: 20_000
  });
  return `VLC playback restarted. Service state: ${stdout.trim() || "unknown"}.`;
}

async function muteVlcAudio(): Promise<string> {
  const overrideDirectory = path.join(os.homedir(), ".config", "systemd", "user", "pisignage-vlc.service.d");
  const overridePath = path.join(overrideDirectory, "audio.conf");
  await fs.mkdir(overrideDirectory, { recursive: true });
  await fs.writeFile(overridePath, "[Service]\nEnvironment=PISIGNAGE_VLC_AUDIO=off\n", "utf8");
  await execFileAsync("systemctl", ["--user", "daemon-reload"], {
    timeout: 20_000
  });
  await execFileAsync("systemctl", ["--user", "restart", "pisignage-vlc.service"], {
    timeout: 45_000
  });
  const { stdout } = await execFileAsync("systemctl", ["--user", "show", "pisignage-vlc.service", "--property=Environment"], {
    maxBuffer: 64 * 1024,
    timeout: 20_000
  });
  const confirmed = stdout.includes("PISIGNAGE_VLC_AUDIO=off");
  if (!confirmed) {
    throw new Error("Audio mute override was written, but systemd did not report PISIGNAGE_VLC_AUDIO=off.");
  }

  return "Audio muted. VLC will restart with audio disabled for this Pi.";
}

async function unmuteVlcAudio(): Promise<string> {
  const overrideDirectory = path.join(os.homedir(), ".config", "systemd", "user", "pisignage-vlc.service.d");
  const overridePath = path.join(overrideDirectory, "audio.conf");
  await fs.rm(overridePath, { force: true });
  await fs.rmdir(overrideDirectory).catch(() => undefined);
  await execFileAsync("systemctl", ["--user", "daemon-reload"], {
    timeout: 20_000
  });
  await execFileAsync("systemctl", ["--user", "restart", "pisignage-vlc.service"], {
    timeout: 45_000
  });
  const { stdout } = await execFileAsync("systemctl", ["--user", "show", "pisignage-vlc.service", "--property=Environment"], {
    maxBuffer: 64 * 1024,
    timeout: 20_000
  });
  const stillMuted = stdout.includes("PISIGNAGE_VLC_AUDIO=off");
  if (stillMuted) {
    throw new Error("Audio unmute was requested, but systemd still reports PISIGNAGE_VLC_AUDIO=off.");
  }

  return "Audio unmuted. VLC was restarted with audio enabled for this Pi.";
}

async function runRecoveryStep(title: string, command: string, timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-lc", command], {
      maxBuffer: 128 * 1024,
      timeout: timeoutMs
    });
    return `${title}: ok ${truncateDiagnosticDetail(`${stdout}\n${stderr}`, 600)}`;
  } catch (error) {
    const execError = error as Error & { stderr?: string; stdout?: string };
    return `${title}: failed ${truncateDiagnosticDetail(`${execError.message}\n${execError.stdout ?? ""}\n${execError.stderr ?? ""}`, 600)}`;
  }
}

async function runRecoveryAction(cacheDirectory: string): Promise<string> {
  const displayOutput = process.env.PISIGNAGE_DISPLAY_OUTPUT?.trim() || "HDMI-A-1";
  const displayMode = process.env.PISIGNAGE_DISPLAY_RESOLUTION?.trim() || "1920x1080@60.000000";
  const playlistPath = currentPlaylistCachePath(cacheDirectory);
  const assetsPath = path.join(cacheDirectory, "assets");
  const quotedDisplayOutput = JSON.stringify(displayOutput);
  const quotedDisplayMode = JSON.stringify(displayMode);
  const quotedPlaylistPath = JSON.stringify(playlistPath);
  const quotedAssetsPath = JSON.stringify(assetsPath);
  const steps = [
    await runRecoveryStep(
      "Collect service state before restart",
      "systemctl --user show pisignage-vlc.service --property=ActiveState --property=SubState --property=NRestarts 2>/dev/null || true"
    ),
    await runRecoveryStep("Restart VLC service", "systemctl --user restart pisignage-vlc.service", 45_000),
    await runRecoveryStep("Verify VLC service active", "systemctl --user is-active pisignage-vlc.service", 20_000),
    await runRecoveryStep(
      "Re-apply display mode",
      `/usr/bin/wlr-randr --output ${quotedDisplayOutput} --mode ${quotedDisplayMode} 2>/dev/null || echo display-mode-not-confirmed`
    ),
    await runRecoveryStep(
      "Collect player status snapshot",
      "cat ~/.local/state/pisignage/player-status.json 2>/dev/null || echo status-file-missing"
    ),
    await runRecoveryStep(
      "Collect playback cache footprint",
      `printf 'playlist-sha='; sha256sum ${quotedPlaylistPath} 2>/dev/null || echo playlist-missing; printf '\\nasset-files='; find ${quotedAssetsPath} -maxdepth 1 -type f 2>/dev/null | wc -l`
    ),
    await runRecoveryStep(
      "Collect boot and health evidence",
      "printf 'boot='; cat /proc/sys/kernel/random/boot_id 2>/dev/null || true; printf '\\nuptime='; uptime -p 2>/dev/null || uptime; printf '\\nthermals='; vcgencmd measure_temp 2>/dev/null || true; printf ' '; vcgencmd get_throttled 2>/dev/null || true"
    )
  ];
  const criticalFailed = steps.some((step) =>
    step.startsWith("Restart VLC service: failed") || step.startsWith("Verify VLC service active: failed")
  );
  if (criticalFailed) {
    throw new Error("Recovery check completed with failures. Restart VLC or service verification failed.");
  }

  return "Recovery check completed. VLC was restarted, service state was verified, and playback/cache/health evidence was collected.";
}

function actionRunningMessage(type: DeviceCommand["type"]): string {
  if (type === "mute-audio") {
    return "Mute audio is running on the Pi.";
  }
  if (type === "unmute-audio") {
    return "Unmute audio is running on the Pi.";
  }
  if (type === "restart-playback") {
    return "Restart playback is running on the Pi.";
  }
  if (type === "run-recovery") {
    return "Full recovery is running on the Pi.";
  }
  if (type === "reboot-device") {
    return "Reboot is running on the Pi.";
  }
  return "Remote command is running on the Pi.";
}

async function runActionCommand(cacheDirectory: string, command: DeviceCommand): Promise<void> {
  const startedAt = new Date().toISOString();
  const commandPath = commandStatusPath(cacheDirectory, command.id);
  await writeJsonAtomic(commandPath, {
    commandId: command.id,
    requestedAt: command.requestedAt,
    startedAt,
    status: "running",
    type: command.type
  });
  await postCommandStatus(command, "running", {
    message: actionRunningMessage(command.type),
    startedAt
  });

  log("info", "cloud.command.action.start", {
    commandId: command.id,
    type: command.type
  });

  try {
    const message =
      command.type === "mute-audio"
        ? await muteVlcAudio()
        : command.type === "unmute-audio"
        ? await unmuteVlcAudio()
        : command.type === "restart-playback"
        ? await restartPlaybackService()
        : command.type === "reboot-device"
          ? await requestCommandReboot()
          : await runRecoveryAction(cacheDirectory);
    const finishedAt = new Date().toISOString();
    await writeJsonAtomic(commandPath, {
      commandId: command.id,
      finishedAt,
      message,
      requestedAt: command.requestedAt,
      startedAt,
      status: "succeeded",
      type: command.type
    });
    await postCommandStatus(command, "succeeded", {
      finishedAt,
      message,
      startedAt
    });
    log("info", "cloud.command.action.complete", {
      commandId: command.id,
      type: command.type
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(commandPath, {
      commandId: command.id,
      finishedAt,
      message,
      requestedAt: command.requestedAt,
      startedAt,
      status: "failed",
      type: command.type
    });
    await postCommandStatus(command, "failed", {
      finishedAt,
      message,
      startedAt
    });
    throw error;
  }
}

async function runResetCommand(root: string, cacheDirectory: string, command: DeviceCommand): Promise<void> {
  const startedAt = new Date().toISOString();
  const commandPath = commandStatusPath(cacheDirectory, command.id);
  await writeJsonAtomic(commandPath, {
    commandId: command.id,
    requestedAt: command.requestedAt,
    startedAt,
    status: "running",
    type: command.type
  });
  await postCommandStatus(command, "running", {
    message: "Reset is running on the Pi.",
    startedAt
  });

  const scriptPath = resetScriptPath(root);
  log("info", "cloud.command.reset.start", {
    commandId: command.id,
    scriptPath
  });

  try {
    const rebootAfterSuccess = resetRebootEnabled();
    if (rebootAfterSuccess) {
      await assertResetRebootPermission();
    }

    const result = await execFileAsync(
      scriptPath,
      [
        "--repo-root",
        root,
        "--source",
        "golden-master",
        "--agent-safe",
        ...(rebootAfterSuccess ? ["--defer-field-player-restart"] : []),
        "--apply"
      ],
      {
        maxBuffer: 1024 * 1024,
        timeout: 5 * 60_000
      }
    );
    const finishedAt = new Date().toISOString();
    const outputMessage = summarizeOutput(result.stdout, result.stderr);
    const rebootMessage = rebootAfterSuccess ? await requestResetReboot() : "reboot_requested=false";
    const message = `${outputMessage} ${rebootMessage}`;
    await writeJsonAtomic(commandPath, {
      commandId: command.id,
      finishedAt,
      message,
      requestedAt: command.requestedAt,
      startedAt,
      status: "succeeded",
      type: command.type
    });
    await postCommandStatus(command, "succeeded", {
      finishedAt,
      message,
      startedAt
    });
    log("info", "cloud.command.reset.complete", {
      commandId: command.id
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const execError = error as Error & { stderr?: string; stdout?: string };
    const output = summarizeOutput(execError.stdout, execError.stderr);
    const message = `${execError.message}${output ? ` ${output}` : ""}`;
    await writeJsonAtomic(commandPath, {
      commandId: command.id,
      finishedAt,
      message,
      requestedAt: command.requestedAt,
      startedAt,
      status: "failed",
      type: command.type
    });
    await postCommandStatus(command, "failed", {
      finishedAt,
      message,
      startedAt
    });
    throw error;
  }
}

async function runDiagnosticsCommand(cacheDirectory: string, command: DeviceCommand): Promise<void> {
  const startedAt = new Date().toISOString();
  const commandPath = commandStatusPath(cacheDirectory, command.id);
  await writeJsonAtomic(commandPath, {
    commandId: command.id,
    requestedAt: command.requestedAt,
    startedAt,
    status: "running",
    type: command.type
  });
  await postCommandStatus(command, "running", {
    message: "Remote diagnostics are running on the Pi.",
    startedAt
  });

  log("info", "cloud.command.diagnostics.start", {
    commandId: command.id
  });

  try {
    const result = await collectRemoteDiagnostics(cacheDirectory);
    const finishedAt = new Date().toISOString();
    const failedProbeCount = result.probes.filter((probe) => !probe.ok).length;
    const message =
      failedProbeCount === 0
        ? "Remote diagnostics completed."
        : `Remote diagnostics completed with ${failedProbeCount} warning(s).`;
    await writeJsonAtomic(commandPath, {
      commandId: command.id,
      finishedAt,
      message,
      requestedAt: command.requestedAt,
      result,
      startedAt,
      status: "succeeded",
      type: command.type
    });
    await postCommandStatus(command, "succeeded", {
      finishedAt,
      message,
      result,
      startedAt
    });
    log("info", "cloud.command.diagnostics.complete", {
      commandId: command.id,
      failedProbeCount
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(commandPath, {
      commandId: command.id,
      finishedAt,
      message,
      requestedAt: command.requestedAt,
      startedAt,
      status: "failed",
      type: command.type
    });
    await postCommandStatus(command, "failed", {
      finishedAt,
      message,
      startedAt
    });
    throw error;
  }
}

async function fetchCloudPlaylist(cacheDirectory: string): Promise<{
  playlist: Playlist;
  source: "cache" | "cloud" | "standby";
}> {
  const url = cloudPlaylistUrl();
  if (!url) {
    throw new Error("Cloud playlist URL is not configured.");
  }

  const currentReleaseState = await readCurrentReleaseState(cacheDirectory);
  const response = await fetch(cloudPlaylistUrlWithReleaseState(url, currentReleaseState));
  if (!response.ok) {
    throw new Error(`Cloud playlist returned ${response.status}.`);
  }

  const body = (await response.json()) as CloudPlaylistResponse;
  if (body.command?.status === "pending") {
    if (body.command.type === "reset-device") {
      await runResetCommand(repoRoot(), cacheDirectory, body.command);
      return {
        playlist: standbyPlaylist(),
        source: "standby"
      };
    }
  }

  if (body.schedule) {
    await syncCloudScheduleStore(repoRoot(), body.schedule);
  }

  if (body.command?.status === "pending") {
    if (body.command.type === "collect-diagnostics") {
      await runDiagnosticsCommand(cacheDirectory, body.command);
    }

    if (
      body.command.type === "restart-playback" ||
      body.command.type === "mute-audio" ||
      body.command.type === "unmute-audio" ||
      body.command.type === "run-recovery" ||
      body.command.type === "reboot-device"
    ) {
      await runActionCommand(cacheDirectory, body.command);
    }
  }

  if (body.unchanged && body.release) {
    const playlist = await readCachedPlaylist(cacheDirectory);
    log("info", "cloud.release.unchanged", {
      manifestChecksum: body.release.manifestChecksum,
      releaseId: body.release.releaseId
    });
    return {
      playlist,
      source: "cache"
    };
  }

  if (body.release) {
    const manifestResponse = await fetch(body.release.manifestUrl);
    if (!manifestResponse.ok) {
      throw new Error(`Cloud release manifest returned ${manifestResponse.status}.`);
    }

    const manifest = (await manifestResponse.json()) as CloudReleaseManifestResponse;
    const stats: ReleaseSyncStats = {
      downloadedBytes: 0,
      failedAssetIds: [],
      skippedBytes: 0
    };
    const syncedAssets: PlaylistAsset[] = [];

    for (const asset of manifest.assets) {
      try {
        const synced = await syncReleaseAsset(cacheDirectory, asset);
        stats.downloadedBytes += synced.downloadedBytes;
        stats.skippedBytes += synced.skippedBytes;
        syncedAssets.push(synced.asset);
      } catch (error) {
        stats.failedAssetIds.push(asset.assetId);
        await postReleaseSyncResult(
          manifest,
          stats,
          "error",
          error instanceof Error ? error.message : `Asset ${asset.assetId} failed to sync.`
        );
        throw error;
      }
    }

    const cachedPlaylist = {
      ...parsePlaylist(JSON.stringify(manifest.playlist), body.release.manifestUrl),
      assets: syncedAssets
    };
    await cachePlaylist(cacheDirectory, cachedPlaylist);
    await writeCurrentReleaseState(cacheDirectory, {
      manifestChecksum: manifest.manifestChecksum,
      releaseId: manifest.releaseId,
      syncedAt: new Date().toISOString()
    });
    await postReleaseSyncResult(
      manifest,
      stats,
      stats.failedAssetIds.length === 0 ? "success" : "warning",
      `Synced release ${manifest.releaseId}: downloaded ${stats.downloadedBytes} byte(s), skipped ${stats.skippedBytes} cached byte(s).`
    );

    log("info", "cloud.release.synced", {
      downloadedBytes: stats.downloadedBytes,
      manifestChecksum: manifest.manifestChecksum,
      releaseId: manifest.releaseId,
      skippedBytes: stats.skippedBytes
    });

    return {
      playlist: cachedPlaylist,
      source: "cloud"
    };
  }

  if (body.localFirst) {
    return {
      playlist: await readCachedPlaylist(cacheDirectory),
      source: "cache"
    };
  }

  if (!body.playlist) {
    throw new Error("Cloud playlist response did not include a playlist.");
  }

  const playlist = parsePlaylist(JSON.stringify(body.playlist), url);
  const assets = await Promise.all(playlist.assets.map((asset) => downloadCloudAsset(cacheDirectory, asset)));
  const cachedPlaylist = {
    ...playlist,
    assets
  };
  await cachePlaylist(cacheDirectory, cachedPlaylist);

  return {
    playlist: cachedPlaylist,
    source: "cloud"
  };
}

async function loadPlaylist(
  playlistPath: string,
  cacheDirectory: string
): Promise<{ playlist: Playlist; source: "playlist" | "cache" | "cloud" | "standby" }> {
  if (cloudPlaylistUrl()) {
    try {
      return await fetchCloudPlaylist(cacheDirectory);
    } catch (error) {
      log("error", "cloud.playlist.failed", {
        message: error instanceof Error ? error.message : String(error)
      });
      try {
        const playlist = await readCachedPlaylist(cacheDirectory);
        return { playlist, source: "cache" };
      } catch (cacheError) {
        log("error", "cloud.cache.failed", {
          message: cacheError instanceof Error ? cacheError.message : String(cacheError)
        });
      }

      return {
        playlist: standbyPlaylist(),
        source: "standby"
      };
    }
  }

  return loadPlaylistWithCache(playlistPath, cacheDirectory);
}

async function readPlayerStatus(): Promise<PlayerStatus | null> {
  const statusPaths = [
    process.env.PISIGNAGE_PLAYER_STATUS_PATH,
    path.join(os.homedir(), ".local", "state", "pisignage", "player-status.json"),
    path.join(os.homedir(), ".local", "state", "pisignage-vlc", "status.json")
  ].filter((statusPath): statusPath is string => Boolean(statusPath));

  for (const statusPath of statusPaths) {
    try {
      return JSON.parse(await fs.readFile(statusPath, "utf8")) as PlayerStatus;
    } catch {
      // Try the next known status path.
    }
  }

  return null;
}

function cloudHeartbeatConfig(): CloudHeartbeatConfig | null {
  const baseUrl = process.env.PISIGNAGE_CLOUD_API_URL?.trim().replace(/\/+$/, "");
  const apiKey = process.env.PISIGNAGE_CLOUD_API_KEY?.trim();

  if (!baseUrl || !apiKey) {
    return null;
  }

  return { apiKey, baseUrl };
}

async function postCloudHeartbeat(config: CloudHeartbeatConfig, heartbeat: Heartbeat): Promise<void> {
  const url = `${config.baseUrl}/v1/devices/${encodeURIComponent(heartbeat.deviceId)}/heartbeat`;
  const response = await fetch(url, {
    body: JSON.stringify(heartbeat),
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Cloud heartbeat returned ${response.status}.`);
  }
}

function heartbeatIntervalMs(): number {
  const seconds = Number.parseInt(process.env.PISIGNAGE_HEARTBEAT_INTERVAL_SECONDS ?? "60", 10);
  if (!Number.isFinite(seconds) || seconds < 5) {
    return 60_000;
  }

  return seconds * 1_000;
}

function playlistVersionOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function loopModeEnabled(): boolean {
  return process.argv.includes("--loop") || process.env.PISIGNAGE_AGENT_LOOP === "true";
}

function installSignalHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopping = true;
      log("info", "agent.stop.requested", { signal });
    });
  }
}

async function runHeartbeatOnce(): Promise<void> {
  const root = repoRoot();
  const playlistPath =
    process.env.PISIGNAGE_PLAYLIST_PATH ?? path.join(root, "sample-content", "playlist.local.json");
  const cacheDirectory =
    process.env.PISIGNAGE_CACHE_DIR ?? path.join(root, "device-agent", "local-cache");
  const heartbeatPath =
    process.env.PISIGNAGE_HEARTBEAT_PATH ??
    path.join(root, "device-agent", "local-state", "heartbeat.json");
  const deviceId = configuredDeviceId();
  const networkOnline = process.env.PISIGNAGE_NETWORK_ONLINE === "true";

  log("info", "playlist.read.start", { playlistPath });
  const { playlist, source } = await loadPlaylist(playlistPath, cacheDirectory);
  log("info", "playlist.ready", {
    playlistId: playlist.playlistId,
    source,
    cacheDirectory
  });
  const playerStatus = await readPlayerStatus();
  const currentAssetId = playerStatus?.currentAssetId ?? null;

  const heartbeat: Heartbeat = {
    deviceId,
    timestamp: new Date().toISOString(),
    appVersion,
    currentPlaylistId: playerStatus?.playlistId ?? playlist.playlistId,
    currentAssetId,
    diskFreeBytes: await diskFreeBytes(root),
    hostname: os.hostname() || null,
    localIpAddress: localIpAddress(),
    networkOnline,
    playbackState: playerStatus?.state ?? null,
    playlistVersion: playlistVersionOrNull(playerStatus?.playlistVersion) ?? playlist.version ?? null
  };

  await writeJsonAtomic(heartbeatPath, heartbeat);
  log("info", "heartbeat.write.complete", {
    heartbeatPath,
    deviceId,
    playlistId: playlist.playlistId,
    currentAssetId: heartbeat.currentAssetId
  });

  const cloudConfig = cloudHeartbeatConfig();
  if (!cloudConfig) {
    log("info", "cloud.heartbeat.skipped", {
      reason: "not_configured"
    });
    return;
  }

  try {
    await postCloudHeartbeat(cloudConfig, heartbeat);
    log("info", "cloud.heartbeat.complete", {
      deviceId,
      playlistId: playlist.playlistId
    });
  } catch (error) {
    log("error", "cloud.heartbeat.failed", {
      deviceId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function runHeartbeatLoop(): Promise<void> {
  const intervalMs = heartbeatIntervalMs();
  log("info", "agent.loop.start", {
    intervalSeconds: intervalMs / 1_000
  });

  while (!stopping) {
    try {
      await runHeartbeatOnce();
    } catch (error) {
      log("error", "agent.loop.cycle.failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }

    if (!stopping) {
      await sleep(intervalMs);
    }
  }

  log("info", "agent.loop.stop");
}

async function main(): Promise<void> {
  installSignalHandlers();

  if (loopModeEnabled()) {
    await runHeartbeatLoop();
    return;
  }

  await runHeartbeatOnce();
}

main().catch((error: unknown) => {
  log("error", "heartbeat.write.failed", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
