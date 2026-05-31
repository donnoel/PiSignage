"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "./dashboard-ui";

type DayOption = {
  label: string;
  value: number;
};

type ScreenRecord = {
  group: string;
  id: string;
  location: string;
  name: string;
};

type ScheduleRecord = {
  id: string;
  name: string;
  rules: Array<{
    daysOfWeek: number[];
    endTime: string;
    startTime: string;
  }>;
  screenIds: string[];
  timezone: string;
  updatedAt: string;
};

type ScreenScheduleState = {
  detail: string;
  label: string;
  scheduleId: string | null;
  scheduleName: string | null;
  screenId: string;
  state: "off" | "on" | "unassigned";
};

type ScheduleResponse = {
  days: DayOption[];
  defaultTimezone: string;
  error?: string;
  publish: {
    enabled: boolean;
    message: string;
    ok: boolean;
  } | null;
  schedules: ScheduleRecord[];
  screens: ScreenRecord[];
  screenStates: ScreenScheduleState[];
};

const defaultDays = [1, 2, 3, 4, 5];

function stateTone(state: ScreenScheduleState["state"]): "good" | "muted" | "warn" {
  if (state === "on") {
    return "good";
  }

  return state === "off" ? "warn" : "muted";
}

function formatDays(days: DayOption[], selected: number[]): string {
  if (selected.length === 7) {
    return "Every day";
  }

  return days
    .filter((day) => selected.includes(day.value))
    .map((day) => day.label)
    .join(", ");
}

export function SchedulingPanel() {
  const router = useRouter();
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [message, setMessage] = useState("Loading schedules...");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("Business hours");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [startTime, setStartTime] = useState("07:00");
  const [endTime, setEndTime] = useState("17:00");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(defaultDays);
  const [screenIds, setScreenIds] = useState<string[]>([]);
  const [busyAction, setBusyAction] = useState<"delete" | "load" | "save" | null>(null);
  const [isPending, startTransition] = useTransition();
  const isBusy = Boolean(busyAction) || isPending;

  async function loadSchedules() {
    setBusyAction((current) => current ?? "load");
    try {
      const response = await fetch("/api/local-schedules", { cache: "no-store" });
      const result = (await response.json()) as ScheduleResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not load schedules.");
      }
      setData(result);
      setTimezone((current) => current || result.defaultTimezone);
      setMessage("Schedules loaded.");
    } catch (error) {
      setData(null);
      setMessage(error instanceof Error ? error.message : "Could not load schedules.");
    } finally {
      setBusyAction((current) => (current === "load" ? null : current));
    }
  }

  useEffect(() => {
    void loadSchedules();
  }, []);

  const screenStateById = useMemo(() => {
    return new Map((data?.screenStates ?? []).map((state) => [state.screenId, state]));
  }, [data?.screenStates]);

  const onCount = data?.screenStates.filter((state) => state.state === "on").length ?? 0;
  const offCount = data?.screenStates.filter((state) => state.state === "off").length ?? 0;
  const unassignedCount = data?.screenStates.filter((state) => state.state === "unassigned").length ?? 0;
  const days = data?.days ?? [
    { label: "Sun", value: 0 },
    { label: "Mon", value: 1 },
    { label: "Tue", value: 2 },
    { label: "Wed", value: 3 },
    { label: "Thu", value: 4 },
    { label: "Fri", value: 5 },
    { label: "Sat", value: 6 }
  ];

  function resetForm(defaultTimezone = data?.defaultTimezone ?? "America/Los_Angeles") {
    setEditingId(null);
    setName("Business hours");
    setTimezone(defaultTimezone);
    setStartTime("07:00");
    setEndTime("17:00");
    setDaysOfWeek(defaultDays);
    setScreenIds([]);
  }

  function editSchedule(schedule: ScheduleRecord) {
    const firstRule = schedule.rules[0];
    setEditingId(schedule.id);
    setName(schedule.name);
    setTimezone(schedule.timezone);
    setStartTime(firstRule?.startTime ?? "07:00");
    setEndTime(firstRule?.endTime ?? "17:00");
    setDaysOfWeek(firstRule?.daysOfWeek ?? defaultDays);
    setScreenIds(schedule.screenIds);
  }

  function toggleDay(day: number) {
    setDaysOfWeek((current) =>
      current.includes(day)
        ? current.filter((candidate) => candidate !== day)
        : [...current, day].sort((a, b) => a - b)
    );
  }

  function toggleScreen(screenId: string) {
    setScreenIds((current) =>
      current.includes(screenId)
        ? current.filter((candidate) => candidate !== screenId)
        : [...current, screenId]
    );
  }

  async function saveSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    setBusyAction("save");
    setMessage(editingId ? "Saving schedule..." : "Creating schedule...");
    try {
      const response = await fetch("/api/local-schedules", {
        method: editingId ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          daysOfWeek,
          endTime,
          id: editingId,
          name,
          screenIds,
          startTime,
          timezone
        })
      });
      const result = (await response.json()) as ScheduleResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Schedule save failed.");
      }
      setData(result);
      setMessage(result.publish?.message ?? "Schedule saved.");
      resetForm(result.defaultTimezone);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schedule save failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteSchedule(schedule: ScheduleRecord) {
    if (isBusy) {
      return;
    }

    setBusyAction("delete");
    setMessage(`Removing ${schedule.name}...`);
    try {
      const response = await fetch("/api/local-schedules", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ id: schedule.id })
      });
      const result = (await response.json()) as ScheduleResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Schedule remove failed.");
      }
      setData(result);
      setMessage(result.publish?.message ?? "Schedule removed.");
      if (editingId === schedule.id) {
        resetForm(result.defaultTimezone);
      }
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schedule remove failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Business-hours schedules</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">
              Set simple daily on and off windows, assign screens, and publish the cached schedule to the Pi.
            </p>
          </div>
          <StatusPill label={`${data?.schedules.length ?? 0} schedules`} tone="muted" />
        </div>

        <dl className="grid gap-3 p-5 sm:grid-cols-3">
          <div className="rounded-md bg-emerald-50 p-4 ring-1 ring-emerald-100">
            <dt className="text-xs font-semibold uppercase text-emerald-800">On now</dt>
            <dd className="mt-2 text-2xl font-semibold">{onCount}</dd>
          </div>
          <div className="rounded-md bg-amber-50 p-4 ring-1 ring-amber-100">
            <dt className="text-xs font-semibold uppercase text-amber-900">Off now</dt>
            <dd className="mt-2 text-2xl font-semibold">{offCount}</dd>
          </div>
          <div className="rounded-md bg-zinc-50 p-4 ring-1 ring-zinc-200">
            <dt className="text-xs font-semibold uppercase text-zinc-600">No schedule</dt>
            <dd className="mt-2 text-2xl font-semibold">{unassignedCount}</dd>
          </div>
        </dl>
      </section>

      <section className="grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
        <form onSubmit={saveSchedule} className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">{editingId ? "Edit schedule" : "Add schedule"}</h3>
              <p className="mt-1 text-sm text-zinc-600">Start with one daily window. Exceptions and holidays come later.</p>
            </div>
            {editingId ? (
              <button
                type="button"
                onClick={() => resetForm()}
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-800"
              >
                New
              </button>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3">
            <label className="grid gap-1 text-sm font-semibold text-zinc-800">
              Name
              <input
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                className="min-h-10 rounded-md border border-zinc-300 px-3 py-2 text-sm font-normal text-zinc-950"
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-zinc-800">
              Timezone
              <input
                value={timezone}
                onChange={(event) => setTimezone(event.currentTarget.value)}
                className="min-h-10 rounded-md border border-zinc-300 px-3 py-2 text-sm font-normal text-zinc-950"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm font-semibold text-zinc-800">
                On
                <input
                  type="time"
                  value={startTime}
                  onChange={(event) => setStartTime(event.currentTarget.value)}
                  className="min-h-10 rounded-md border border-zinc-300 px-3 py-2 text-sm font-normal text-zinc-950"
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-zinc-800">
                Off
                <input
                  type="time"
                  value={endTime}
                  onChange={(event) => setEndTime(event.currentTarget.value)}
                  className="min-h-10 rounded-md border border-zinc-300 px-3 py-2 text-sm font-normal text-zinc-950"
                />
              </label>
            </div>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-semibold text-zinc-800">Days</legend>
              <div className="flex flex-wrap gap-2">
                {days.map((day) => (
                  <label
                    key={day.value}
                    className={`inline-flex min-h-9 cursor-pointer items-center rounded-md px-3 py-2 text-sm font-semibold ring-1 ${
                      daysOfWeek.includes(day.value)
                        ? "bg-teal-700 text-white ring-teal-700"
                        : "bg-white text-zinc-700 ring-zinc-200"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={daysOfWeek.includes(day.value)}
                      onChange={() => toggleDay(day.value)}
                      className="sr-only"
                    />
                    {day.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-semibold text-zinc-800">Screens</legend>
              <div className="grid max-h-48 gap-2 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-2">
                {(data?.screens ?? []).map((screen) => (
                  <label key={screen.id} className="flex items-start gap-2 rounded-md bg-white p-2 text-sm ring-1 ring-zinc-200">
                    <input
                      type="checkbox"
                      checked={screenIds.includes(screen.id)}
                      onChange={() => toggleScreen(screen.id)}
                      className="mt-1 h-4 w-4 accent-teal-700"
                    />
                    <span>
                      <span className="font-semibold text-zinc-950">{screen.name}</span>
                      <span className="block text-xs text-zinc-600">{screen.location} / {screen.group}</span>
                    </span>
                  </label>
                ))}
                {(data?.screens.length ?? 0) === 0 ? (
                  <p className="p-2 text-sm text-zinc-600">Add screens before assigning schedules.</p>
                ) : null}
              </div>
            </fieldset>

            <button
              type="submit"
              disabled={isBusy}
              className="min-h-11 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
            >
              {busyAction === "save" ? "Saving..." : editingId ? "Save schedule" : "Add schedule"}
            </button>
            {message ? (
              <p className="text-sm font-medium text-zinc-600" role="status" aria-live="polite">
                {message}
              </p>
            ) : null}
          </div>
        </form>

        <div className="space-y-4">
          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-200 p-5">
              <h3 className="text-lg font-semibold">Screen schedule state</h3>
            </div>
            <ol className="divide-y divide-zinc-200">
              {(data?.screens ?? []).map((screen) => {
                const state = screenStateById.get(screen.id);
                return (
                  <li key={screen.id} className="grid gap-3 px-5 py-4 text-sm md:grid-cols-[1fr_160px]">
                    <div>
                      <p className="font-semibold text-zinc-950">{screen.name}</p>
                      <p className="mt-1 text-zinc-600">{state?.scheduleName ?? "No schedule assigned"}</p>
                      <p className="mt-1 text-xs text-zinc-500">{state?.detail ?? "No state reported."}</p>
                    </div>
                    <div className="md:justify-self-end">
                      <StatusPill label={state?.label ?? "Unknown"} tone={state ? stateTone(state.state) : "muted"} />
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-200 p-5">
              <h3 className="text-lg font-semibold">Schedules</h3>
            </div>
            <ol className="divide-y divide-zinc-200">
              {(data?.schedules ?? []).map((schedule) => {
                const firstRule = schedule.rules[0];
                return (
                  <li key={schedule.id} className="grid gap-3 px-5 py-4 text-sm xl:grid-cols-[1fr_auto]">
                    <div>
                      <p className="font-semibold text-zinc-950">{schedule.name}</p>
                      <p className="mt-1 text-zinc-600">
                        {firstRule?.startTime ?? "--:--"} to {firstRule?.endTime ?? "--:--"} / {schedule.timezone}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {formatDays(days, firstRule?.daysOfWeek ?? [])} / {schedule.screenIds.length} assigned
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 xl:justify-end">
                      <button
                        type="button"
                        onClick={() => editSchedule(schedule)}
                        className="min-h-9 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-800"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void deleteSchedule(schedule)}
                        className="min-h-9 rounded-md border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
              {(data?.schedules.length ?? 0) === 0 ? (
                <li className="p-5 text-sm text-zinc-600">No schedules recorded yet.</li>
              ) : null}
            </ol>
          </section>
        </div>
      </section>
    </div>
  );
}
