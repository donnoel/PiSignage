import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const baselinePath = path.join(repoRoot, "docs", "PI_GOLDEN_MASTER_BASELINE.md");
const agentPath = path.join(repoRoot, "device-agent", "dist", "index.js");
const args = new Set(process.argv.slice(2));
const repoOnly = args.has("--repo-only");
const allowUnverified = args.has("--allow-unverified");
const help = args.has("--help") || args.has("-h");

const dashboardUrl = process.env.BEAM_DASHBOARD_URL ?? "https://8yyptjawdv.us-west-2.awsapprunner.com";
const sshUser = process.env.BEAM_PI_SSH_USER ?? "donnoel";
const sshPassword = process.env.BEAM_PI_SSH_PASSWORD ?? "";
const sshTimeoutSeconds = Number.parseInt(process.env.BEAM_PI_SSH_TIMEOUT_SECONDS ?? "12", 10);

const expectedDevices = [
  { label: "C1", deviceId: "device-c1-aws-pilot", host: "100.108.135.20" },
  { label: "C2", deviceId: "device-c2-aws-pilot", host: "100.95.194.15" },
  { label: "C3", deviceId: "device-c3-aws-pilot", host: "100.86.155.95" },
  { label: "C4", deviceId: "device-c4-aws-pilot", host: "100.85.111.13" },
  { label: "C5", deviceId: "device-c5-aws-pilot", host: "100.66.60.59" }
];

const requiredUserServices = [
  "pisignage-device-agent.service",
  "pisignage-vlc.service",
  "pisignage-schedule.timer",
  "pisignage-remote-desktop.service"
];

const expectedPlaylist = {
  assetCount: 29,
  fingerprint: "19831a243ae3a3af78fd1edfa6fa37a31ce7e4d049f385f86258bbf263bcd67f",
  playlistId: "playlist-community-vision",
  version: 32
};

const results = [];

if (help) {
  console.log(`Beam RC parity check

Usage:
  npm run check:rc-parity
  npm run check:rc-parity -- --repo-only

Environment:
  BEAM_DASHBOARD_URL              Dashboard URL for read-only inventory evidence.
  BEAM_PI_SSH_USER                SSH user for Tailscale Pi checks. Default: donnoel.
  BEAM_PI_SSH_PASSWORD            Optional password for sshpass. Not stored or printed.
  BEAM_PI_SSH_TIMEOUT_SECONDS     SSH connect timeout. Default: 12.

This command is read-only. It does not restart services, publish playlists, sync
media, install packages, or mutate AWS/Pi state.`);
  process.exit(0);
}

function addResult(surface, status, details) {
  results.push({ details, status, surface });
}

function isPass(status) {
  return status === "pass" || status === "intentional";
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readText(filePath) {
  return readFile(filePath, "utf8");
}

function parseBaselineHashes(markdown) {
  const hashes = new Map();
  const linePattern = /^([a-f0-9]{64})\s+(.+)$/gim;
  let match;
  while ((match = linePattern.exec(markdown)) !== null) {
    hashes.set(path.basename(match[2].trim()), match[1]);
    hashes.set(match[2].trim(), match[1]);
  }
  return hashes;
}

async function git(argsForGit, options = {}) {
  return execFileAsync("git", argsForGit, {
    cwd: repoRoot,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024
  });
}

async function trackedManagedFiles() {
  const { stdout } = await git([
    "ls-files",
    "device/pi/bin",
    "device/pi/systemd/user",
    "device/pi/sudoers.d",
    "device/pi/assets"
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => !path.basename(filePath).startsWith("._"))
    .sort();
}

async function localFileHashes(filePaths) {
  const hashes = new Map();
  for (const filePath of filePaths) {
    const absolutePath = path.join(repoRoot, filePath);
    const digest = sha256(await readFile(absolutePath));
    hashes.set(filePath, digest);
    hashes.set(path.basename(filePath), digest);
  }
  return hashes;
}

async function checkRepoAndBaseline() {
  const baseline = await readText(baselinePath);
  const baselineHashes = parseBaselineHashes(baseline);

  if (baseline.includes("## Golden Master Operating Model") && baseline.includes("Verify fleet parity over Tailscale")) {
    addResult("baseline operating model", "pass", "PI Golden Master baseline documents promotion, Tailscale/call-home parity, and drift handling.");
  } else {
    addResult("baseline operating model", "fail", "PI Golden Master baseline is missing the Golden Master operating model or Tailscale/call-home parity rule.");
  }

  const { stdout: branch } = await git(["branch", "--show-current"]);
  const { stdout: status } = await git(["status", "--short"]);
  if (branch.trim() === "main" && status.trim() === "") {
    addResult("repo release state", "pass", "Working tree is clean on main.");
  } else {
    addResult(
      "repo release state",
      "fail",
      `Expected clean main for an RC gate; branch=${branch.trim() || "(detached)"} dirty=${status.trim() ? "yes" : "no"}.`
    );
  }

  const { stdout: head } = await git(["rev-parse", "--short=12", "HEAD"]);
  addResult("repo commit", "pass", `HEAD ${head.trim()}`);

  const managedFiles = await trackedManagedFiles();
  const localHashes = await localFileHashes(managedFiles);
  const missingBaseline = [];
  const mismatchedBaseline = [];
  for (const filePath of managedFiles) {
    const fileName = path.basename(filePath);
    const baselineHash = baselineHashes.get(fileName);
    const localHash = localHashes.get(filePath);
    if (!baselineHash) {
      missingBaseline.push(filePath);
    } else if (baselineHash !== localHash) {
      mismatchedBaseline.push(`${filePath}: local ${localHash}, baseline ${baselineHash}`);
    }
  }

  if (missingBaseline.length === 0 && mismatchedBaseline.length === 0) {
    addResult("managed repo file hashes", "pass", `${managedFiles.length} tracked managed Pi files match hashes recorded in the baseline by file name.`);
  } else {
    addResult(
      "managed repo file hashes",
      "fail",
      [
        missingBaseline.length ? `missing baseline hashes: ${missingBaseline.join(", ")}` : null,
        mismatchedBaseline.length ? `mismatches: ${mismatchedBaseline.join("; ")}` : null
      ].filter(Boolean).join(" | ")
    );
  }

  try {
    const agentHash = sha256(await readFile(agentPath));
    const baselineAgentHash = baselineHashes.get("device-agent/dist/index.js") ?? baselineHashes.get("index.js");
    if (baselineAgentHash === agentHash) {
      addResult("compiled device-agent hash", "pass", `device-agent/dist/index.js matches baseline ${agentHash}.`);
    } else if (baselineAgentHash) {
      addResult("compiled device-agent hash", "fail", `local ${agentHash}, baseline ${baselineAgentHash}.`);
    } else {
      addResult("compiled device-agent hash", "fail", "Baseline does not record device-agent/dist/index.js hash.");
    }
  } catch (error) {
    addResult("compiled device-agent hash", "fail", `Could not read ${path.relative(repoRoot, agentPath)}: ${error.message}`);
  }

  if (
    baseline.includes(`${expectedPlaylist.playlistId}@${expectedPlaylist.version}`) &&
    baseline.includes(`${expectedPlaylist.assetCount} assets`) &&
    baseline.includes(expectedPlaylist.fingerprint)
  ) {
    addResult("baseline playlist contract", "pass", `${expectedPlaylist.playlistId}@${expectedPlaylist.version}, ${expectedPlaylist.assetCount} assets, normalized fingerprint recorded.`);
  } else {
    addResult("baseline playlist contract", "fail", "Baseline does not record the expected playlist identity/version/asset-count/fingerprint contract.");
  }

  return { baselineHashes, localHashes, managedFiles };
}

async function fetchDashboardInventory() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const url = new URL("/api/local-inventory", dashboardUrl);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) {
      addResult("dashboard inventory", "unverified", `${url.href} returned HTTP ${response.status}.`);
      return;
    }

    const devices = Array.isArray(body.devices) ? body.devices : [];
    const byId = new Map(devices.map((device) => [device.id, device]));
    const missing = expectedDevices.filter((device) => !byId.has(device.deviceId));
    if (missing.length > 0) {
      addResult("dashboard inventory", "fail", `Missing expected devices: ${missing.map((device) => device.label).join(", ")}.`);
      return;
    }

    const drift = [];
    for (const expected of expectedDevices) {
      const device = byId.get(expected.deviceId);
      if (device.playlistId && device.playlistId !== expectedPlaylist.playlistId) {
        drift.push(`${expected.label} playlistId=${device.playlistId}`);
      }
      if (device.desiredPlaylistVersion && device.desiredPlaylistVersion !== expectedPlaylist.version) {
        drift.push(`${expected.label} desiredPlaylistVersion=${device.desiredPlaylistVersion}`);
      }
      if (device.publishedPlaylistVersion && device.publishedPlaylistVersion !== expectedPlaylist.version) {
        drift.push(`${expected.label} publishedPlaylistVersion=${device.publishedPlaylistVersion}`);
      }
      if (device.resetStatus === "failed" || device.actionStatus === "failed") {
        drift.push(`${expected.label} command status reset=${device.resetStatus ?? "none"} action=${device.actionStatus ?? "none"}`);
      }
    }

    if (drift.length > 0) {
      addResult("dashboard inventory", "fail", drift.join("; "));
    } else {
      addResult("dashboard inventory", "pass", `Dashboard inventory includes C1-C5 with expected playlist/release status where reported.`);
    }
  } catch (error) {
    addResult("dashboard inventory", "unverified", `Could not read ${url.href}: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function sshCommand(host, command) {
  const target = `${sshUser}@${host}`;
  const sshOptions = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${Number.isFinite(sshTimeoutSeconds) ? sshTimeoutSeconds : 12}`
  ];
  const sshArgs = [
    ...sshOptions,
    target,
    command
  ];
  if (!sshPassword) {
    return { command: "ssh", env: process.env, args: sshArgs };
  }

  const passwordSshArgs = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${Number.isFinite(sshTimeoutSeconds) ? sshTimeoutSeconds : 12}`,
    target,
    command
  ];

  return {
    command: "sshpass",
    env: { ...process.env, SSHPASS: sshPassword },
    args: ["-e", "ssh", ...passwordSshArgs]
  };
}

function remoteProbeCommand() {
  return String.raw`set -u
REPO="/home/donnoel/PiSignage"
echo "__SECTION__ facts"
printf "hostname=%s\n" "$(hostname 2>/dev/null || true)"
printf "node=%s\n" "$(node --version 2>/dev/null || true)"
printf "npm=%s\n" "$(npm --version 2>/dev/null || true)"
printf "vlc=%s\n" "$(vlc --version 2>/dev/null | head -n 1 || true)"
printf "tailscale=%s\n" "$(tailscale version 2>/dev/null | head -n 1 || true)"
printf "tailscale_ip=%s\n" "$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
printf "git_head=%s\n" "$(cd "$REPO" 2>/dev/null && git rev-parse --short=12 HEAD 2>/dev/null || true)"
printf "git_dirty_count=%s\n" "$(cd "$REPO" 2>/dev/null && git status --short 2>/dev/null | wc -l | tr -d " " || true)"
echo "__SECTION__ services"
for unit in pisignage-device-agent.service pisignage-vlc.service pisignage-schedule.timer pisignage-remote-desktop.service; do
  printf "%s enabled=%s active=%s\n" "$unit" "$(systemctl --user is-enabled "$unit" 2>/dev/null || true)" "$(systemctl --user is-active "$unit" 2>/dev/null || true)"
done
printf "tailscaled.service enabled=%s active=%s\n" "$(systemctl is-enabled tailscaled.service 2>/dev/null || true)" "$(systemctl is-active tailscaled.service 2>/dev/null || true)"
echo "__SECTION__ hashes"
if [ -d "$REPO" ]; then
  cd "$REPO" || exit 0
  find device/pi/bin device/pi/systemd/user device/pi/sudoers.d device/pi/assets -type f ! -name "._*" -print 2>/dev/null | sort | while read -r file; do
    sha256sum "$file" 2>/dev/null
  done
  sha256sum device-agent/dist/index.js 2>/dev/null || true
fi
echo "__SECTION__ status_json"
for file in "$HOME/.local/state/pisignage/heartbeat.json" "$HOME/.local/state/pisignage/player-status.json" "$HOME/.local/state/pisignage/schedule-status.json"; do
  printf "__FILE__ %s\n" "$file"
  if [ -f "$file" ]; then
    tr "\n" " " < "$file"
    printf "\n"
  else
    printf "missing\n"
  fi
done
echo "__SECTION__ cache"
printf "asset_count=%s\n" "$(find "$HOME/.local/cache/pisignage/device-agent/assets" -type f ! -name ".*" 2>/dev/null | wc -l | tr -d " ")"
printf "playlist_files=%s\n" "$(find "$HOME/.local/cache/pisignage/device-agent/playlists" -type f 2>/dev/null | wc -l | tr -d " ")"
`;
}

async function runSshProbe(device) {
  const { args: sshArgs, command, env } = sshCommand(device.host, remoteProbeCommand());
  try {
    const { stdout } = await execFileAsync(command, sshArgs, {
      cwd: repoRoot,
      env,
      maxBuffer: 5 * 1024 * 1024,
      timeout: (Number.isFinite(sshTimeoutSeconds) ? sshTimeoutSeconds + 8 : 20) * 1000
    });
    return { ok: true, stdout };
  } catch (error) {
    const stderr = String(error.stderr ?? "").trim();
    const usefulStderr = stderr.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
    const message = usefulStderr ?? `ssh exited ${error.code ?? "unknown"}`;
    return { error: message, ok: false, stdout: error.stdout ?? "" };
  }
}

function parseKeyValueSection(stdout, sectionName) {
  const lines = stdout.split("\n");
  const values = new Map();
  let active = false;
  for (const line of lines) {
    if (line.startsWith("__SECTION__ ")) {
      active = line === `__SECTION__ ${sectionName}`;
      continue;
    }
    if (!active || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

function parseRemoteHashes(stdout) {
  const hashes = new Map();
  let active = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("__SECTION__ ")) {
      active = line === "__SECTION__ hashes";
      continue;
    }
    if (!active) {
      continue;
    }
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (match) {
      hashes.set(match[2].trim(), match[1]);
      hashes.set(path.basename(match[2].trim()), match[1]);
    }
  }
  return hashes;
}

function parseJsonFiles(stdout) {
  const files = new Map();
  let currentFile = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("__FILE__ ")) {
      currentFile = line.slice("__FILE__ ".length);
      continue;
    }
    if (currentFile) {
      if (line === "missing") {
        files.set(currentFile, null);
      } else {
        try {
          files.set(currentFile, JSON.parse(line));
        } catch {
          files.set(currentFile, undefined);
        }
      }
      currentFile = null;
    }
  }
  return files;
}

function compareRemoteDevice(device, stdout, baselineHashes, localHashes, managedFiles) {
  const facts = parseKeyValueSection(stdout, "facts");
  const remoteHashes = parseRemoteHashes(stdout);
  const jsonFiles = parseJsonFiles(stdout);
  const cache = parseKeyValueSection(stdout, "cache");
  const summary = {
    assetCount: null,
    device,
    heartbeat: null,
    identity: {
      hostname: facts.get("hostname") || "",
      tailscaleIp: facts.get("tailscale_ip") || ""
    },
    runtime: {
      node: facts.get("node") || "",
      tailscale: facts.get("tailscale") || "",
      vlc: facts.get("vlc") || ""
    },
    services: []
  };

  const hashDrift = [];
  for (const filePath of managedFiles) {
    const remoteHash = remoteHashes.get(filePath) ?? remoteHashes.get(path.basename(filePath));
    const localHash = localHashes.get(filePath);
    const baselineHash = baselineHashes.get(path.basename(filePath));
    if (!remoteHash) {
      hashDrift.push(`${filePath}: missing remote hash`);
    } else if (remoteHash !== localHash || remoteHash !== baselineHash) {
      hashDrift.push(`${filePath}: remote ${remoteHash}, local ${localHash}, baseline ${baselineHash ?? "missing"}`);
    }
  }

  const remoteAgentHash = remoteHashes.get("device-agent/dist/index.js") ?? remoteHashes.get("index.js");
  const localAgentHash = localHashes.get("device-agent/dist/index.js");
  const baselineAgentHash = baselineHashes.get("device-agent/dist/index.js") ?? baselineHashes.get("index.js");
  if (!remoteAgentHash) {
    hashDrift.push("device-agent/dist/index.js: missing remote hash");
  } else if (remoteAgentHash !== localAgentHash || remoteAgentHash !== baselineAgentHash) {
    hashDrift.push(`device-agent/dist/index.js: remote ${remoteAgentHash}, local ${localAgentHash}, baseline ${baselineAgentHash ?? "missing"}`);
  }

  if (hashDrift.length === 0) {
    addResult(`${device.label} managed hashes`, "pass", "Remote managed files match local repo and baseline hashes.");
  } else {
    addResult(`${device.label} managed hashes`, "fail", hashDrift.join("; "));
  }

  const serviceDrift = [];
  for (const unit of requiredUserServices) {
    const pattern = new RegExp(`^${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} enabled=([^ ]*) active=([^ ]*)$`, "m");
    const match = stdout.match(pattern);
    if (!match) {
      serviceDrift.push(`${unit}: unreported`);
    } else if (match[1] !== "enabled" || match[2] !== "active") {
      serviceDrift.push(`${unit}: enabled=${match[1]} active=${match[2]}`);
    } else {
      summary.services.push(`${unit}=enabled/active`);
    }
  }
  const tailscaled = stdout.match(/^tailscaled\.service enabled=([^ ]*) active=([^ ]*)$/m);
  if (!tailscaled || tailscaled[1] !== "enabled" || tailscaled[2] !== "active") {
    serviceDrift.push(`tailscaled.service: ${tailscaled ? `enabled=${tailscaled[1]} active=${tailscaled[2]}` : "unreported"}`);
  } else {
    summary.services.push("tailscaled.service=enabled/active");
  }

  if (serviceDrift.length === 0) {
    addResult(`${device.label} services`, "pass", "Required Beam/Tailscale services are enabled and active.");
  } else {
    addResult(`${device.label} services`, "fail", serviceDrift.join("; "));
  }

  const runtimeDetails = [
    `node=${facts.get("node") || "missing"}`,
    `vlc=${facts.get("vlc") || "missing"}`,
    `tailscale=${facts.get("tailscale") || "missing"}`,
    `tailscale_ip=${facts.get("tailscale_ip") || "missing"}`
  ];
  if (!facts.get("node") || !facts.get("vlc") || !facts.get("tailscale") || facts.get("tailscale_ip") !== device.host) {
    addResult(`${device.label} runtime`, "fail", runtimeDetails.join("; "));
  } else {
    addResult(`${device.label} runtime`, "pass", runtimeDetails.join("; "));
  }

  const heartbeat = jsonFiles.get("/home/donnoel/.local/state/pisignage/heartbeat.json");
  if (!heartbeat || typeof heartbeat !== "object") {
    addResult(`${device.label} heartbeat`, "fail", "Heartbeat JSON missing or invalid.");
  } else {
    summary.heartbeat = {
      currentPlaylistId: heartbeat.currentPlaylistId,
      networkOnline: heartbeat.networkOnline,
      playbackState: heartbeat.playbackState,
      playlistVersion: heartbeat.playlistVersion,
      scheduleDisplayControlOk: heartbeat.scheduleDisplayControlOk
    };
    const heartbeatDrift = [];
    if (heartbeat.deviceId && heartbeat.deviceId !== device.deviceId) {
      heartbeatDrift.push(`deviceId=${heartbeat.deviceId}`);
    }
    if (heartbeat.currentPlaylistId !== expectedPlaylist.playlistId) {
      heartbeatDrift.push(`currentPlaylistId=${heartbeat.currentPlaylistId}`);
    }
    if (heartbeat.playlistVersion !== expectedPlaylist.version) {
      heartbeatDrift.push(`playlistVersion=${heartbeat.playlistVersion}`);
    }
    if (heartbeat.playbackState !== "playing") {
      heartbeatDrift.push(`playbackState=${heartbeat.playbackState}`);
    }
    if (heartbeat.networkOnline !== true) {
      heartbeatDrift.push(`networkOnline=${heartbeat.networkOnline}`);
    }
    if (heartbeat.scheduleDisplayControlOk !== true) {
      heartbeatDrift.push(`scheduleDisplayControlOk=${heartbeat.scheduleDisplayControlOk}`);
    }
    if (heartbeatDrift.length > 0) {
      addResult(`${device.label} heartbeat`, "fail", heartbeatDrift.join("; "));
    } else {
      addResult(`${device.label} heartbeat`, "pass", `${heartbeat.currentPlaylistId}@${heartbeat.playlistVersion}, playback=${heartbeat.playbackState}, networkOnline=true.`);
    }
  }

  const assetCount = Number.parseInt(cache.get("asset_count") ?? "", 10);
  summary.assetCount = Number.isFinite(assetCount) ? assetCount : null;
  if (assetCount === expectedPlaylist.assetCount) {
    addResult(`${device.label} media cache`, "pass", `${assetCount} cached active media files.`);
  } else {
    addResult(`${device.label} media cache`, "fail", `asset_count=${Number.isFinite(assetCount) ? assetCount : "unreported"}, expected=${expectedPlaylist.assetCount}.`);
  }

  return summary;
}

function uniqueValues(records, selector) {
  return [...new Set(records.map(selector))].filter((value) => value !== "");
}

function addFleetConsistencyResults(records) {
  if (records.length !== expectedDevices.length) {
    addResult("fleet live completeness", "unverified", `Checked ${records.length}/${expectedDevices.length} devices over Tailscale SSH.`);
    return;
  }

  addResult("fleet live completeness", "pass", "Checked all C1-C5 devices over Tailscale SSH.");

  const runtimeTuples = uniqueValues(records, (record) =>
    `node=${record.runtime.node}; vlc=${record.runtime.vlc}; tailscale=${record.runtime.tailscale}`
  );
  if (runtimeTuples.length === 1) {
    addResult("fleet runtime parity", "pass", runtimeTuples[0]);
  } else {
    addResult("fleet runtime parity", "fail", records.map((record) =>
      `${record.device.label}: node=${record.runtime.node || "missing"}, vlc=${record.runtime.vlc || "missing"}, tailscale=${record.runtime.tailscale || "missing"}`
    ).join("; "));
  }

  const serviceTuples = uniqueValues(records, (record) => record.services.sort().join(","));
  if (serviceTuples.length === 1) {
    addResult("fleet service parity", "pass", "Required Beam/Tailscale service states match across C1-C5.");
  } else {
    addResult("fleet service parity", "fail", records.map((record) => `${record.device.label}: ${record.services.sort().join(",") || "missing service evidence"}`).join("; "));
  }

  const heartbeatTuples = uniqueValues(records, (record) =>
    record.heartbeat
      ? `${record.heartbeat.currentPlaylistId}@${record.heartbeat.playlistVersion}; playback=${record.heartbeat.playbackState}; network=${record.heartbeat.networkOnline}; display=${record.heartbeat.scheduleDisplayControlOk}`
      : ""
  );
  if (heartbeatTuples.length === 1) {
    addResult("fleet heartbeat parity", "pass", heartbeatTuples[0]);
  } else {
    addResult("fleet heartbeat parity", "fail", records.map((record) =>
      `${record.device.label}: ${record.heartbeat ? JSON.stringify(record.heartbeat) : "missing"}`
    ).join("; "));
  }

  const assetCounts = uniqueValues(records, (record) => String(record.assetCount ?? ""));
  if (assetCounts.length === 1 && Number.parseInt(assetCounts[0], 10) === expectedPlaylist.assetCount) {
    addResult("fleet media-cache parity", "pass", `${expectedPlaylist.assetCount} active cached media files on each Pi.`);
  } else {
    addResult("fleet media-cache parity", "fail", records.map((record) => `${record.device.label}: asset_count=${record.assetCount ?? "missing"}`).join("; "));
  }

  addResult(
    "fleet identity fields",
    "intentional",
    records.map((record) => `${record.device.label}: hostname=${record.identity.hostname || "missing"} tailscale=${record.identity.tailscaleIp || "missing"}`).join("; ")
  );
}

async function checkLiveFleet(context) {
  const records = [];
  for (const device of expectedDevices) {
    const probe = await runSshProbe(device);
    if (!probe.ok) {
      addResult(`${device.label} Tailscale SSH`, "unverified", `${device.host}: ${probe.error}`);
      continue;
    }
    addResult(`${device.label} Tailscale SSH`, "pass", `${sshUser}@${device.host} reachable read-only.`);
    const record = compareRemoteDevice(device, probe.stdout, context.baselineHashes, context.localHashes, context.managedFiles);
    if (record) {
      records.push(record);
    }
  }
  addFleetConsistencyResults(records);
}

function printReport() {
  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  const blockers = results.filter((result) => result.status === "fail" || (!allowUnverified && result.status === "unverified"));

  console.log("Beam RC parity check");
  console.log(`Scope: repo=${repoRoot}`);
  console.log(`Devices: ${expectedDevices.map((device) => `${device.label}(${device.host})`).join(", ")}`);
  console.log(`Mode: ${repoOnly ? "repo-only" : "repo + dashboard + Tailscale live"}${allowUnverified ? " (unverified allowed)" : ""}`);
  console.log("");

  for (const result of results) {
    const label = result.status.toUpperCase().padEnd(10, " ");
    console.log(`${label} ${result.surface}: ${result.details}`);
  }

  console.log("");
  console.log(`Summary: pass=${counts.pass ?? 0} fail=${counts.fail ?? 0} unverified=${counts.unverified ?? 0} intentional=${counts.intentional ?? 0}`);
  if (blockers.length > 0) {
    console.log("RC gate: BLOCKED");
  } else if (results.every((result) => isPass(result.status) || (allowUnverified && result.status === "unverified"))) {
    console.log("RC gate: PASS");
  } else {
    console.log("RC gate: REVIEW");
  }
}

try {
  const context = await checkRepoAndBaseline();
  context.localHashes.set("device-agent/dist/index.js", sha256(await readFile(agentPath)));
  if (!repoOnly) {
    await fetchDashboardInventory();
    await checkLiveFleet(context);
  }
  printReport();
  const hasFailure = results.some((result) => result.status === "fail");
  const hasBlockingUnverified = !allowUnverified && results.some((result) => result.status === "unverified");
  process.exitCode = hasFailure || hasBlockingUnverified ? 1 : 0;
} catch (error) {
  addResult("check execution", "fail", error.stack ?? error.message);
  printReport();
  process.exitCode = 1;
}
