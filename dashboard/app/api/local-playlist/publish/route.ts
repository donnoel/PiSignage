import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

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

type PiPublishConfig = {
  host: string;
  user: string;
  root: string;
  password?: string;
};

type PiPublishResult = {
  enabled: boolean;
  ok: boolean;
  message: string;
};

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

function readPiPublishConfig(): PiPublishConfig | null {
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

function remoteLogin(config: PiPublishConfig): string {
  return `${config.user}@${config.host}`;
}

function quoteRemoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

async function runCommand(command: string, args: string[], password?: string): Promise<void> {
  if (!password) {
    await execFileAsync(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
    return;
  }

  const commandArgs = [command, ...args].map(quoteTclListValue).join(" ");
  const expectScript = `
set timeout 120
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

  await execFileAsync("expect", ["-c", expectScript], {
    timeout: 130_000,
    maxBuffer: 1024 * 1024
  });
}

async function runSsh(config: PiPublishConfig, remoteCommand: string): Promise<void> {
  await runCommand(
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
    config.password
  );
}

async function runScp(config: PiPublishConfig, sourcePath: string, targetPath: string): Promise<void> {
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
    config.password
  );
}

async function writeFileAtomic(filePath: string, value: string): Promise<void> {
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

async function readPlaylist(playlistPath: string): Promise<Playlist> {
  const playlist = JSON.parse(await fs.readFile(playlistPath, "utf8")) as Partial<Playlist>;

  if (
    typeof playlist.playlistId !== "string" ||
    typeof playlist.name !== "string" ||
    typeof playlist.version !== "number" ||
    typeof playlist.updatedAt !== "string" ||
    !Array.isArray(playlist.assets)
  ) {
    throw new Error("Local playlist is malformed.");
  }

  return playlist as Playlist;
}

async function writePublishStatus(playlist: Playlist, piPublish: PiPublishResult): Promise<void> {
  const statusPath = path.join(repoRoot(), "dashboard", "local-state", "publish-status.json");

  await writeFileAtomic(
    statusPath,
    `${JSON.stringify(
      {
        action: "publish",
        assetCount: playlist.assets.length,
        message: piPublish.message,
        ok: piPublish.ok,
        piPublishEnabled: piPublish.enabled,
        playlistVersion: playlist.version,
        timestamp: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
}

async function publishPlaylistToPi(playlistPath: string, playlist: Playlist): Promise<PiPublishResult> {
  const config = readPiPublishConfig();

  if (!config) {
    return {
      enabled: false,
      ok: false,
      message: "Pi publish is not configured; playlist stayed local."
    };
  }

  const remotePlaylistPath = path.posix.join(config.root, "sample-content", "playlist.local.json");
  const temporaryPlaylistPath = `${remotePlaylistPath}.${Date.now()}.tmp`;
  const requiredRemoteAssets = playlist.assets.map((asset) => {
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

  try {
    await runSsh(
      config,
      requiredRemoteAssets
        .map((assetPath) => `test -f ${quoteRemoteShell(assetPath)}`)
        .join(" && ")
    );
    await runScp(config, playlistPath, temporaryPlaylistPath);
    await runSsh(config, `mv ${quoteRemoteShell(temporaryPlaylistPath)} ${quoteRemoteShell(remotePlaylistPath)}`);

    return {
      enabled: true,
      ok: true,
      message: `Published playlist to Pi at ${config.host}.`
    };
  } catch (error) {
    console.error("manual playlist publish failed", error);
    return {
      enabled: true,
      ok: false,
      message: "Manual publish failed. Check Pi connectivity and required media files."
    };
  }
}

export async function POST() {
  try {
    const playlistPath = path.join(repoRoot(), "sample-content", "playlist.local.json");
    const playlist = await readPlaylist(playlistPath);
    const piPublish = await publishPlaylistToPi(playlistPath, playlist);
    await writePublishStatus(playlist, piPublish);

    return NextResponse.json({
      playlistVersion: playlist.version,
      assetCount: playlist.assets.length,
      piPublish
    });
  } catch (error) {
    console.error("manual playlist publish failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Publish failed." },
      { status: 500 }
    );
  }
}
