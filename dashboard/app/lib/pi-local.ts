import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Playlist } from "./local-playlist";
import type { PiPublishResult } from "./local-playlist";

export type PiConfig = {
  host: string;
  user: string;
  root: string;
  password?: string;
};

type CommandOptions = {
  timeoutMs?: number;
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

  if (!host) {
    return null;
  }

  return {
    host,
    user: process.env.PISIGNAGE_PI_USER?.trim() || "donnoel",
    root: process.env.PISIGNAGE_PI_ROOT?.trim() || "/home/donnoel/PiSignage",
    password: process.env.PISIGNAGE_PI_PASSWORD
  };
}

export function quoteRemoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
    const normalizedUri = path.posix.normalize(asset.uri);
    if (
      path.posix.isAbsolute(normalizedUri) ||
      normalizedUri === ".." ||
      normalizedUri.startsWith("../")
    ) {
      throw new Error(`Playlist asset path is not local: ${asset.assetId}`);
    }

    return path.posix.join(config.root, "sample-content", normalizedUri);
  });
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

  const remotePlaylistPath = path.posix.join(config.root, "sample-content", "playlist.local.json");
  const temporaryPlaylistPath = `${remotePlaylistPath}.${Date.now()}.tmp`;

  try {
    await runSsh(
      config,
      requiredRemoteAssetPaths(config, playlist)
        .map((assetPath) => `test -f ${quoteRemoteShell(assetPath)}`)
        .join(" && ")
    );
    await runScp(config, playlistPath, temporaryPlaylistPath);
    await runSsh(
      config,
      `mv ${quoteRemoteShell(temporaryPlaylistPath)} ${quoteRemoteShell(remotePlaylistPath)}`
    );

    return {
      enabled: true,
      ok: true,
      message: messages.success ?? `Published playlist to Pi at ${config.host}.`
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
  messages: { notConfigured: string; failure: string; success?: string }
): Promise<PiPublishResult> {
  const config = readPiConfig();

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
