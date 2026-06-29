#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

function playlist(version, assets) {
  return {
    playlistId: "playlist-continuous-smoke",
    name: "Continuous handoff smoke",
    updatedAt: new Date().toISOString(),
    version,
    assets: assets.map((asset) => ({
      assetId: asset.id,
      durationSeconds: 1,
      type: "video",
      uri: `assets/${asset.file}`
    }))
  };
}

async function writePlaylist(contentRoot, value) {
  await writeFile(path.join(contentRoot, "playlist.local.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function waitFor(label, output, predicate, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(output())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${label}.\nOutput:\n${output()}`);
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

function startCount(output, fileName) {
  return output.split("\n").filter((line) => line.includes(`fake-vlc:start:`) && line.includes(fileName)).length;
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pisignage-vlc-continuous-"));
  const contentRoot = path.join(tempRoot, "content");
  const assetsRoot = path.join(contentRoot, "assets");
  const fakeVlcPath = path.join(tempRoot, "fake-vlc.mjs");
  const statusPath = path.join(tempRoot, "player-status.json");
  const output = [];

  try {
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(path.join(assetsRoot, "first.mp4"), Buffer.alloc(16));
    await writeFile(path.join(assetsRoot, "second.mp4"), Buffer.alloc(16));
    await writeFile(path.join(assetsRoot, "new.mp4"), Buffer.alloc(16));
    await writePlaylist(
      contentRoot,
      playlist(1, [
        { id: "asset-first", file: "first.mp4" },
        { id: "asset-second", file: "second.mp4" }
      ])
    );
    await writeFile(
      fakeVlcPath,
      `#!/usr/bin/env node
const assets = process.argv.slice(2).filter((arg) => arg.endsWith(".mp4"));
console.log("fake-vlc:start:" + assets.join(","));
process.on("SIGTERM", () => {
  console.log("fake-vlc:stop:" + assets.join(","));
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      { encoding: "utf8", mode: 0o755 }
    );

    const child = spawn("node", ["device/pi/bin/pisignage-vlc-playlist.mjs"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PISIGNAGE_CONTENT_ROOT: contentRoot,
        PISIGNAGE_PLAYLIST_FILE: "playlist.local.json",
        PISIGNAGE_PLAYLIST_HANDOFF_OVERLAP_MS: "200",
        PISIGNAGE_PLAYLIST_POLL_INTERVAL_MS: "100",
        PISIGNAGE_STARTUP_SETTLE_MS: "0",
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
    await waitFor("initial continuous VLC playlist", renderedOutput, (text) =>
      text.includes("first.mp4") && text.includes("second.mp4")
    );
    await writePlaylist(contentRoot, playlist(2, [{ id: "asset-new", file: "new.mp4" }]));
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (renderedOutput().includes("new.mp4")) {
      throw new Error(`New playlist started before the old playlist boundary.\nOutput:\n${renderedOutput()}`);
    }

    await waitFor("new continuous VLC playlist at boundary", renderedOutput, (text) => text.includes("new.mp4"));
    await waitFor("old VLC process stopped after overlap", renderedOutput, (text) =>
      text.includes("fake-vlc:stop:") && text.includes("first.mp4") && text.includes("second.mp4")
    );

    const finalOutput = renderedOutput();
    if (startCount(finalOutput, "first.mp4") !== 1 || startCount(finalOutput, "new.mp4") !== 1) {
      throw new Error(`Expected one old playlist start and one new playlist start.\nOutput:\n${finalOutput}`);
    }

    child.kill("SIGTERM");
    await waitForExit(child);

    const status = JSON.parse(await readFile(statusPath, "utf8"));
    if (status.playlistVersion !== 2 || status.playlistId !== "playlist-continuous-smoke") {
      throw new Error(`Expected status to reflect the new playlist after continuous handoff: ${JSON.stringify(status)}`);
    }

    console.log("VLC continuous handoff smoke passed.");
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

await main();
