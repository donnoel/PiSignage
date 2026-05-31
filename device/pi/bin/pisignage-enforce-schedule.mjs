#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.env.PISIGNAGE_REPO_ROOT ?? process.cwd();
const contentRoot = path.resolve(
  repoRoot,
  process.env.PISIGNAGE_CONTENT_ROOT ?? "sample-content"
);
const schedulePath = path.resolve(
  process.env.PISIGNAGE_SCHEDULE_PATH ??
    path.join(contentRoot, process.env.PISIGNAGE_SCHEDULE_FILE ?? "schedules.local.json")
);
const statusPath = path.resolve(
  process.env.PISIGNAGE_SCHEDULE_STATUS_PATH ??
    path.join(process.env.HOME ?? repoRoot, ".local/state/pisignage/schedule-status.json")
);
const screenId = process.env.PISIGNAGE_SCREEN_ID ?? "screen-primary";
const vlcService = process.env.PISIGNAGE_VLC_SERVICE ?? "pisignage-vlc.service";
const displayOutput = process.env.PISIGNAGE_DISPLAY_OUTPUT ?? "HDMI-A-1";
const displayMode = process.env.PISIGNAGE_DISPLAY_RESOLUTION ?? "1920x1080@60.000000";
const dryRun = process.argv.includes("--dry-run");
const nowArg = process.argv.find((argument) => argument.startsWith("--now="));
const now = nowArg ? new Date(nowArg.slice("--now=".length)) : new Date();

const weekdayNumbers = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6]
]);

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function fail(message) {
  console.error(`${new Date().toISOString()} ${message}`);
  process.exitCode = 1;
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function minutesFromTime(value) {
  if (!isValidTime(value)) {
    throw new Error(`Invalid schedule time: ${value}`);
  }

  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return hour * 60 + minute;
}

function zonedNow(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
    weekday: "short"
  }).formatToParts(date);
  const valueFor = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const dayOfWeek = weekdayNumbers.get(valueFor("weekday"));

  if (typeof dayOfWeek !== "number") {
    throw new Error(`Could not resolve weekday for ${timeZone}`);
  }

  return {
    dayOfWeek,
    hour: Number.parseInt(valueFor("hour"), 10),
    minute: Number.parseInt(valueFor("minute"), 10)
  };
}

function scheduleIsActive(schedule, date) {
  const local = zonedNow(date, schedule.timezone);
  const currentMinutes = local.hour * 60 + local.minute;
  const previousDay = (local.dayOfWeek + 6) % 7;
  const rules = Array.isArray(schedule.rules) ? schedule.rules : [];

  return rules.some((rule) => {
    const daysOfWeek = Array.isArray(rule.daysOfWeek) ? rule.daysOfWeek : [];
    const startMinutes = minutesFromTime(rule.startTime);
    const endMinutes = minutesFromTime(rule.endTime);

    if (startMinutes === endMinutes) {
      return daysOfWeek.includes(local.dayOfWeek);
    }

    if (startMinutes < endMinutes) {
      return (
        daysOfWeek.includes(local.dayOfWeek) &&
        currentMinutes >= startMinutes &&
        currentMinutes < endMinutes
      );
    }

    return (
      (daysOfWeek.includes(local.dayOfWeek) && currentMinutes >= startMinutes) ||
      (daysOfWeek.includes(previousDay) && currentMinutes < endMinutes)
    );
  });
}

async function writeStatus(update) {
  const status = {
    screenId,
    schedulePath,
    service: vlcService,
    updatedAt: new Date().toISOString(),
    ...update
  };
  const statusDirectory = path.dirname(statusPath);
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  await mkdir(statusDirectory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statusPath);
}

async function readScheduleStore() {
  try {
    await access(schedulePath, fsConstants.R_OK);
  } catch {
    return {
      items: []
    };
  }

  return JSON.parse(await readFile(schedulePath, "utf8"));
}

function runSystemctl(action) {
  if (dryRun) {
    log(`dry run: systemctl --user ${action} ${vlcService}`);
    return;
  }

  const result = spawnSync("systemctl", ["--user", action, vlcService], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `systemctl ${action} failed`);
  }
}

function commandExists(command) {
  const result = spawnSync("test", ["-x", command], {
    encoding: "utf8"
  });
  return result.status === 0;
}

function runDisplayCommand(command, args) {
  if (dryRun) {
    log(`dry run: ${command} ${args.join(" ")}`);
    return true;
  }

  const result = spawnSync(command, args, {
    encoding: "utf8"
  });
  if (result.status === 0) {
    return true;
  }

  const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
  log(`display command failed: ${message}`);
  return false;
}

function setDisplayPower(power) {
  const enabled = power === "on";
  const attempts = [];

  if (commandExists("/usr/bin/wlr-randr")) {
    attempts.push({
      command: "/usr/bin/wlr-randr",
      label: "wlr-randr",
      offArgs: ["--output", displayOutput, "--off"],
      onArgs: ["--output", displayOutput, "--on", "--mode", displayMode]
    });
  }

  if (commandExists("/usr/bin/xset")) {
    attempts.push({
      command: "/usr/bin/xset",
      label: "xset",
      offArgs: ["dpms", "force", "off"],
      onArgs: ["dpms", "force", "on"]
    });
  }

  if (commandExists("/usr/bin/vcgencmd")) {
    attempts.push({
      command: "/usr/bin/vcgencmd",
      label: "vcgencmd",
      offArgs: ["display_power", "0"],
      onArgs: ["display_power", "1"]
    });
  }

  for (const attempt of attempts) {
    const args = enabled ? attempt.onArgs : attempt.offArgs;
    if (runDisplayCommand(attempt.command, args)) {
      return {
        ok: true,
        action: enabled ? "display-on" : "display-off",
        detail: `${attempt.label} set ${displayOutput} ${power}.`
      };
    }
  }

  return {
    ok: false,
    action: enabled ? "display-on-failed" : "display-off-failed",
    detail: attempts.length
      ? `Could not turn display ${power} with available local commands.`
      : "No supported local display power command was found."
  };
}

async function enforce() {
  if (Number.isNaN(now.getTime())) {
    throw new Error("Invalid --now timestamp.");
  }

  const store = await readScheduleStore();
  const schedules = Array.isArray(store.items) ? store.items : [];
  const assigned = schedules.filter((schedule) => Array.isArray(schedule.screenIds) && schedule.screenIds.includes(screenId));
  const active = assigned.find((schedule) => scheduleIsActive(schedule, now));

  if (active) {
    const display = setDisplayPower("on");
    runSystemctl("start");
    await writeStatus({
      action: dryRun ? "would-start" : "start",
      activeScheduleId: active.id ?? null,
      activeScheduleName: active.name ?? null,
      detail: `Schedule window is active. ${display.detail}`,
      displayAction: display.action,
      displayControlOk: display.ok,
      displayOutput,
      state: "on"
    });
    log(
      `schedule active for ${screenId}; ${display.detail} ${
        dryRun ? "would start" : "started"
      } ${vlcService}`
    );
    return;
  }

  if (assigned.length > 0) {
    runSystemctl("stop");
    const display = setDisplayPower("off");
    await writeStatus({
      action: dryRun ? "would-stop" : "stop",
      activeScheduleId: null,
      activeScheduleName: null,
      detail: `Assigned schedule is outside its active window. ${display.detail}`,
      displayAction: display.action,
      displayControlOk: display.ok,
      displayOutput,
      state: "off"
    });
    log(
      `schedule inactive for ${screenId}; ${
        dryRun ? "would stop" : "stopped"
      } ${vlcService}; ${display.detail}`
    );
    return;
  }

  await writeStatus({
    action: "none",
    activeScheduleId: null,
    activeScheduleName: null,
    detail: "No schedule is assigned to this screen. Playback is not schedule-limited.",
    state: "unassigned"
  });
  log(`no schedule assigned to ${screenId}; leaving ${vlcService} unchanged`);
}

enforce().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  await writeStatus({
    action: "error",
    activeScheduleId: null,
    activeScheduleName: null,
    detail: message,
    state: "error"
  }).catch((statusError) => {
    log(`schedule status write failed: ${statusError instanceof Error ? statusError.message : String(statusError)}`);
  });
  fail(message);
});
