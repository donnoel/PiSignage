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

type PlaylistEditAction = "move-up" | "move-down" | "remove";

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

function updatePlaylist(playlist: Playlist, action: PlaylistEditAction, assetId: string): Playlist {
  const index = playlist.assets.findIndex((asset) => asset.assetId === assetId);

  if (index === -1) {
    throw new Error("Playlist item was not found.");
  }

  const assets = [...playlist.assets];

  if (action === "remove") {
    if (assets.length <= 1) {
      throw new Error("At least one playlist item is required.");
    }

    assets.splice(index, 1);
  } else if (action === "move-up") {
    if (index === 0) {
      throw new Error("Playlist item is already first.");
    }

    [assets[index - 1], assets[index]] = [assets[index], assets[index - 1]];
  } else if (action === "move-down") {
    if (index === assets.length - 1) {
      throw new Error("Playlist item is already last.");
    }

    [assets[index], assets[index + 1]] = [assets[index + 1], assets[index]];
  }

  return {
    ...playlist,
    version: playlist.version + 1,
    updatedAt: new Date().toISOString(),
    assets
  };
}

async function publishPlaylistToPi(playlistPath: string, playlist: Playlist) {
  const config = readPiPublishConfig();

  if (!config) {
    return {
      enabled: false,
      ok: false,
      message: "Pi publish is not configured; playlist was updated locally only."
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
    await runSsh(
      config,
      `mv ${quoteRemoteShell(temporaryPlaylistPath)} ${quoteRemoteShell(remotePlaylistPath)}`
    );

    return {
      enabled: true,
      ok: true,
      message: `Published playlist to Pi at ${config.host}.`
    };
  } catch (error) {
    console.error("local playlist publish failed", error);
    return {
      enabled: true,
      ok: false,
      message: "Playlist was updated locally, but Pi publish failed. Check Pi connectivity."
    };
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string; assetId?: string };

    if (
      body.action !== "move-up" &&
      body.action !== "move-down" &&
      body.action !== "remove"
    ) {
      return NextResponse.json({ error: "Unsupported playlist action." }, { status: 400 });
    }

    if (!body.assetId) {
      return NextResponse.json({ error: "Missing playlist item." }, { status: 400 });
    }

    const playlistPath = path.join(repoRoot(), "sample-content", "playlist.local.json");
    const playlist = await readPlaylist(playlistPath);
    const nextPlaylist = updatePlaylist(playlist, body.action, body.assetId);

    await writeFileAtomic(playlistPath, `${JSON.stringify(nextPlaylist, null, 2)}\n`);
    const piPublish = await publishPlaylistToPi(playlistPath, nextPlaylist);

    return NextResponse.json({
      playlistVersion: nextPlaylist.version,
      assetCount: nextPlaylist.assets.length,
      piPublish
    });
  } catch (error) {
    console.error("local playlist edit failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Playlist edit failed." },
      { status: 500 }
    );
  }
}
