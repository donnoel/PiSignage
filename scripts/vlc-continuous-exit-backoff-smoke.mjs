#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function waitFor(label, predicate, timeoutMs = 8_000, details = () => "") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${label}.\n${details()}`);
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

async function readStatus(statusPath) {
  try {
    return JSON.parse(await readFile(statusPath, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pisignage-vlc-exit-backoff-"));
  const contentRoot = path.join(tempRoot, "content");
  const assetsRoot = path.join(contentRoot, "assets");
  const fakeVlcPath = path.join(tempRoot, "fake-vlc.mjs");
  const fakeVlcStatePath = path.join(tempRoot, "fake-vlc-state.txt");
  const statusPath = path.join(tempRoot, "player-status.json");
  const output = [];

  try {
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(path.join(assetsRoot, "first.mp4"), Buffer.alloc(16));
    await writeFile(
      path.join(contentRoot, "playlist.local.json"),
      `${JSON.stringify(
        {
          playlistId: "playlist-continuous-exit-smoke",
          name: "Continuous exit smoke",
          updatedAt: new Date().toISOString(),
          version: 1,
          assets: [
            {
              assetId: "asset-first",
              durationSeconds: 1,
              type: "video",
              uri: "assets/first.mp4"
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
import fs from "node:fs";
const statePath = ${JSON.stringify(fakeVlcStatePath)};
const assets = process.argv.slice(2).filter((arg) => arg.endsWith(".mp4"));
const previousStarts = Number.parseInt(fs.readFileSync(statePath, "utf8") || "0", 10) || 0;
fs.writeFileSync(statePath, String(previousStarts + 1));
if (previousStarts === 0) {
  console.log("fake-vlc:crash:" + assets.join(","));
  process.exit(23);
}
console.log("fake-vlc:start:" + assets.join(","));
process.on("SIGTERM", () => {
  console.log("fake-vlc:stop:" + assets.join(","));
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      { encoding: "utf8", mode: 0o755 }
    );
    await writeFile(fakeVlcStatePath, "0", "utf8");

    const child = spawn("node", ["device/pi/bin/pisignage-vlc-playlist.mjs"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PISIGNAGE_CONTENT_ROOT: contentRoot,
        PISIGNAGE_PLAYLIST_FILE: "playlist.local.json",
        PISIGNAGE_PLAYLIST_POLL_INTERVAL_MS: "100",
        PISIGNAGE_STARTUP_SETTLE_MS: "0",
        PISIGNAGE_STATUS_HEARTBEAT_INTERVAL_MS: "0",
        PISIGNAGE_STATUS_PATH: statusPath,
        PISIGNAGE_VLC_BIN: fakeVlcPath,
        PISIGNAGE_VLC_PLAYBACK_MODE: "continuous",
        PISIGNAGE_VLC_RESTART_BACKOFF_MS: "1000",
        PISIGNAGE_VLC_RESTART_BACKOFF_MAX_MS: "1000",
        PISIGNAGE_VLC_STOP_SIGNAL: "SIGTERM"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    const renderedOutput = () => output.join("");

    await waitFor(
      "first fake VLC crash",
      () => renderedOutput().includes("fake-vlc:crash:"),
      8_000,
      renderedOutput
    );
    await waitFor("degraded status after crash", async () => {
      const status = await readStatus(statusPath);
      return (
        status?.state === "degraded" &&
        status?.continuousRestartAttempt === 1 &&
        status?.restartBackoffMs === 1000 &&
        typeof status?.nextRetryAt === "string" &&
        String(status?.lastError ?? "").includes("VLC exited with code 23")
      );
    }, 8_000, renderedOutput);
    await waitFor(
      "continuous VLC restarted after backoff",
      () => renderedOutput().includes("fake-vlc:start:"),
      8_000,
      renderedOutput
    );

    const status = await readStatus(statusPath);
    if (status?.state !== "playing" || status?.playlistId !== "playlist-continuous-exit-smoke") {
      throw new Error(`Expected playing status after backoff restart: ${JSON.stringify(status)}`);
    }

    child.kill("SIGTERM");
    const exit = await waitForExit(child);
    if (exit.code !== 0 && exit.signal !== "SIGTERM") {
      throw new Error(`VLC controller exited unexpectedly: ${JSON.stringify(exit)}\n${renderedOutput()}`);
    }

    console.log("VLC continuous exit backoff smoke passed.");
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

await main();
