import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(path.join(tmpdir(), "pisignage-failure-"));
const malformedPlaylistPath = path.join(tempRoot, "malformed-playlist.json");
const staleHeartbeatPath = path.join(tempRoot, "stale-heartbeat.json");

function runAgent(env = {}) {
  return spawnSync("npm", ["run", "agent:heartbeat"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env
    },
    encoding: "utf8"
  });
}

function requireSuccess(label, result) {
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function requireOutput(label, result, expectedText) {
  const output = `${result.stdout}\n${result.stderr}`;

  if (!output.includes(expectedText)) {
    throw new Error(`${label} did not include expected output: ${expectedText}`);
  }
}

console.log("Seeding last-known-good playlist cache...");
requireSuccess("seed cache", runAgent());

console.log("Checking missing playlist fallback...");
const missingPlaylistResult = runAgent({
  PISIGNAGE_PLAYLIST_PATH: path.join(tempRoot, "missing-playlist.json")
});
requireSuccess("missing playlist fallback", missingPlaylistResult);
requireOutput("missing playlist fallback", missingPlaylistResult, '"source":"cache"');

console.log("Checking malformed playlist fallback...");
await writeFile(malformedPlaylistPath, '{ "playlistId": 123 }\n', "utf8");
const malformedPlaylistResult = runAgent({
  PISIGNAGE_PLAYLIST_PATH: malformedPlaylistPath
});
requireSuccess("malformed playlist fallback", malformedPlaylistResult);
requireOutput("malformed playlist fallback", malformedPlaylistResult, '"source":"cache"');

console.log("Checking sample playlist asset references...");
const playlistPath = path.join(repoRoot, "sample-content", "playlist.local.json");
const playlist = JSON.parse(await readFile(playlistPath, "utf8"));
const missingAssets = playlist.assets
  .map((asset) => path.join(path.dirname(playlistPath), asset.uri))
  .filter((assetPath) => !existsSync(assetPath));

if (missingAssets.length > 0) {
  throw new Error(`Missing sample assets:\n${missingAssets.join("\n")}`);
}

console.log("Writing temporary stale heartbeat fixture...");
const staleHeartbeat = {
  deviceId: "device-local-demo",
  timestamp: "2026-01-01T00:00:00.000Z",
  appVersion: "0.1.0",
  currentPlaylistId: "playlist-local-demo",
  currentAssetId: "asset-welcome",
  diskFreeBytes: 1234567890,
  networkOnline: false
};
await writeFile(staleHeartbeatPath, `${JSON.stringify(staleHeartbeat, null, 2)}\n`, "utf8");

console.log("Local failure smoke checks passed.");
console.log(`Temporary fixtures: ${tempRoot}`);
