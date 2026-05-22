import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
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

const defaultDurationSeconds = 30;
const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.mp4$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function sanitizeMp4FileName(fileName: string): string {
  const baseName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "-");

  if (!baseName.toLowerCase().endsWith(".mp4")) {
    throw new Error("Only .mp4 uploads are supported.");
  }

  return baseName;
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

async function runSsh(config: PiPublishConfig, remoteCommand: string): Promise<void> {
  const args = [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    ...(config.password ? [] : ["-o", "BatchMode=yes"]),
    remoteLogin(config),
    remoteCommand
  ];

  await runCommand("ssh", args, config.password);
}

async function runScp(config: PiPublishConfig, sourcePath: string, targetPath: string): Promise<void> {
  const args = [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    ...(config.password ? [] : ["-o", "BatchMode=yes"]),
    sourcePath,
    `${remoteLogin(config)}:${targetPath}`
  ];

  await runCommand("scp", args, config.password);
}

async function runCommand(command: string, args: string[], password?: string): Promise<void> {
  if (!password) {
    await execFileAsync(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
    return;
  }

  const expectScript = `
set timeout 120
set password [lindex $argv 0]
set commandArgs [lrange $argv 1 end]
spawn {*}$commandArgs
expect {
  -re "(?i)password:" { send -- "$password\\r"; exp_continue }
  -re "(?i)permission denied" { exit 13 }
  timeout { exit 124 }
  eof
}
catch wait result
exit [lindex $result 3]
`;

  await execFileAsync("expect", ["-c", expectScript, password, command, ...args], {
    timeout: 130_000,
    maxBuffer: 1024 * 1024
  });
}

async function uniqueFileName(assetsDirectory: string, fileName: string): Promise<string> {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  let candidate = fileName;
  let suffix = 1;

  while (true) {
    try {
      await fs.access(path.join(assetsDirectory, candidate));
      candidate = `${baseName}-${suffix}${extension}`;
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

async function writeFileAtomic(filePath: string, value: Buffer | string): Promise<void> {
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

function appendAsset(playlist: Playlist, savedFileName: string): Playlist {
  const baseAssetId = `asset-${slugify(savedFileName) || "video"}`;
  const existingAssetIds = new Set(playlist.assets.map((asset) => asset.assetId));
  let assetId = baseAssetId;
  let suffix = 1;

  while (existingAssetIds.has(assetId)) {
    assetId = `${baseAssetId}-${suffix}`;
    suffix += 1;
  }

  return {
    ...playlist,
    version: playlist.version + 1,
    updatedAt: new Date().toISOString(),
    assets: [
      ...playlist.assets,
      {
        assetId,
        type: "video",
        uri: `assets/${savedFileName}`,
        durationSeconds: defaultDurationSeconds,
        altText: path.basename(savedFileName, path.extname(savedFileName))
      }
    ]
  };
}

async function publishToPi(
  savedFilePath: string,
  savedFileName: string,
  playlistPath: string
): Promise<PiPublishResult> {
  const config = readPiPublishConfig();

  if (!config) {
    return {
      enabled: false,
      ok: false,
      message: "Pi publish is not configured; upload was saved locally only."
    };
  }

  const remoteAssetsDirectory = path.posix.join(config.root, "sample-content", "assets");
  const remotePlaylistPath = path.posix.join(config.root, "sample-content", "playlist.local.json");
  const temporaryPlaylistPath = `${remotePlaylistPath}.${Date.now()}.tmp`;

  try {
    await runSsh(config, `mkdir -p ${quoteRemoteShell(remoteAssetsDirectory)}`);
    await runScp(config, savedFilePath, path.posix.join(remoteAssetsDirectory, savedFileName));
    await runScp(config, playlistPath, temporaryPlaylistPath);
    await runSsh(
      config,
      `mv ${quoteRemoteShell(temporaryPlaylistPath)} ${quoteRemoteShell(remotePlaylistPath)}`
    );

    return {
      enabled: true,
      ok: true,
      message: `Published to Pi at ${config.host}.`
    };
  } catch (error) {
    console.error("local Pi publish failed", error);
    return {
      enabled: true,
      ok: false,
      message: "Upload was saved locally, but Pi publish failed. Check local Pi SSH settings."
    };
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("video");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing video file." }, { status: 400 });
    }

    const safeFileName = sanitizeMp4FileName(file.name);
    const root = repoRoot();
    const assetsDirectory = path.join(root, "sample-content", "assets");
    const playlistPath = path.join(root, "sample-content", "playlist.local.json");
    const savedFileName = await uniqueFileName(assetsDirectory, safeFileName);
    const savedFilePath = path.join(assetsDirectory, savedFileName);
    const uploadedBytes = Buffer.from(await file.arrayBuffer());
    const playlist = await readPlaylist(playlistPath);
    const nextPlaylist = appendAsset(playlist, savedFileName);

    await writeFileAtomic(savedFilePath, uploadedBytes);
    await writeFileAtomic(playlistPath, `${JSON.stringify(nextPlaylist, null, 2)}\n`);
    const piPublish = await publishToPi(savedFilePath, savedFileName, playlistPath);

    const appendedAsset = nextPlaylist.assets[nextPlaylist.assets.length - 1];
    return NextResponse.json({
      assetId: appendedAsset.assetId,
      uri: appendedAsset.uri,
      playlistVersion: nextPlaylist.version,
      piPublish
    });
  } catch (error) {
    console.error("local playlist upload failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 }
    );
  }
}
