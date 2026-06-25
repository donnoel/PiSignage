import { access, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dashboardUrl = new URL(process.env.PISIGNAGE_DASHBOARD_URL ?? "http://localhost:3000");
const args = new Set(process.argv.slice(2));
const runServiceRestart = args.has("--service-restart");
const runRecover = args.has("--recover");

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(filePath) {
  if (!(await fileExists(filePath))) {
    return null;
  }

  return JSON.parse(await readFile(filePath, "utf8"));
}

async function fetchJson(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  const url = new URL(pathname, dashboardUrl);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    return { body, response };
  } catch (error) {
    throw new Error(
      `Could not reach ${dashboardUrl.origin}. Start the dashboard with npm run dev:dashboard before running Pi drills. ${error.message}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

function requireOk(label, result) {
  if (!result.response.ok) {
    throw new Error(`${label} failed with HTTP ${result.response.status}: ${JSON.stringify(result.body)}`);
  }
}

function summarizeDiagnostics(items) {
  if (!Array.isArray(items) || items.length === 0) {
    console.log("Diagnostics: no items returned.");
    return;
  }

  for (const item of items) {
    console.log(`${item.status.toUpperCase()}: ${item.label} - ${String(item.detail).split("\n")[0]}`);
  }
}

function printC5WirelessChecklist(pi) {
  console.log("\nC5 Ethernet/Wi-Fi validation gates:");
  console.log(`- Target: ${pi?.host ?? "not configured"}; prefer C5.local on the study network.`);
  console.log("- Wired baseline: connect Ethernet, refresh Troubleshooting, publish assigned playlist, and confirm VLC playing on the TV.");
  console.log("- Wi-Fi setup: run device/pi/bin/pisignage-configure-wifi.sh on C5 and enter the Wi-Fi secret only at the Pi/NetworkManager prompt.");
  console.log("- Wi-Fi-only: unplug Ethernet, wait for C5.local/SSH to recover, then rerun this drill and repeat publish/status checks.");
  console.log("- Wireless recovery: reboot C5 with Ethernet unplugged and confirm fullscreen VLC playback returns without dashboard action.");
  console.log("- Network loss: interrupt Wi-Fi after cached playback is visible, confirm playback continues, reconnect, then verify heartbeat/status recover.");
  console.log("- Return-to-wired: reconnect Ethernet, rerun this drill, and confirm the Network diagnostic names the active transport.");
  console.log("- Reset safety: run pisignage-reset-device.sh --dry-run only unless an operator explicitly approves --apply.");
}

async function printPublishFreshness() {
  const playlistPath = path.join(repoRoot, "dashboard", "local-state", "playlist.local.json");
  const publishPath = path.join(repoRoot, "dashboard", "local-state", "publish-status.json");
  const playlist = await readJsonIfPresent(playlistPath);
  const publish = await readJsonIfPresent(publishPath);

  if (!playlist || !publish) {
    console.log("Publish freshness: live playlist or publish status is not present yet.");
    return;
  }

  const versionFresh = publish.playlistVersion === playlist.version;
  const assetCountFresh = publish.assetCount === playlist.assets?.length;
  console.log(
    `Publish freshness: ${versionFresh && assetCountFresh ? "fresh" : "stale"} ` +
      `(playlist v${playlist.version}, publish v${publish.playlistVersion}, assets ${publish.assetCount}/${playlist.assets?.length ?? "?"}).`
  );
}

async function runPlayerAction(action) {
  const result = await fetchJson("/api/local-player/actions", {
    body: JSON.stringify({ action }),
    headers: { "content-type": "application/json" },
    method: "POST",
    timeoutMs: 90_000
  });
  requireOk(action, result);
  console.log(`${action}: ${result.body.message ?? "completed"}`);
}

console.log(`Dashboard: ${dashboardUrl.origin}`);
const troubleshooting = await fetchJson("/api/local-troubleshooting");
requireOk("Troubleshooting diagnostics", troubleshooting);

const pi = troubleshooting.body.pi;
if (pi?.configured) {
  console.log(`Pi SSH: ${pi.reachable ? "reachable" : "configured but unreachable"} (${pi.host ?? "unknown host"})`);
} else {
  console.log("Pi SSH: not configured.");
}
summarizeDiagnostics(pi?.diagnostics);
printC5WirelessChecklist(pi);

const recovery = await fetchJson("/api/local-player/actions");
requireOk("Recovery history", recovery);
console.log(`Latest recovery: ${recovery.body.latestRun?.summary ?? "none recorded"}`);
await printPublishFreshness();

if (runServiceRestart) {
  await runPlayerAction("restart-vlc");
}

if (runRecover) {
  await runPlayerAction("recover");
}

console.log("\nManual drill gates still required for release signoff:");
console.log("- Reboot: restart the Pi, then confirm boot ID changed, VLC returned active, and playback resumed.");
console.log("- Network loss: disconnect the Pi network, confirm cached playback and schedule behavior continue, then reconnect and verify heartbeat.");
console.log("- Power loss: power-cycle the Pi and display, then confirm unattended playback recovery.");
console.log("- Stale publish: force or observe a failed publish, confirm the dashboard shows stale/failed status, then retry publish.");
console.log("- Bad media upload: run npm run test:bad-upload against the live dashboard.");

if (!runServiceRestart && !runRecover) {
  console.log("\nSafe drill complete. Add --service-restart or --recover when you intend to touch the live Pi player.");
}
