import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentPath = path.join(repoRoot, "device-agent", "dist", "index.js");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pisignage-agent-cache-"));
const cacheRoot = path.join(tempRoot, "cache");
const assetsRoot = path.join(cacheRoot, "assets");
const heartbeatPath = path.join(tempRoot, "heartbeat.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runNodeAgent(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agentPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PISIGNAGE_CACHE_DIR: cacheRoot,
        PISIGNAGE_CLOUD_PLAYLIST_URL: url,
        PISIGNAGE_DEVICE_ID: "device-cache-smoke",
        PISIGNAGE_HEARTBEAT_PATH: heartbeatPath
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`device-agent exited ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

await mkdir(assetsRoot, { recursive: true });
await writeFile(path.join(assetsRoot, ".keep"), "");
await rm(path.join(assetsRoot, ".keep"), { force: true });

const cachedBytes = Buffer.from("already cached asset\n");
const missingBytes = Buffer.from("new asset\n");
await writeFile(path.join(assetsRoot, "cached.signage-1080p.mp4"), cachedBytes);
await writeFile(path.join(assetsRoot, "stale.signage-1080p.mp4"), "stale asset\n");

const cachedAsset = {
  assetId: "asset-cached",
  assetUrlEndpoint: null,
  checksumSha256: sha256(cachedBytes),
  fileName: "cached.signage-1080p.mp4",
  sizeBytes: cachedBytes.byteLength,
  type: "video",
  uri: "assets/cached.signage-1080p.mp4"
};
const missingAsset = {
  assetId: "asset-missing",
  assetUrlEndpoint: null,
  checksumSha256: sha256(missingBytes),
  fileName: "missing.signage-1080p.mp4",
  sizeBytes: missingBytes.byteLength,
  type: "video",
  uri: "assets/missing.signage-1080p.mp4"
};

let signedUrlRequestCount = 0;
let assetDownloadCount = 0;
let syncResult = null;

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/playlist") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      release: {
        assetCount: 2,
        manifestChecksum: "manifest-cache-smoke",
        manifestUrl: `${baseUrl}/manifest`,
        plannedBytes: cachedBytes.byteLength + missingBytes.byteLength,
        playlistId: "playlist-cache-smoke",
        playlistName: "Cache Smoke",
        playlistVersion: 1,
        publishedAt: new Date().toISOString(),
        releaseId: "release-cache-smoke"
      }
    }));
    return;
  }
  if (requestUrl.pathname === "/manifest") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      assets: [
        { ...cachedAsset, assetUrlEndpoint: `${baseUrl}/assets/cached/url` },
        { ...missingAsset, assetUrlEndpoint: `${baseUrl}/assets/missing/url` }
      ],
      manifestChecksum: "manifest-cache-smoke",
      playlist: {
        assets: [cachedAsset, missingAsset],
        name: "Cache Smoke",
        playlistId: "playlist-cache-smoke",
        updatedAt: new Date().toISOString(),
        version: 1
      },
      releaseId: "release-cache-smoke",
      syncResultUrl: `${baseUrl}/sync-result`
    }));
    return;
  }
  if (requestUrl.pathname === "/assets/missing/url") {
    signedUrlRequestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      checksumSha256: missingAsset.checksumSha256,
      fileName: missingAsset.fileName,
      sizeBytes: missingAsset.sizeBytes,
      url: `${baseUrl}/assets/missing/download`
    }));
    return;
  }
  if (requestUrl.pathname === "/assets/cached/url") {
    signedUrlRequestCount += 1;
    response.statusCode = 500;
    response.end("cached asset should not request a signed URL");
    return;
  }
  if (requestUrl.pathname === "/assets/missing/download") {
    assetDownloadCount += 1;
    response.end(missingBytes);
    return;
  }
  if (requestUrl.pathname === "/sync-result") {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      syncResult = JSON.parse(raw);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  response.statusCode = 404;
  response.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  await runNodeAgent(`${baseUrl}/playlist`);
  const files = (await readdir(assetsRoot)).sort();
  const cachedStat = await stat(path.join(assetsRoot, "cached.signage-1080p.mp4"));
  const missing = await readFile(path.join(assetsRoot, "missing.signage-1080p.mp4"));
  const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));

  const failures = [];
  if (files.join(",") !== "cached.signage-1080p.mp4,missing.signage-1080p.mp4") {
    failures.push(`expected only current playlist files, got ${files.join(",")}`);
  }
  if (cachedStat.size !== cachedBytes.byteLength) {
    failures.push("cached matching asset was overwritten");
  }
  if (!missing.equals(missingBytes)) {
    failures.push("missing asset was not downloaded correctly");
  }
  if (signedUrlRequestCount !== 1 || assetDownloadCount !== 1) {
    failures.push(`expected one signed URL and one download, got ${signedUrlRequestCount}/${assetDownloadCount}`);
  }
  if (!syncResult || syncResult.downloadedBytes !== missingBytes.byteLength || syncResult.skippedBytes !== cachedBytes.byteLength) {
    failures.push(`unexpected sync result ${JSON.stringify(syncResult)}`);
  }
  if (heartbeat.currentPlaylistId !== "playlist-cache-smoke" || heartbeat.playlistVersion !== 1) {
    failures.push("heartbeat did not report synced playlist");
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }

  console.log("Device-agent cache sync smoke checks passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}
