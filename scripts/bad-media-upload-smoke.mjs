import { access, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dashboardUrl = new URL(process.env.PISIGNAGE_DASHBOARD_URL ?? "http://localhost:3000");
const filesToProtect = [
  path.join(repoRoot, "dashboard", "local-state", "playlist.local.json"),
  path.join(repoRoot, "dashboard", "local-state", "playlists.local.json"),
  path.join(repoRoot, "dashboard", "local-state", "media.local.json")
];

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readProtectedFiles() {
  const entries = [];
  for (const filePath of filesToProtect) {
    if (await fileExists(filePath)) {
      entries.push([filePath, await readFile(filePath, "utf8")]);
    }
  }
  return new Map(entries);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function invalidUploadForm() {
  const form = new FormData();
  form.append("media", new Blob(["this is not signage media"], { type: "text/plain" }), "bad-media.txt");
  form.append("title", "Bad media should be rejected");
  form.append("description", "Release hardening invalid upload smoke.");
  form.append("tags", "release-hardening,bad-upload");
  return form;
}

async function postInvalidUpload(endpoint) {
  const url = new URL(endpoint, dashboardUrl);
  let response;
  try {
    response = await fetchWithTimeout(url, {
      body: invalidUploadForm(),
      method: "POST"
    });
  } catch (error) {
    throw new Error(
      `Could not reach ${dashboardUrl.origin}. Start the dashboard with npm run dev:dashboard before running this smoke. ${error.message}`
    );
  }

  const body = await response.json().catch(() => ({}));
  if (response.status !== 400) {
    throw new Error(`${endpoint} expected HTTP 400 for invalid media, got ${response.status}: ${JSON.stringify(body)}`);
  }

  if (typeof body.error !== "string" || !body.error.includes("Accepted media formats")) {
    throw new Error(`${endpoint} returned an unexpected rejection message: ${JSON.stringify(body)}`);
  }

  console.log(`${endpoint}: rejected invalid media with HTTP 400.`);
}

const before = await readProtectedFiles();
await postInvalidUpload("/api/media");
const after = await readProtectedFiles();

for (const [filePath, contents] of before) {
  if (after.get(filePath) !== contents) {
    throw new Error(`Invalid upload changed ${path.relative(repoRoot, filePath)}.`);
  }
}

console.log("Bad media upload smoke passed without changing playlist or media state.");
