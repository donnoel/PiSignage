"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "./dashboard-ui";

type Tone = "danger" | "good" | "muted" | "warn";

type DayOption = {
  label: string;
  value: number;
};

type ScreenRecord = {
  deviceHost: string | null;
  deviceName: string | null;
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

type ScheduleSupport = {
  configuredScreenCount: number;
  piConfigured: boolean;
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
  scheduleSupport: ScheduleSupport;
  schedules: ScheduleRecord[];
  screens: ScreenRecord[];
  screenStates: ScreenScheduleState[];
  storeUpdatedAt: string;
  storeVersion: number;
};

const defaultDays = [1, 2, 3, 4, 5];

function stateTone(state: ScreenScheduleState["state"]): Tone {
  return state === "on" ? "good" : "muted";
}

function stateLabel(state: ScreenScheduleState | undefined): string {
  if (!state) {
    return "Not loaded";
  }

  if (state.state === "on") {
    return "Open now";
  }

  if (state.state === "off") {
    return "Closed now";
  }

  return "No hours set";
}

function formatCount(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
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
  const [busyAction, setBusyAction] = useState<"clear" | "load" | "save" | null>(null);
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
      setMessage("Schedule view loaded.");
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
  }, [data]);

  const scheduleById = useMemo(() => {
    return new Map((data?.schedules ?? []).map((schedule) => [schedule.id, schedule]));
  }, [data]);

  const screensById = useMemo(() => {
    return new Map((data?.screens ?? []).map((screen) => [screen.id, screen]));
  }, [data]);

  const openCount = data?.screenStates.filter((state) => state.state === "on").length ?? 0;
  const closedCount = data?.screenStates.filter((state) => state.state === "off").length ?? 0;
  const unassignedCount = data?.screenStates.filter((state) => state.state === "unassigned").length ?? 0;
  const scheduledCount = (data?.screenStates.length ?? 0) - unassignedCount;
  const selectedFormScreens = screenIds.map((id) => screensById.get(id)).filter((screen): screen is ScreenRecord => Boolean(screen));
  const isEditorOpen = selectedFormScreens.length > 0 || Boolean(editingId);
  const formTitle = editingId
    ? selectedFormScreens.length === 1
      ? `${selectedFormScreens[0].name} hours`
      : selectedFormScreens.length > 1
        ? `Hours for ${formatCount(selectedFormScreens.length, "screen")}`
        : "Hours editor"
    : selectedFormScreens.length === 1
      ? `${selectedFormScreens[0].name} hours`
      : selectedFormScreens.length > 1
        ? `Hours for ${formatCount(selectedFormScreens.length, "screen")}`
        : "Hours editor";
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

  function setHoursForScreen(screen: ScreenRecord) {
    setEditingId(null);
    setName(`${screen.name} hours`);
    setTimezone(data?.defaultTimezone ?? timezone);
    setStartTime("07:00");
    setEndTime("17:00");
    setDaysOfWeek(defaultDays);
    setScreenIds([screen.id]);
    setMessage(`Setting hours for ${screen.name}.`);
  }

  function editScheduleForScreen(screen: ScreenRecord, schedule: ScheduleRecord) {
    const firstRule = schedule.rules[0];
    setEditingId(schedule.id);
    setName(schedule.name);
    setTimezone(schedule.timezone);
    setStartTime(firstRule?.startTime ?? "07:00");
    setEndTime(firstRule?.endTime ?? "17:00");
    setDaysOfWeek(firstRule?.daysOfWeek ?? defaultDays);
    setScreenIds([screen.id]);
    setMessage(`Editing hours for ${screen.name}.`);
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
    if (screenIds.length === 0) {
      setMessage("Choose at least one screen.");
      return;
    }

    setBusyAction("save");
    setMessage(editingId ? "Saving screen hours..." : "Adding screen hours...");
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
      setMessage(result.publish?.message ?? "Screen hours saved.");
      resetForm(result.defaultTimezone);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schedule save failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function clearScheduleForScreen(screen: ScreenRecord, schedule: ScheduleRecord) {
    if (isBusy) {
      return;
    }

    setBusyAction("clear");
    setMessage(`Clearing hours for ${screen.name}...`);
    try {
      const remainingScreenIds = schedule.screenIds.filter((id) => id !== screen.id);
      const response =
        remainingScreenIds.length === 0
          ? await fetch("/api/local-schedules", {
              method: "DELETE",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ id: schedule.id })
            })
          : await fetch("/api/local-schedules", {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                daysOfWeek: schedule.rules[0]?.daysOfWeek ?? defaultDays,
                endTime: schedule.rules[0]?.endTime ?? "17:00",
                id: schedule.id,
                name: schedule.name,
                screenIds: remainingScreenIds,
                startTime: schedule.rules[0]?.startTime ?? "07:00",
                timezone: schedule.timezone
              })
            });
      const result = (await response.json()) as ScheduleResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Schedule clear failed.");
      }
      setData(result);
      setMessage(result.publish?.message ?? `Cleared hours for ${screen.name}.`);
      if (editingId === schedule.id) {
        resetForm(result.defaultTimezone);
      }
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schedule clear failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">Screen schedules</h2>
          </div>
        </div>

        <dl className="grid grid-cols-[repeat(auto-fit,minmax(148px,1fr))] gap-3 p-5">
          <div className="rounded-md bg-zinc-50 p-4 ring-1 ring-zinc-200">
            <dt className="text-xs font-semibold uppercase text-zinc-600">Scheduled</dt>
            <dd className="mt-2 text-2xl font-semibold text-zinc-950">{scheduledCount}</dd>
          </div>
          <div className="rounded-md bg-zinc-50 p-4 ring-1 ring-zinc-200">
            <dt className="text-xs font-semibold uppercase text-zinc-600">No hours set</dt>
            <dd className="mt-2 text-2xl font-semibold text-zinc-950">{unassignedCount}</dd>
          </div>
          <div className="rounded-md bg-emerald-50 p-4 ring-1 ring-emerald-100">
            <dt className="text-xs font-semibold uppercase text-emerald-800">Open now</dt>
            <dd className="mt-2 text-2xl font-semibold text-zinc-950">{openCount}</dd>
          </div>
          <div className="rounded-md bg-sky-50 p-4 ring-1 ring-sky-100">
            <dt className="text-xs font-semibold uppercase text-sky-800">Closed now</dt>
            <dd className="mt-2 text-2xl font-semibold text-zinc-950">{closedCount}</dd>
          </div>
        </dl>
      </section>

      <section className={isEditorOpen ? "grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]" : "grid gap-4"}>
        <div className="space-y-4">
          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
            <div className="flex flex-col gap-2 border-b border-zinc-200 p-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold">Screen plan</h3>
              </div>
              <div className="self-start">
                <StatusPill label={`${data?.screens.length ?? 0} screens`} tone="muted" />
              </div>
            </div>
            <ol className="max-h-[42rem] divide-y divide-zinc-200 overflow-auto">
              {(data?.screens ?? []).map((screen) => {
                const state = screenStateById.get(screen.id);
                const schedule = state?.scheduleId ? scheduleById.get(state.scheduleId) : null;
                const isSelected = screenIds.includes(screen.id);

                return (
                  <li
                    key={screen.id}
                    className={`grid gap-3 px-5 py-3 text-sm lg:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)_12rem] lg:items-center ${
                      isSelected ? "bg-teal-50/60" : "bg-white"
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="break-words font-semibold text-zinc-950">{screen.name}</p>
                      <p className="mt-1 break-words text-zinc-600">{screen.location} / {screen.group}</p>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill label={stateLabel(state)} tone={state ? stateTone(state.state) : "muted"} />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => (schedule ? editScheduleForScreen(screen, schedule) : setHoursForScreen(screen))}
                        className="min-h-9 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800"
                      >
                        {schedule ? "Edit hours" : "Set hours"}
                      </button>
                      {schedule ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void clearScheduleForScreen(screen, schedule)}
                          className="min-h-9 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
              {(data?.screens.length ?? 0) === 0 ? (
                <li className="p-5 text-sm text-zinc-600">Add a screen before scheduling playback windows.</li>
              ) : null}
            </ol>
          </section>

        </div>

        {isEditorOpen ? (
          <form onSubmit={saveSchedule} className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm xl:sticky xl:top-4 xl:self-start">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">{formTitle}</h3>
              </div>
              <button
                type="button"
                onClick={() => resetForm()}
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50"
              >
                Close
              </button>
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
              <details className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-zinc-800">Timezone</summary>
                <label className="mt-3 grid gap-1 text-sm font-semibold text-zinc-800">
                  Schedule timezone
                  <input
                    value={timezone}
                    onChange={(event) => setTimezone(event.currentTarget.value)}
                    className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-950"
                  />
                </label>
              </details>
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
                <div className="grid max-h-56 gap-2 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-2">
                  {(data?.screens ?? []).map((screen) => (
                    <label key={screen.id} className="flex items-start gap-2 rounded-md bg-white p-2 text-sm ring-1 ring-zinc-200">
                      <input
                        type="checkbox"
                        checked={screenIds.includes(screen.id)}
                        onChange={() => toggleScreen(screen.id)}
                        className="mt-1 h-4 w-4 accent-teal-700"
                      />
                      <span className="min-w-0">
                        <span className="block break-words font-semibold text-zinc-950">{screen.name}</span>
                        <span className="block break-words text-xs text-zinc-600">
                          {screen.location} / {screen.group}
                        </span>
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
                disabled={isBusy || screenIds.length === 0}
                className="min-h-11 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                {busyAction === "save" ? "Saving..." : editingId ? "Save hours" : "Add hours"}
              </button>
              {message ? (
                <p className="text-sm font-medium text-zinc-600" role="status" aria-live="polite">
                  {message}
                </p>
              ) : null}
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
