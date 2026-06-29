#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

function playlist(version, assets) {
  return {
    playlistId: "playlist-boundary-smoke",
    name: "Boundary handoff smoke",
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

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pisignage-vlc-boundary-"));
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
const asset = process.argv[process.argv.length - 1];
console.log("fake-vlc:start:" + asset);
process.on("SIGTERM", () => {
  console.log("fake-vlc:stop:" + asset);
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
        PISIGNAGE_PLAYLIST_POLL_INTERVAL_MS: "100",
        PISIGNAGE_STARTUP_SETTLE_MS: "0",
        PISIGNAGE_STATUS_PATH: statusPath,
        PISIGNAGE_VLC_BIN: fakeVlcPath,
        PISIGNAGE_VLC_PLAYBACK_MODE: "per-asset",
        PISIGNAGE_VLC_STOP_SIGNAL: "SIGTERM"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));

    const renderedOutput = () => output.join("");
    await waitFor("first old asset to start", renderedOutput, (text) => text.includes("fake-vlc:start:"));
    await writePlaylist(contentRoot, playlist(2, [{ id: "asset-new", file: "new.mp4" }]));
    await waitFor("second old asset before handoff", renderedOutput, (text) => text.includes("asset-second"));

    const beforeNewAsset = renderedOutput();
    if (beforeNewAsset.includes("asset-new")) {
      throw new Error(`New playlist started before the old playlist completed.\nOutput:\n${beforeNewAsset}`);
    }

    await waitFor("new playlist at boundary", renderedOutput, (text) => text.includes("asset-new"));
    const finalOutput = renderedOutput();
    const secondIndex = finalOutput.indexOf("asset-second");
    const newIndex = finalOutput.indexOf("asset-new");
    if (secondIndex === -1 || newIndex === -1 || newIndex < secondIndex) {
      throw new Error(`Expected new playlist after second old asset.\nOutput:\n${finalOutput}`);
    }

    child.kill("SIGTERM");
    await waitForExit(child);

    const status = JSON.parse(await readFile(statusPath, "utf8"));
    if (status.playlistVersion !== 2 || status.currentAssetId !== "asset-new") {
      throw new Error(`Expected status to reflect the new playlist after boundary handoff: ${JSON.stringify(status)}`);
    }

    console.log("VLC boundary handoff smoke passed.");
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

await main();
