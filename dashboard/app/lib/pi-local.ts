import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Playlist } from "./local-playlist";
import type { PiPublishResult } from "./local-playlist";
import { sha256ForFile } from "./media-processing";

export type PiConfig = {
  host: string;
  user: string;
  root: string;
  cacheRoot: string;
  password?: string;
};

type CommandOptions = {
  timeoutMs?: number;
};

type AssetSyncSummary = {
  checked: number;
  copied: number;
  removed: number;
  skipped: number;
  verifiedByChecksum: number;
  verifiedBySize: number;
};

const execFileAsync = promisify(execFile);

export function describePiPublishFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Permission denied")) {
    return "Pi publish could not sign in over SSH. Check the local Pi user, password, or SSH key in dashboard/.env.local.";
  }

  if (message.includes("timed out") || message.includes("ETIMEDOUT") || message.includes("ENETUNREACH")) {
    return "Pi publish timed out on the local network. The playlist stayed saved locally; check that the Pi is awake and reachable.";
  }

  if (message.includes("No such file") || message.includes("test -f")) {
    return "Saved locally. Beam could not verify every media file on the Pi. Publish again when the Pi and media are available.";
  }

  return "Saved locally. Beam could not complete the Pi publish check. Check Pi connectivity and publish again.";
}

export function readPiConfig(): PiConfig | null {
  const host = process.env.PISIGNAGE_PI_HOST?.trim();
  const user = process.env.PISIGNAGE_PI_USER?.trim() || "donnoel";

  if (!host) {
    return null;
  }

  return {
    host,
    cacheRoot: process.env.PISIGNAGE_PI_CACHE_ROOT?.trim() || defaultPlaybackCacheRoot(user),
    root: process.env.PISIGNAGE_PI_ROOT?.trim() || "/home/donnoel/PiSignage",
    user,
    password: process.env.PISIGNAGE_PI_PASSWORD
  };
}

export function quoteRemoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function defaultPlaybackCacheRoot(user: string): string {
  return `/home/${user}/.local/cache/pisignage/device-agent`;
}

export function playbackCacheRoot(config: PiConfig): string {
  return config.cacheRoot.trim() || defaultPlaybackCacheRoot(config.user);
}

export function playbackCachePlaylistPath(config: PiConfig): string {
  return path.posix.join(playbackCacheRoot(config), "playlists", "current.json");
}

function remoteLogin(config: PiConfig): string {
  return `${config.user}@${config.host}`;
}

async function repoFilePath(relativePath: string): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(process.cwd(), "..", relativePath)
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking from the next likely workspace root.
    }
  }

  throw new Error(`Could not find required repo file: ${relativePath}`);
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

async function runCommand(
  command: string,
  args: string[],
  password: string | undefined,
  options: CommandOptions = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;

  if (!password) {
    const { stdout } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return stdout;
  }

  const commandArgs = [command, ...args].map(quoteTclListValue).join(" ");
  const expectScript = `
set timeout ${Math.ceil(timeoutMs / 1000)}
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
    timeout: timeoutMs + 5_000,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

export async function runSsh(
  config: PiConfig,
  remoteCommand: string,
  options: CommandOptions = {}
): Promise<string> {
  return runCommand(
    "ssh",
    [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
      ...(config.password ? [] : ["-o", "BatchMode=yes"]),
      remoteLogin(config),
      remoteCommand
    ],
    config.password,
    options
  );
}

export async function runScp(
  config: PiConfig,
  sourcePath: string,
  targetPath: string,
  options: CommandOptions = {}
): Promise<void> {
  await runCommand(
    "scp",
    [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
      ...(config.password ? [] : ["-o", "BatchMode=yes"]),
      sourcePath,
      `${remoteLogin(config)}:${targetPath}`
    ],
    config.password,
    options
  );
}

async function ensurePiScheduleEnforcement(config: PiConfig): Promise<void> {
  const timestamp = Date.now();
  const enforcerPath = await repoFilePath("device/pi/bin/pisignage-enforce-schedule.mjs");
  const servicePath = await repoFilePath("device/pi/systemd/user/pisignage-schedule.service");
  const timerPath = await repoFilePath("device/pi/systemd/user/pisignage-schedule.timer");
  const remoteEnforcer = `/tmp/pisignage-enforce-schedule-${timestamp}.mjs`;
  const remoteService = `/tmp/pisignage-schedule-${timestamp}.service`;
  const remoteTimer = `/tmp/pisignage-schedule-${timestamp}.timer`;

  await runSsh(
    config,
    [
      "mkdir -p \"$HOME/.local/bin\" \"$HOME/.config/systemd/user\"",
      `rm -f ${quoteRemoteShell(remoteEnforcer)} ${quoteRemoteShell(remoteService)} ${quoteRemoteShell(remoteTimer)}`
    ].join(" && ")
  );
  await runScp(config, enforcerPath, remoteEnforcer);
  await runScp(config, servicePath, remoteService);
  await runScp(config, timerPath, remoteTimer);
  await runSsh(
    config,
    [
      `install -m 755 ${quoteRemoteShell(remoteEnforcer)} "$HOME/.local/bin/pisignage-enforce-schedule.mjs"`,
      `install -m 644 ${quoteRemoteShell(remoteService)} "$HOME/.config/systemd/user/pisignage-schedule.service"`,
      `install -m 644 ${quoteRemoteShell(remoteTimer)} "$HOME/.config/systemd/user/pisignage-schedule.timer"`,
      `rm -f ${quoteRemoteShell(remoteEnforcer)} ${quoteRemoteShell(remoteService)} ${quoteRemoteShell(remoteTimer)}`,
      "systemctl --user daemon-reload",
      "systemctl --user enable --now pisignage-schedule.timer",
      "systemctl --user start pisignage-schedule.service",
      "systemctl --user is-active pisignage-schedule.timer"
    ].join(" && "),
    { timeoutMs: 120_000 }
  );
}

export function requiredRemoteAssetPaths(config: PiConfig, playlist: Playlist): string[] {
  return playlist.assets.map((asset) => {
    return path.posix.join(playbackCacheRoot(config), normalizedPlaylistAssetUri(asset));
  });
}

function normalizedPlaylistAssetUri(asset: Playlist["assets"][number]): string {
  const normalizedUri = path.posix.normalize(asset.uri);
  if (
    path.posix.isAbsolute(normalizedUri) ||
    normalizedUri === ".." ||
    normalizedUri.startsWith("../")
  ) {
    throw new Error(`Playlist asset path is not local: ${asset.assetId}`);
  }

  return normalizedUri;
}

async function remoteFileSize(config: PiConfig, remotePath: string): Promise<number | null> {
  try {
    const output = await runSsh(config, `stat -c %s ${quoteRemoteShell(remotePath)}`, { timeoutMs: 20_000 });
    const parsed = Number.parseInt(output.match(/\b\d+\b/g)?.at(-1) ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function remoteFileSha256(config: PiConfig, remotePath: string): Promise<string | null> {
  try {
    const quotedPath = quoteRemoteShell(remotePath);
    const output = await runSsh(
      config,
      [
        "if command -v sha256sum >/dev/null 2>&1; then",
        `sha256sum ${quotedPath} | awk '{print $1}';`,
        "elif command -v shasum >/dev/null 2>&1; then",
        `shasum -a 256 ${quotedPath} | awk '{print $1}';`,
        "else exit 127; fi"
      ].join(" "),
      { timeoutMs: 30_000 }
    );
    const digest = output.match(/\b[a-f0-9]{64}\b/i)?.[0] ?? "";
    return /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function assertRemoteAssetMatches(
  config: PiConfig,
  remoteAssetPath: string,
  localHash: string,
  localSize: number
): Promise<"checksum" | "size"> {
  const remoteHash = await remoteFileSha256(config, remoteAssetPath);
  if (remoteHash) {
    if (remoteHash !== localHash) {
      throw new Error(`Published media checksum did not match on Pi: ${path.posix.basename(remoteAssetPath)}`);
    }

    return "checksum";
  }

  const remoteSize = await remoteFileSize(config, remoteAssetPath);
  if (remoteSize !== localSize) {
    throw new Error(`Published media size did not match on Pi: ${path.posix.basename(remoteAssetPath)}`);
  }

  return "size";
}

function assetSyncMessage(summary: AssetSyncSummary): string {
  const verification =
    summary.verifiedByChecksum > 0
      ? `${summary.verifiedByChecksum} hash-verified`
      : `${summary.verifiedBySize} size-verified`;
  return ` Playback cache assets checked: ${summary.checked}; copied ${summary.copied}, skipped ${summary.skipped}, removed ${summary.removed} stale; ${verification}.`;
}

async function pruneStaleRemoteAssets(config: PiConfig, playlist: Playlist): Promise<number> {
  const remoteAssetDirectory = path.posix.join(playbackCacheRoot(config), "assets");
  const expectedAssetPaths = playlist.assets.map((asset) =>
    path.posix.join(playbackCacheRoot(config), normalizedPlaylistAssetUri(asset))
  );
  const pruneScript = `
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const assetDirectory = ${JSON.stringify(remoteAssetDirectory)};
const expectedAssetPaths = new Set(${JSON.stringify(expectedAssetPaths)});
let removed = 0;

fs.mkdirSync(assetDirectory, { recursive: true });
for (const entry of fs.readdirSync(assetDirectory, { withFileTypes: true })) {
  if (!entry.isFile()) {
    continue;
  }

  const assetPath = path.join(assetDirectory, entry.name);
  if (!expectedAssetPaths.has(assetPath)) {
    fs.rmSync(assetPath, { force: true });
    removed += 1;
  }
}

console.log(JSON.stringify({ removed }));
NODE
`;
  const output = await runSsh(config, pruneScript, { timeoutMs: 60_000 });
  const parsed = output.match(/"removed"\s*:\s*(\d+)/);
  return parsed ? Number.parseInt(parsed[1], 10) : 0;
}

async function syncPlaylistAssetsToPi(config: PiConfig, playlist: Playlist): Promise<AssetSyncSummary> {
  const summary: AssetSyncSummary = {
    checked: 0,
    copied: 0,
    removed: 0,
    skipped: 0,
    verifiedByChecksum: 0,
    verifiedBySize: 0
  };

  for (const asset of playlist.assets) {
    const normalizedUri = normalizedPlaylistAssetUri(asset);
    const localAssetPath = await repoFilePath(path.join("sample-content", normalizedUri));
    const localAsset = await stat(localAssetPath);
    const localHash = await sha256ForFile(localAssetPath);
    const remoteAssetPath = path.posix.join(playbackCacheRoot(config), normalizedUri);
    const remoteHash = await remoteFileSha256(config, remoteAssetPath);
    summary.checked += 1;

    if (remoteHash === localHash) {
      summary.skipped += 1;
      summary.verifiedByChecksum += 1;
      continue;
    }

    if (!remoteHash) {
      const remoteSize = await remoteFileSize(config, remoteAssetPath);
      if (remoteSize === localAsset.size) {
        summary.skipped += 1;
        summary.verifiedBySize += 1;
        continue;
      }
    }

    const temporaryAssetPath = `${remoteAssetPath}.${Date.now()}.tmp`;
    await runSsh(config, `mkdir -p ${quoteRemoteShell(path.posix.dirname(remoteAssetPath))}`);
    await runScp(config, localAssetPath, temporaryAssetPath, { timeoutMs: 600_000 });
    await runSsh(
      config,
      `mv ${quoteRemoteShell(temporaryAssetPath)} ${quoteRemoteShell(remoteAssetPath)}`,
      { timeoutMs: 60_000 }
    );
    const verification = await assertRemoteAssetMatches(config, remoteAssetPath, localHash, localAsset.size);
    summary.copied += 1;
    if (verification === "checksum") {
      summary.verifiedByChecksum += 1;
    } else {
      summary.verifiedBySize += 1;
    }
  }

  summary.removed = await pruneStaleRemoteAssets(config, playlist);
  return summary;
}

export async function publishPlaylistToPi(
  playlistPath: string,
  playlist: Playlist,
  messages: { notConfigured: string; failure: string; success?: string },
  targetConfig?: PiConfig | null
): Promise<PiPublishResult> {
  const config = targetConfig === undefined ? readPiConfig() : targetConfig;

  if (!config) {
    return {
      enabled: false,
      ok: false,
      message: messages.notConfigured
    };
  }

  const remotePlaylistPath = playbackCachePlaylistPath(config);
  const remotePlaylistByIdPath = path.posix.join(playbackCacheRoot(config), "playlists", `${playlist.playlistId}.json`);
  const temporaryPlaylistPath = `${remotePlaylistPath}.${Date.now()}.tmp`;
  const temporaryPlaylistByIdPath = `${remotePlaylistByIdPath}.${Date.now()}.tmp`;

  try {
    const assetSync = await syncPlaylistAssetsToPi(config, playlist);
    await runSsh(
      config,
      requiredRemoteAssetPaths(config, playlist)
        .map((assetPath) => `test -f ${quoteRemoteShell(assetPath)}`)
        .join(" && ")
    );
    await runSsh(config, `mkdir -p ${quoteRemoteShell(path.posix.dirname(remotePlaylistPath))}`);
    await runScp(config, playlistPath, temporaryPlaylistByIdPath);
    await runSsh(
      config,
      `mv ${quoteRemoteShell(temporaryPlaylistByIdPath)} ${quoteRemoteShell(remotePlaylistByIdPath)}`
    );
    await runScp(config, playlistPath, temporaryPlaylistPath);
    await runSsh(
      config,
      `mv ${quoteRemoteShell(temporaryPlaylistPath)} ${quoteRemoteShell(remotePlaylistPath)}`
    );

    return {
      assetsChecked: assetSync.checked,
      assetsCopied: assetSync.copied,
      assetsRemoved: assetSync.removed,
      assetsSkipped: assetSync.skipped,
      assetsVerifiedByChecksum: assetSync.verifiedByChecksum,
      assetsVerifiedBySize: assetSync.verifiedBySize,
      enabled: true,
      ok: true,
      message: `${messages.success ?? `Published playlist to Pi playback cache at ${config.host}.`}${assetSyncMessage(assetSync)}`
    };
  } catch (error) {
    console.error("local playlist publish failed", error);
    return {
      enabled: true,
      ok: false,
      message: `${messages.failure} ${describePiPublishFailure(error)}`
    };
  }
}

export async function publishScheduleStoreToPi(
  schedulePath: string,
  messages: { notConfigured: string; failure: string; success?: string },
  targetConfig?: PiConfig
): Promise<PiPublishResult> {
  const config = targetConfig ?? readPiConfig();

  if (!config) {
    return {
      enabled: false,
      ok: false,
      message: messages.notConfigured
    };
  }

  const remoteSchedulePath = path.posix.join(config.root, "sample-content", "schedules.local.json");
  const temporarySchedulePath = `${remoteSchedulePath}.${Date.now()}.tmp`;

  try {
    await runScp(config, schedulePath, temporarySchedulePath);
    await runSsh(
      config,
      `mv ${quoteRemoteShell(temporarySchedulePath)} ${quoteRemoteShell(remoteSchedulePath)}`
    );
    await ensurePiScheduleEnforcement(config);

    return {
      enabled: true,
      ok: true,
      message:
        messages.success ??
        `Published schedules and enabled schedule enforcement on Pi at ${config.host}.`
    };
  } catch (error) {
    console.error("local schedule publish failed", error);
    return {
      enabled: true,
      ok: false,
      message: `${messages.failure} ${describePiPublishFailure(error)}`
    };
  }
}
