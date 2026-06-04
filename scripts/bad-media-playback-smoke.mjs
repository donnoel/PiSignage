import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

function requireSuccess(label, result) {
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function requireOutput(label, output, expectedText) {
  if (!output.includes(expectedText)) {
    throw new Error(`${label} did not include expected output: ${expectedText}`);
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function withTempPlaybackFixture(run) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "pisignage-bad-media-"));
  const contentRoot = path.join(tempRoot, "content");
  const assetsRoot = path.join(contentRoot, "assets");
  const distRoot = path.join(tempRoot, "dist");

  try {
    await mkdir(assetsRoot, { recursive: true });
    await mkdir(path.join(distRoot, "assets"), { recursive: true });
    await writeFile(
      path.join(distRoot, "index.html"),
      '<!doctype html><title>PiSignage smoke</title><script type="module" src="/assets/player.js"></script>\n',
      "utf8"
    );
    await writeFile(path.join(distRoot, "assets", "player.js"), "console.log('player smoke');\n", "utf8");
    await writeFile(path.join(assetsRoot, "good.mp4"), Buffer.alloc(16));
    await writeFile(
      path.join(contentRoot, "playlist.local.json"),
      `${JSON.stringify(
        {
          playlistId: "playlist-smoke",
          name: "Bad media smoke",
          version: 1,
          updatedAt: new Date().toISOString(),
          assets: [
            {
              assetId: "asset-good",
              type: "video",
              uri: "assets/good.mp4",
              durationSeconds: 5
            },
            {
              assetId: "asset-missing",
              type: "video",
              uri: "assets/missing.mp4",
              durationSeconds: 5
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await run({ contentRoot, distRoot, tempRoot });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function runVlcQuarantineSmoke(contentRoot) {
  console.log("Running VLC bad-media quarantine smoke...");
  const vlcDryRun = spawnSync("node", ["device/pi/bin/pisignage-vlc-playlist.mjs", "--dry-run"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PISIGNAGE_CONTENT_ROOT: contentRoot,
      PISIGNAGE_PLAYLIST_FILE: "playlist.local.json"
    },
    encoding: "utf8"
  });

  requireSuccess("vlc dry-run", vlcDryRun);
  const output = `${vlcDryRun.stdout}\n${vlcDryRun.stderr}`;
  requireOutput("vlc quarantine", output, "quarantining asset asset-missing");
  requireOutput("vlc playable count", output, "loaded 1 media asset(s)");
  console.log("VLC smoke passed.");
}

async function runVlcUnexpectedExitSmoke(tempRoot) {
  console.log("Running VLC unexpected-exit smoke...");
  const contentRoot = path.join(tempRoot, "unexpected-exit-content");
  const assetsRoot = path.join(contentRoot, "assets");
  const fakeVlcPath = path.join(tempRoot, "fake-vlc.mjs");
  const statusPath = path.join(tempRoot, "player-status.json");

  await mkdir(assetsRoot, { recursive: true });
  await writeFile(path.join(assetsRoot, "first.mp4"), Buffer.alloc(16));
  await writeFile(path.join(assetsRoot, "second.mp4"), Buffer.alloc(16));
  await writeFile(
    path.join(contentRoot, "playlist.local.json"),
    `${JSON.stringify(
      {
        playlistId: "playlist-unexpected-exit",
        name: "Unexpected VLC exit smoke",
        version: 1,
        updatedAt: new Date().toISOString(),
        assets: [
          {
            assetId: "asset-first",
            type: "video",
            uri: "assets/first.mp4",
            durationSeconds: 5
          },
          {
            assetId: "asset-second",
            type: "video",
            uri: "assets/second.mp4",
            durationSeconds: 5
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
    "#!/usr/bin/env node\nconsole.error('fake VLC crashed');\nprocess.exit(23);\n",
    { encoding: "utf8", mode: 0o755 }
  );

  const result = spawnSync("node", ["device/pi/bin/pisignage-vlc-playlist.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PISIGNAGE_CONTENT_ROOT: contentRoot,
      PISIGNAGE_PLAYLIST_FILE: "playlist.local.json",
      PISIGNAGE_STARTUP_SETTLE_MS: "0",
      PISIGNAGE_STATUS_PATH: statusPath,
      PISIGNAGE_VLC_BIN: fakeVlcPath
    },
    encoding: "utf8"
  });
  const output = `${result.stdout}\n${result.stderr}`;

  if (result.status === 0) {
    throw new Error("VLC unexpected-exit smoke should fail after every playable asset crashes.");
  }
  requireOutput("vlc unexpected exit", output, "VLC exited with code 23");
  requireOutput("vlc crash quarantine first asset", output, "quarantining asset asset-first");
  requireOutput("vlc crash quarantine second asset", output, "quarantining asset asset-second");
  requireOutput("vlc crash exhausted playlist", output, "No playable media assets remain");

  const status = JSON.parse(await readFile(statusPath, "utf8"));
  if (status.state !== "failed") {
    throw new Error(`Expected failed player status after unexpected VLC exit, got ${status.state}`);
  }
  if ((status.quarantinedAssetIds ?? []).length !== 2) {
    throw new Error("Unexpected VLC exit should quarantine every crashing asset before failing.");
  }

  console.log("VLC unexpected-exit smoke passed.");
}

async function runBrowserMissingMediaSmoke(contentRoot, distRoot) {
  console.log("Running browser serve-player missing-media smoke...");
  const port = 51731;
  const server = spawn("node", ["device/pi/bin/pisignage-serve-player.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PISIGNAGE_PLAYER_HOST: "127.0.0.1",
      PISIGNAGE_PLAYER_PORT: String(port),
      PISIGNAGE_PLAYER_DIST: distRoot,
      PISIGNAGE_CONTENT_ROOT: contentRoot
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/`);
        if (response.ok) {
          break;
        }
      } catch {
        // wait for server boot
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const missingAssetResponse = await fetchWithTimeout(`${baseUrl}/assets/missing.mp4`);
    if (missingAssetResponse.status !== 404) {
      throw new Error(`Expected 404 for missing asset, got ${missingAssetResponse.status}`);
    }
    const missingAssetBody = await missingAssetResponse.text();
    requireOutput("missing asset message", missingAssetBody, "Asset not found: /assets/missing.mp4");

    const playerAssetResponse = await fetchWithTimeout(`${baseUrl}/assets/player.js`);
    if (playerAssetResponse.status !== 200) {
      throw new Error(`Expected 200 for player dist asset, got ${playerAssetResponse.status}`);
    }
    const playerAssetBody = await playerAssetResponse.text();
    requireOutput("player dist asset", playerAssetBody, "player smoke");

    const mediaAssetResponse = await fetchWithTimeout(`${baseUrl}/assets/good.mp4`);
    if (mediaAssetResponse.status !== 200) {
      throw new Error(`Expected 200 for media asset, got ${mediaAssetResponse.status}`);
    }

    await rm(path.join(contentRoot, "playlist.local.json"), { force: true });
    const missingPlaylistResponse = await fetchWithTimeout(`${baseUrl}/playlist.local.json`);
    if (missingPlaylistResponse.status !== 404) {
      throw new Error(`Expected 404 for missing playlist, got ${missingPlaylistResponse.status}`);
    }
    const missingPlaylistBody = await missingPlaylistResponse.text();
    requireOutput(
      "missing playlist message",
      missingPlaylistBody,
      "playlist.local.json was not found in sample-content."
    );
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      server.on("exit", () => resolve());
      setTimeout(resolve, 2000);
    });
  }

  if (server.exitCode !== null && server.exitCode !== 0 && server.exitCode !== 143) {
    throw new Error(`Serve-player process exited unexpectedly: ${server.exitCode}\n${serverOutput}`);
  }

  console.log("Browser smoke passed.");
}

await withTempPlaybackFixture(async ({ contentRoot, distRoot }) => {
  await runVlcQuarantineSmoke(contentRoot);
  await runVlcUnexpectedExitSmoke(path.dirname(contentRoot));
  await runBrowserMissingMediaSmoke(contentRoot, distRoot);
});

console.log("Bad media playback smoke passed.");
