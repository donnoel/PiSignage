#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function readStatus(statusPath) {
  try {
    return JSON.parse(await readFile(statusPath, "utf8"));
  } catch {
    return null;
  }
}

async function waitFor(label, predicate, output, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${label}.\n${await output()}`);
}

async function waitForExit(child, timeoutMs = 3_000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for VLC controller to exit."));
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pisignage-playback-proof-"));
  const contentRoot = path.join(tempRoot, "content");
  const assetsRoot = path.join(contentRoot, "assets");
  const fakeBinRoot = path.join(tempRoot, "bin");
  const fakeVlcPath = path.join(tempRoot, "fake-vlc.mjs");
  const fakeDbusSendPath = path.join(fakeBinRoot, "dbus-send");
  const playbackModePath = path.join(tempRoot, "playback-mode.txt");
  const playbackPositionPath = path.join(tempRoot, "playback-position.txt");
  const assetPath = path.join(assetsRoot, "proof.mp4");
  const statusPath = path.join(tempRoot, "player-status.json");
  const output = [];

  try {
    await mkdir(assetsRoot, { recursive: true });
    await mkdir(fakeBinRoot, { recursive: true });
    await writeFile(assetPath, Buffer.alloc(16));
    await writeFile(playbackModePath, "stalled", "utf8");
    await writeFile(playbackPositionPath, "1000000", "utf8");
    await writeFile(
      path.join(contentRoot, "playlist.local.json"),
      `${JSON.stringify(
        {
          playlistId: "playlist-playback-proof-smoke",
          name: "Playback proof smoke",
          updatedAt: new Date().toISOString(),
          version: 1,
          assets: [
            {
              assetId: "asset-proof",
              durationSeconds: 30,
              type: "video",
              uri: "assets/proof.mp4"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      fakeVlcPath,
      `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      { encoding: "utf8", mode: 0o755 }
    );
    await writeFile(
      fakeDbusSendPath,
      `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.some((arg) => arg.includes("org.mpris.MediaPlayer2.vlc.instance"))) {
  process.exit(1);
}
const property = String(process.argv.at(-1) ?? "").replace(/^string:/, "");
if (property === "Metadata") {
  console.log(${JSON.stringify(`method return
   variant array [
      dict entry(
         string "xesam:url"
         variant string "file://${assetPath}"
      )
   ]`)});
} else if (property === "PlaybackStatus") {
  console.log('method return\\n   variant string "Playing"');
} else if (property === "Position") {
  const mode = fs.readFileSync(${JSON.stringify(playbackModePath)}, "utf8").trim();
  let position = Number.parseInt(fs.readFileSync(${JSON.stringify(playbackPositionPath)}, "utf8"), 10);
  if (mode === "advancing") {
    position += 500000;
    fs.writeFileSync(${JSON.stringify(playbackPositionPath)}, String(position));
  }
  console.log("method return\\n   variant int64 " + position);
} else {
  process.exit(1);
}
`,
      { encoding: "utf8", mode: 0o755 }
    );

    const child = spawn("node", ["device/pi/bin/pisignage-vlc-playlist.mjs"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBinRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        PISIGNAGE_CONTENT_ROOT: contentRoot,
        PISIGNAGE_PLAYBACK_PROOF_MAX_AGE_MS: "200",
        PISIGNAGE_PLAYLIST_FILE: "playlist.local.json",
        PISIGNAGE_PLAYLIST_POLL_INTERVAL_MS: "100",
        PISIGNAGE_STARTUP_SETTLE_MS: "0",
        PISIGNAGE_STATUS_HEARTBEAT_INTERVAL_MS: "50",
        PISIGNAGE_STATUS_PATH: statusPath,
        PISIGNAGE_VLC_BIN: fakeVlcPath,
        PISIGNAGE_VLC_PLAYBACK_MODE: "continuous",
        PISIGNAGE_VLC_STOP_SIGNAL: "SIGTERM"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    const renderedOutput = () => output.join("");

    await waitFor(
      "fresh stalled status to remain unconfirmed",
      async () => {
        const status = await readStatus(statusPath);
        return status?.state === "checking" && status?.playbackProof !== "advancing";
      },
      async () => `${renderedOutput()}\nStatus: ${JSON.stringify(await readStatus(statusPath))}`
    );

    await writeFile(playbackModePath, "advancing", "utf8");
    await waitFor(
      "advancing MPRIS position proof",
      async () => {
        const status = await readStatus(statusPath);
        return (
          status?.state === "playing" &&
          status?.playbackProof === "advancing" &&
          status?.currentAssetId === "asset-proof"
        );
      },
      async () => `${renderedOutput()}\nStatus: ${JSON.stringify(await readStatus(statusPath))}`
    );

    const confirmedStatus = await readStatus(statusPath);
    await writeFile(playbackModePath, "stalled", "utf8");
    await waitFor(
      "stalled MPRIS position to revoke playing",
      async () => {
        const status = await readStatus(statusPath);
        return (
          status?.state === "checking" &&
          status?.playbackProof === "stalled" &&
          Date.parse(status.updatedAt) > Date.parse(confirmedStatus.updatedAt)
        );
      },
      async () => `${renderedOutput()}\nStatus: ${JSON.stringify(await readStatus(statusPath))}`
    );

    child.kill("SIGTERM");
    const exit = await waitForExit(child);
    if (exit.code !== 0 && exit.signal !== "SIGTERM") {
      throw new Error(`VLC controller exited unexpectedly: ${JSON.stringify(exit)}\n${renderedOutput()}`);
    }

    console.log("VLC playback proof smoke passed.");
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

await main();
