import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type PlaylistAsset = {
  assetId: string;
  type: "image" | "video";
  uri: string;
  durationSeconds: number;
  altText?: string;
  downloadUrl?: string;
  fileName?: string;
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
  playlistVersion?: number;
  state?: string;
};

type CloudHeartbeatConfig = {
  apiKey: string;
  baseUrl: string;
};

type CloudPlaylistResponse = {
  command?: DeviceCommand | null;
  playlist?: Playlist | null;
};

type DeviceCommand = {
  id: string;
  requestedAt: string;
  status: "pending" | "running";
  statusUrl?: string;
  type: "reset-device";
};

type ResetStatus = "failed" | "running" | "succeeded";

const appVersion = "0.1.0";
const currentPlaylistFileName = "current.json";
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

function commandStatusPath(cacheDirectory: string, commandId: string): string {
  const safeCommandId = commandId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(cacheDirectory, "commands", `${safeCommandId}.json`);
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

async function cachePlaylist(cacheDirectory: string, playlist: Playlist): Promise<void> {
  await writeJsonAtomic(playlistCachePath(cacheDirectory, playlist.playlistId), playlist);
  await writeJsonAtomic(currentPlaylistCachePath(cacheDirectory), playlist);
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

async function downloadCloudAsset(cacheDirectory: string, asset: PlaylistAsset): Promise<PlaylistAsset> {
  if (!asset.downloadUrl) {
    return asset;
  }

  const fileName = assetFileName(asset);
  const response = await fetch(asset.downloadUrl);
  if (!response.ok) {
    throw new Error(`Asset ${asset.assetId} returned ${response.status}.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeBufferAtomic(path.join(cacheDirectory, "assets", fileName), bytes);

  return {
    ...asset,
    downloadUrl: undefined,
    fileName,
    uri: `assets/${fileName}`
  };
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

async function postResetStatus(
  command: DeviceCommand,
  status: ResetStatus,
  input: {
    finishedAt?: string;
    message: string;
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
      startedAt: input.startedAt,
      status
    }),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Reset status returned ${response.status}.`);
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
    "+1",
    "Beam deployment reset complete"
  ], {
    timeout: 10_000
  });
  return "reboot_requested=true reboot_delay=1m";
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
  await postResetStatus(command, "running", {
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
      ["--repo-root", root, "--source", "git-head", "--agent-safe", "--apply"],
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
    await postResetStatus(command, "succeeded", {
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
    await postResetStatus(command, "failed", {
      finishedAt,
      message,
      startedAt
    });
    throw error;
  }
}

async function fetchCloudPlaylist(cacheDirectory: string): Promise<{
  playlist: Playlist;
  source: "cloud";
}> {
  const url = cloudPlaylistUrl();
  if (!url) {
    throw new Error("Cloud playlist URL is not configured.");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Cloud playlist returned ${response.status}.`);
  }

  const body = (await response.json()) as CloudPlaylistResponse;
  if (body.command?.type === "reset-device" && body.command.status === "pending") {
    await runResetCommand(repoRoot(), cacheDirectory, body.command);
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
): Promise<{ playlist: Playlist; source: "playlist" | "cache" | "cloud" }> {
  if (cloudPlaylistUrl()) {
    try {
      return await fetchCloudPlaylist(cacheDirectory);
    } catch (error) {
      log("error", "cloud.playlist.failed", {
        message: error instanceof Error ? error.message : String(error)
      });
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
  const currentAssetId = playerStatus?.currentAssetId ?? playlist.assets[0]?.assetId ?? null;

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
    playlistVersion: playerStatus?.playlistVersion ?? playlist.version ?? null
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
