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
  playlistId: string | null;
};

type PlaylistSummary = {
  assetCount: number;
  name: string;
  playlistId: string;
  version: number;
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

type SchedulePublishSummary = {
  message: string;
  result: "error" | "success" | "warning";
  timestamp: string;
};

type ScheduleSupport = {
  host: string | null;
  lastPublish: SchedulePublishSummary | null;
  lastSuccessfulPublish: SchedulePublishSummary | null;
  pendingLocalChanges: boolean;
  piConfigured: boolean;
  reachable: boolean;
};

type ScheduleResponse = {
  days: DayOption[];
  defaultTimezone: string;
  error?: string;
  playlists: PlaylistSummary[];
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

function supportTone(support: ScheduleSupport | undefined): Tone {
  if (!support) {
    return "muted";
  }

  if (!support.piConfigured || support.pendingLocalChanges) {
    return "warn";
  }

  return support.lastSuccessfulPublish ? "good" : "muted";
}

function supportLabel(support: ScheduleSupport | undefined): string {
  if (!support) {
    return "Loading";
  }

  if (!support.piConfigured) {
    return "Local only";
  }

  if (support.pendingLocalChanges) {
    return "Publish needed";
  }

  if (support.lastSuccessfulPublish) {
    return "Published";
  }

  return "Ready to publish";
}

function formatCount(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function formatDays(days: DayOption[], selected: number[]): string {
  if (selected.length === 0) {
    return "No days selected";
  }

  if (selected.length === 7) {
    return "Every day";
  }

  return days
    .filter((day) => selected.includes(day.value))
    .map((day) => day.label)
    .join(", ");
}

function scheduleWindow(schedule: ScheduleRecord | null | undefined): string {
  const firstRule = schedule?.rules[0];
  if (!firstRule) {
    return "No window";
  }

  return `${firstRule.startTime} to ${firstRule.endTime}`;
}

function scheduleDays(schedule: ScheduleRecord | null | undefined, days: DayOption[]): string {
  return formatDays(days, schedule?.rules[0]?.daysOfWeek ?? []);
}

function playlistLabel(playlist: PlaylistSummary | null | undefined, playlistId: string | null): string {
  if (playlist) {
    return playlist.name;
  }

  return playlistId ? "Playlist not found" : "No playlist assigned";
}

function namesForScreens(screenIds: string[], screensById: Map<string, ScreenRecord>): string {
  const names = screenIds.map((id) => screensById.get(id)?.name ?? id);
  return names.length ? names.join(", ") : "No screens assigned";
}

function screenPublishStatus(screen: ScreenRecord, support: ScheduleSupport | undefined): { label: string; tone: Tone } {
  if (!support?.piConfigured) {
    return { label: "Local only", tone: "muted" };
  }

  const isLiveScreen = Boolean(screen.deviceHost && support.host && screen.deviceHost === support.host);
  if (!isLiveScreen) {
    return { label: "Inventory only", tone: "muted" };
  }

  return support.reachable
    ? { label: "Live screen", tone: "good" }
    : { label: "Screen down", tone: "danger" };
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
  const [busyAction, setBusyAction] = useState<"clear" | "delete" | "load" | "save" | null>(null);
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

  const playlistsById = useMemo(() => {
    return new Map((data?.playlists ?? []).map((playlist) => [playlist.playlistId, playlist]));
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
          <div className="self-start">
            <StatusPill label={supportLabel(data?.scheduleSupport)} tone={supportTone(data?.scheduleSupport)} />
          </div>
        </div>

        <dl className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-5">
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
          <div className="rounded-md bg-amber-50 p-4 ring-1 ring-amber-100">
            <dt className="text-xs font-semibold uppercase text-amber-900">Publish status</dt>
            <dd className="mt-2 break-words text-base font-semibold text-zinc-950">
              {supportLabel(data?.scheduleSupport)}
            </dd>
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
                const playlist = screen.playlistId ? playlistsById.get(screen.playlistId) : null;
                const isSelected = screenIds.includes(screen.id);
                const publishStatus = screenPublishStatus(screen, data?.scheduleSupport);

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
                      <p className="break-words font-semibold text-zinc-950">{playlistLabel(playlist, screen.playlistId)}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <StatusPill label={stateLabel(state)} tone={state ? stateTone(state.state) : "muted"} />
                        <StatusPill label={publishStatus.label} tone={publishStatus.tone} />
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

          <details className="rounded-lg border border-zinc-200 bg-white shadow-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
              <span className="text-lg font-semibold">Saved schedules</span>
              <span className="self-start">
                <StatusPill label={`${data?.schedules.length ?? 0} schedules`} tone="muted" />
              </span>
            </summary>
            <ol className="divide-y divide-zinc-200">
              {(data?.schedules ?? []).map((schedule) => (
                <li key={schedule.id} className="grid gap-4 px-5 py-4 text-sm xl:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <p className="font-semibold text-zinc-950">{schedule.name}</p>
                    <p className="mt-1 break-words text-zinc-600">
                      {scheduleWindow(schedule)} / {scheduleDays(schedule, days)} / {schedule.timezone}
                    </p>
                    <p className="mt-1 break-words text-xs text-zinc-500">
                      Screens: {namesForScreens(schedule.screenIds, screensById)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 xl:justify-end">
                    <button
                      type="button"
                      onClick={() => editSchedule(schedule)}
                      className="min-h-9 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void deleteSchedule(schedule)}
                      className="min-h-9 rounded-md border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
              {(data?.schedules.length ?? 0) === 0 ? (
                <li className="p-5 text-sm leading-6 text-zinc-600">
                  No saved schedules.
                </li>
              ) : null}
            </ol>
          </details>
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
                  {(data?.screens ?? []).map((screen) => {
                    const playlist = screen.playlistId ? playlistsById.get(screen.playlistId) : null;

                    return (
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
                            {playlistLabel(playlist, screen.playlistId)}
                          </span>
                        </span>
                      </label>
                    );
                  })}
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
