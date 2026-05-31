import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  readScheduleStore,
  readSettingsRecord,
  scheduleStorePath,
  type ScheduleRecord,
  type ScheduleStore,
  writeScheduleStore
} from "../../lib/local-data-store";
import { ensureInventorySeed } from "../../lib/local-inventory";
import { readLivePlaylist } from "../../lib/local-playlist";
import { publishScheduleStoreToPi, readPiConfig } from "../../lib/pi-local";
import {
  dayOptions,
  isValidTime,
  isValidTimezone,
  scheduleStateForScreen
} from "../../lib/schedule-evaluator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ScheduleInput = {
  daysOfWeek?: number[];
  endTime?: string;
  id?: string;
  name?: string;
  screenIds?: string[];
  startTime?: string;
  timezone?: string;
};

function isoNow(): string {
  return new Date().toISOString();
}

function normalizeDays(daysOfWeek: unknown): number[] {
  if (!Array.isArray(daysOfWeek)) {
    throw new Error("Choose at least one active day.");
  }

  const values = [...new Set(daysOfWeek.map((day) => Number(day)))].sort((a, b) => a - b);
  if (values.length === 0 || values.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("Choose at least one valid active day.");
  }

  return values;
}

function validateInput(input: ScheduleInput, screenIds: Set<string>): {
  daysOfWeek: number[];
  endTime: string;
  name: string;
  screenIds: string[];
  startTime: string;
  timezone: string;
} {
  const name = input.name?.trim();
  const timezone = input.timezone?.trim();
  const startTime = input.startTime?.trim();
  const endTime = input.endTime?.trim();
  const assignedScreenIds = Array.isArray(input.screenIds)
    ? [...new Set(input.screenIds.filter((id) => screenIds.has(id)))]
    : [];

  if (!name) {
    throw new Error("Schedule name is required.");
  }

  if (!timezone || !isValidTimezone(timezone)) {
    throw new Error("Choose a valid timezone.");
  }

  if (!startTime || !isValidTime(startTime)) {
    throw new Error("Choose a valid on time.");
  }

  if (!endTime || !isValidTime(endTime)) {
    throw new Error("Choose a valid off time.");
  }

  return {
    daysOfWeek: normalizeDays(input.daysOfWeek),
    endTime,
    name,
    screenIds: assignedScreenIds,
    startTime,
    timezone
  };
}

async function inventoryForSchedules() {
  const [playlist, piConfig] = await Promise.all([readLivePlaylist(), Promise.resolve(readPiConfig())]);
  return ensureInventorySeed({
    host: piConfig?.host ?? null,
    location: process.env.PISIGNAGE_LOCATION_NAME?.trim() || "Primary location",
    playlistId: playlist.playlistId,
    rootPath: piConfig?.root ?? null,
    screenName: process.env.PISIGNAGE_SCREEN_NAME?.trim() || "Primary Screen",
    sshUser: piConfig?.user ?? null
  });
}

async function publishSchedules() {
  const publish = await publishScheduleStoreToPi(scheduleStorePath(), {
    failure: "Schedule publish needs attention.",
    notConfigured: "Pi schedule publish is not configured; schedules stayed local."
  });

  await appendActivityRecord({
    id: randomUUID(),
    action: "schedule-publish",
    actor: "local-operator",
    entityId: "schedules",
    entityType: "schedule",
    message: publish.message,
    result: publish.ok ? "success" : publish.enabled ? "warning" : "warning",
    timestamp: isoNow()
  });

  return publish;
}

async function scheduleResponse(publish?: Awaited<ReturnType<typeof publishSchedules>>) {
  await ensureLocalDataFoundation();
  const [scheduleStore, settings, inventory] = await Promise.all([
    readScheduleStore(),
    readSettingsRecord(),
    inventoryForSchedules()
  ]);
  const screenStates = inventory.screens.items.map((screen) =>
    scheduleStateForScreen(scheduleStore.items, screen)
  );

  return NextResponse.json({
    defaultTimezone: settings.defaultScheduleTimezone,
    days: dayOptions,
    publish: publish ?? null,
    schedules: scheduleStore.items,
    screens: inventory.screens.items,
    screenStates
  });
}

export async function GET() {
  return scheduleResponse();
}

export async function POST(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const body = (await request.json()) as ScheduleInput;
    const inventory = await inventoryForSchedules();
    const input = validateInput(body, new Set(inventory.screens.items.map((screen) => screen.id)));
    const timestamp = isoNow();
    const schedule: ScheduleRecord = {
      id: `schedule-${randomUUID()}`,
      name: input.name,
      rules: [
        {
          daysOfWeek: input.daysOfWeek,
          endTime: input.endTime,
          startTime: input.startTime
        }
      ],
      screenIds: input.screenIds,
      timezone: input.timezone,
      updatedAt: timestamp
    };
    const store = await readScheduleStore();
    const nextStore: ScheduleStore = {
      ...store,
      items: [...store.items, schedule],
      updatedAt: timestamp,
      version: store.version + 1
    };

    await writeScheduleStore(nextStore);
    await appendActivityRecord({
      id: randomUUID(),
      action: "schedule-add",
      actor: "local-operator",
      entityId: schedule.id,
      entityType: "schedule",
      message: `Added schedule ${schedule.name}.`,
      result: "success",
      timestamp
    });

    return scheduleResponse(await publishSchedules());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Schedule create failed." },
      { status: 400 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const body = (await request.json()) as ScheduleInput;
    if (!body.id) {
      return NextResponse.json({ error: "Missing schedule id." }, { status: 400 });
    }

    const inventory = await inventoryForSchedules();
    const input = validateInput(body, new Set(inventory.screens.items.map((screen) => screen.id)));
    const store = await readScheduleStore();
    const index = store.items.findIndex((schedule) => schedule.id === body.id);
    if (index === -1) {
      return NextResponse.json({ error: "Schedule was not found." }, { status: 404 });
    }

    const timestamp = isoNow();
    const items = [...store.items];
    items[index] = {
      ...items[index],
      name: input.name,
      rules: [
        {
          daysOfWeek: input.daysOfWeek,
          endTime: input.endTime,
          startTime: input.startTime
        }
      ],
      screenIds: input.screenIds,
      timezone: input.timezone,
      updatedAt: timestamp
    };

    await writeScheduleStore({
      ...store,
      items,
      updatedAt: timestamp,
      version: store.version + 1
    });
    await appendActivityRecord({
      id: randomUUID(),
      action: "schedule-update",
      actor: "local-operator",
      entityId: body.id,
      entityType: "schedule",
      message: `Updated schedule ${input.name}.`,
      result: "success",
      timestamp
    });

    return scheduleResponse(await publishSchedules());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Schedule update failed." },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const body = (await request.json()) as { id?: string };
    if (!body.id) {
      return NextResponse.json({ error: "Missing schedule id." }, { status: 400 });
    }

    const store = await readScheduleStore();
    const schedule = store.items.find((item) => item.id === body.id);
    if (!schedule) {
      return NextResponse.json({ error: "Schedule was not found." }, { status: 404 });
    }

    const timestamp = isoNow();
    await writeScheduleStore({
      ...store,
      items: store.items.filter((item) => item.id !== body.id),
      updatedAt: timestamp,
      version: store.version + 1
    });
    await appendActivityRecord({
      id: randomUUID(),
      action: "schedule-remove",
      actor: "local-operator",
      entityId: body.id,
      entityType: "schedule",
      message: `Removed schedule ${schedule.name}.`,
      result: "success",
      timestamp
    });

    return scheduleResponse(await publishSchedules());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Schedule remove failed." },
      { status: 400 }
    );
  }
}
