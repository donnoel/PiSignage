import type { ScheduleRecord, ScreenRecord } from "./local-data-store";

export type ScreenScheduleState = {
  detail: string;
  label: string;
  scheduleId: string | null;
  scheduleName: string | null;
  screenId: string;
  state: "off" | "on" | "unassigned";
};

type ZonedNow = {
  dayOfWeek: number;
  hour: number;
  minute: number;
};

const weekdayNumbers = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6]
]);

export const dayOptions = [
  { label: "Sun", value: 0 },
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 }
];

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function minutesFromTime(value: string): number {
  if (!isValidTime(value)) {
    throw new Error(`Invalid schedule time: ${value}`);
  }

  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return hour * 60 + minute;
}

export function formatDays(daysOfWeek: number[]): string {
  if (daysOfWeek.length === 7) {
    return "Every day";
  }

  return dayOptions
    .filter((day) => daysOfWeek.includes(day.value))
    .map((day) => day.label)
    .join(", ");
}

function zonedNow(date: Date, timeZone: string): ZonedNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
    weekday: "short"
  }).formatToParts(date);
  const valueFor = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const dayOfWeek = weekdayNumbers.get(valueFor("weekday"));

  if (typeof dayOfWeek !== "number") {
    throw new Error(`Could not resolve weekday for ${timeZone}.`);
  }

  return {
    dayOfWeek,
    hour: Number.parseInt(valueFor("hour"), 10),
    minute: Number.parseInt(valueFor("minute"), 10)
  };
}

export function scheduleIsActive(schedule: ScheduleRecord, now = new Date()): boolean {
  if (!isValidTimezone(schedule.timezone)) {
    return false;
  }

  const local = zonedNow(now, schedule.timezone);
  const currentMinutes = local.hour * 60 + local.minute;
  const previousDay = (local.dayOfWeek + 6) % 7;

  return schedule.rules.some((rule) => {
    const startMinutes = minutesFromTime(rule.startTime);
    const endMinutes = minutesFromTime(rule.endTime);

    if (startMinutes === endMinutes) {
      return rule.daysOfWeek.includes(local.dayOfWeek);
    }

    if (startMinutes < endMinutes) {
      return (
        rule.daysOfWeek.includes(local.dayOfWeek) &&
        currentMinutes >= startMinutes &&
        currentMinutes < endMinutes
      );
    }

    return (
      (rule.daysOfWeek.includes(local.dayOfWeek) && currentMinutes >= startMinutes) ||
      (rule.daysOfWeek.includes(previousDay) && currentMinutes < endMinutes)
    );
  });
}

export function scheduleWindowLabel(schedule: ScheduleRecord): string {
  const firstRule = schedule.rules[0];
  if (!firstRule) {
    return "No window";
  }

  return `${firstRule.startTime} to ${firstRule.endTime} ${schedule.timezone}`;
}

export function scheduleStateForScreen(
  schedules: ScheduleRecord[],
  screen: ScreenRecord,
  now = new Date()
): ScreenScheduleState {
  const assigned = schedules.filter((schedule) => schedule.screenIds.includes(screen.id));
  const active = assigned.find((schedule) => scheduleIsActive(schedule, now));

  if (active) {
    return {
      detail: `${scheduleWindowLabel(active)}. ${formatDays(active.rules[0]?.daysOfWeek ?? [])}.`,
      label: "Open now",
      scheduleId: active.id,
      scheduleName: active.name,
      screenId: screen.id,
      state: "on"
    };
  }

  if (assigned.length > 0) {
    const next = assigned[0];
    return {
      detail: `${scheduleWindowLabel(next)}. ${formatDays(next.rules[0]?.daysOfWeek ?? [])}.`,
      label: "Closed now",
      scheduleId: next.id,
      scheduleName: next.name,
      screenId: screen.id,
      state: "off"
    };
  }

  return {
    detail: "No hours set.",
    label: "No hours set",
    scheduleId: null,
    scheduleName: null,
    screenId: screen.id,
    state: "unassigned"
  };
}
