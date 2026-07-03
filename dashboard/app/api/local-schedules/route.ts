import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  readScheduleStore,
  readSettingsRecord,
  type ScheduleRecord,
  type ScheduleStore,
  writeScheduleStore
} from "../../lib/local-data-store";
import { readInventory } from "../../lib/inventory-store";
import { repairSchedulesForScreens } from "../../lib/local-inventory";
import { apiErrorResponse } from "../../lib/api-error-response";
import { readLivePlaylist, readPlaylistStore } from "../../lib/local-playlist";
import {
  dayOptions,
  isValidTime,
  isValidTimezone,
  scheduleStateForScreen
} from "../../lib/schedule-evaluator";
import { activeWorkspaceSession, workspaceContextFromSession } from "../../lib/workspace";

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

function compareScreensByName(
  left: { id: string; name: string },
  right: { id: string; name: string }
): number {
  const byName = left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base"
  });

  return byName || left.id.localeCompare(right.id);
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
  if (assignedScreenIds.length === 0) {
    throw new Error("Choose at least one screen.");
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
  const playlist = await readLivePlaylist();
  return readInventory(playlist.playlistId);
}

async function scheduleResponse(publish?: {
  enabled: boolean;
  message: string;
  ok: boolean;
}) {
  await ensureLocalDataFoundation();
  const session = activeWorkspaceSession();
  const context = workspaceContextFromSession(session);
  const inventory = await inventoryForSchedules();
  const inventoryScreens = [...inventory.screens.items].sort(compareScreensByName);
  await repairSchedulesForScreens(inventoryScreens.map((screen) => screen.id));
  const [scheduleStore, settings, playlistStore] = await Promise.all([
    readScheduleStore(),
    readSettingsRecord(),
    readPlaylistStore()
  ]);
  const screenStates = inventoryScreens.map((screen) =>
    scheduleStateForScreen(scheduleStore.items, screen)
  );
  const devicesById = new Map(inventory.devices.items.map((device) => [device.id, device]));
  const devicesByScreenId = new Map(
    inventory.devices.items
      .filter((device) => device.screenId)
      .map((device) => [device.screenId as string, device])
  );
  const screens = inventoryScreens.map((screen) => {
    const linkedDevice =
      (screen.deviceId ? devicesById.get(screen.deviceId) : null) ??
      devicesByScreenId.get(screen.id) ??
      null;

    return {
      ...screen,
      deviceHost: linkedDevice?.host ?? null,
      deviceName: linkedDevice?.name ?? null
    };
  });
  const configuredScreenCount = screens.filter((screen) => Boolean(screen.deviceHost)).length;

  return NextResponse.json({
    activeWorkspaceId: context.activeWorkspaceId,
    defaultTimezone: settings.defaultScheduleTimezone,
    days: dayOptions,
    playlists: playlistStore.items.map((playlist) => ({
      assetCount: playlist.assets.length,
      name: playlist.name,
      playlistId: playlist.playlistId,
      version: playlist.version
    })),
    publish: publish ?? null,
    scheduleSupport: {
      configuredScreenCount,
      piConfigured: configuredScreenCount > 0
    },
    schedules: scheduleStore.items,
    screens,
    screenStates,
    storeUpdatedAt: scheduleStore.updatedAt,
    storeVersion: scheduleStore.version,
    userId: context.userId
  });
}

export async function GET() {
  return scheduleResponse();
}

export async function POST(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
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
      actor: context.userId,
      entityId: schedule.id,
      entityType: "schedule",
      message: `Added schedule ${schedule.name}.`,
      result: "success",
      timestamp
    });

    return scheduleResponse({
      enabled: false,
      ok: true,
      message: `Saved ${schedule.name}.`
    });
  } catch (error) {
    return apiErrorResponse(error, "Schedule create failed.", 400);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
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
      actor: context.userId,
      entityId: body.id,
      entityType: "schedule",
      message: `Updated schedule ${input.name}.`,
      result: "success",
      timestamp
    });

    return scheduleResponse({
      enabled: false,
      ok: true,
      message: `Saved ${input.name}.`
    });
  } catch (error) {
    return apiErrorResponse(error, "Schedule update failed.", 400);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
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
      actor: context.userId,
      entityId: body.id,
      entityType: "schedule",
      message: `Removed schedule ${schedule.name}.`,
      result: "success",
      timestamp
    });

    return scheduleResponse({
      enabled: false,
      ok: true,
      message: `Cleared ${schedule.name}.`
    });
  } catch (error) {
    return apiErrorResponse(error, "Schedule remove failed.", 400);
  }
}
