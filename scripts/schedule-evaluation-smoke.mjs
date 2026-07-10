import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(path.join(tmpdir(), "pisignage-schedule-"));
const schedulePath = path.join(tempRoot, "schedules.local.json");
const statusPath = path.join(tempRoot, "schedule-status.json");

const scheduleStore = {
  items: [
    {
      id: "schedule-business-hours",
      name: "Business hours",
      rules: [
        {
          daysOfWeek: [1, 2, 3, 4, 5],
          endTime: "17:00",
          startTime: "07:00"
        }
      ],
      screenIds: ["screen-primary"],
      timezone: "America/Los_Angeles",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ],
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1
};

await writeFile(schedulePath, `${JSON.stringify(scheduleStore, null, 2)}\n`, "utf8");

function runCase(label, now, screenId, expectedState) {
  const result = spawnSync(
    "node",
    ["device/pi/bin/pisignage-enforce-schedule.mjs", "--dry-run", `--now=${now}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PISIGNAGE_SCHEDULE_PATH: schedulePath,
        PISIGNAGE_SCHEDULE_STATUS_PATH: statusPath,
        PISIGNAGE_SCREEN_ID: screenId
      }
    }
  );

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

async function requireState(label, expectedState, expectedAction = null) {
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  if (status.state !== expectedState) {
    throw new Error(`${label} expected ${expectedState}, got ${status.state}`);
  }
  if (expectedAction && status.action !== expectedAction) {
    throw new Error(`${label} expected action ${expectedAction}, got ${status.action}`);
  }
  console.log(`${label}: ${status.state}`);
}

runCase("weekday active window", "2026-06-01T21:00:00.000Z", "screen-primary", "on");
await requireState("weekday active window", "on", "would-start");

runCase("weekday after hours", "2026-06-02T01:00:00.000Z", "screen-primary", "off");
await requireState("weekday after hours", "off", "would-stop");

runCase("weekend closed", "2026-06-07T17:00:00.000Z", "screen-primary", "off");
await requireState("weekend closed", "off", "would-stop");

runCase("unassigned screen", "2026-06-01T21:00:00.000Z", "screen-secondary", "unassigned");
await requireState("unassigned screen", "unassigned", "would-start");

console.log("Schedule evaluation smoke checks passed.");
console.log(`Temporary fixtures: ${tempRoot}`);
