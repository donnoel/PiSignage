import { randomUUID } from "node:crypto";
import type { DeviceRecord, DeviceStore, ScheduleRecord, ScreenRecord, ScreenStore } from "./local-data-store";
import {
  appendActivityRecord,
  readDeviceStore,
  readScheduleStore,
  readScreenStore,
  writeDeviceStore,
  writeScheduleStore,
  writeScreenStore
} from "./local-data-store";

function isoNow(): string {
  return new Date().toISOString();
}

function normalizeScreen(screen: ScreenRecord, fallbackPlaylistId: string): ScreenRecord {
  return {
    ...screen,
    group: typeof screen.group === "string" && screen.group.trim() ? screen.group.trim() : "Primary",
    location: typeof screen.location === "string" && screen.location.trim() ? screen.location.trim() : "Unassigned",
    name: typeof screen.name === "string" && screen.name.trim() ? screen.name.trim() : "Unnamed Screen",
    notes: typeof screen.notes === "string" ? screen.notes : "",
    playlistId: screen.playlistId === undefined ? fallbackPlaylistId : screen.playlistId
  };
}

function normalizeDevice(device: DeviceRecord, fallbackPlaylistId: string): DeviceRecord {
  return {
    ...device,
    group: typeof device.group === "string" && device.group.trim() ? device.group.trim() : "Primary",
    location: typeof device.location === "string" && device.location.trim() ? device.location.trim() : "Unassigned",
    name: typeof device.name === "string" && device.name.trim() ? device.name.trim() : "Unnamed Device",
    notes: typeof device.notes === "string" ? device.notes : "",
    playlistId: device.playlistId === undefined ? fallbackPlaylistId : device.playlistId,
    host: typeof device.host === "string" && device.host.trim() ? device.host.trim() : "Not configured",
    rootPath: typeof device.rootPath === "string" && device.rootPath.trim() ? device.rootPath.trim() : "~",
    sshUser: typeof device.sshUser === "string" && device.sshUser.trim() ? device.sshUser.trim() : "donnoel"
  };
}

function normalizeScreenStore(screenStore: ScreenStore, fallbackPlaylistId: string): ScreenStore {
  return {
    ...screenStore,
    items: screenStore.items.map((screen) => normalizeScreen(screen, fallbackPlaylistId))
  };
}

function normalizeDeviceStore(deviceStore: DeviceStore, fallbackPlaylistId: string): DeviceStore {
  return {
    ...deviceStore,
    items: deviceStore.items.map((device) => normalizeDevice(device, fallbackPlaylistId))
  };
}

function recordsChanged<TRecord>(before: TRecord[], after: TRecord[]): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export async function readNormalizedInventory(fallbackPlaylistId: string): Promise<{
  devices: DeviceStore;
  screens: ScreenStore;
}> {
  const [rawScreens, rawDevices] = await Promise.all([readScreenStore(), readDeviceStore()]);
  let screens = normalizeScreenStore(rawScreens, fallbackPlaylistId);
  let devices = normalizeDeviceStore(rawDevices, fallbackPlaylistId);
  const timestamp = isoNow();
  const screensUpdated = recordsChanged(rawScreens.items, screens.items);
  const devicesUpdated = recordsChanged(rawDevices.items, devices.items);

  if (screensUpdated) {
    screens = {
      ...screens,
      updatedAt: timestamp,
      version: screens.version + 1
    };
  }

  if (devicesUpdated) {
    devices = {
      ...devices,
      updatedAt: timestamp,
      version: devices.version + 1
    };
  }

  if (screensUpdated) {
    await writeScreenStore(screens);
  }

  if (devicesUpdated) {
    await writeDeviceStore(devices);
  }

  return { devices, screens };
}

export function pruneSchedulesForScreens(
  schedules: ScheduleRecord[],
  screenIds: Iterable<string>,
  timestamp: string
): {
  items: ScheduleRecord[];
  removedScheduleCount: number;
  removedScreenReferenceCount: number;
} {
  const validScreenIds = new Set(screenIds);
  let removedScreenReferenceCount = 0;
  let removedScheduleCount = 0;

  const items = schedules.flatMap((schedule) => {
    const nextScreenIds = schedule.screenIds.filter((screenId) => validScreenIds.has(screenId));
    removedScreenReferenceCount += schedule.screenIds.length - nextScreenIds.length;

    if (nextScreenIds.length === 0) {
      removedScheduleCount += 1;
      return [];
    }

    if (nextScreenIds.length === schedule.screenIds.length) {
      return [schedule];
    }

    return [
      {
        ...schedule,
        screenIds: nextScreenIds,
        updatedAt: timestamp
      }
    ];
  });

  return { items, removedScheduleCount, removedScreenReferenceCount };
}

export async function repairSchedulesForScreens(screenIds: Iterable<string>): Promise<{
  removedScheduleCount: number;
  removedScreenReferenceCount: number;
}> {
  const scheduleStore = await readScheduleStore();
  const timestamp = isoNow();
  const {
    items: nextSchedules,
    removedScheduleCount,
    removedScreenReferenceCount
  } = pruneSchedulesForScreens(scheduleStore.items, screenIds, timestamp);

  if (removedScreenReferenceCount === 0 && removedScheduleCount === 0) {
    return { removedScheduleCount, removedScreenReferenceCount };
  }

  await writeScheduleStore({
    ...scheduleStore,
    items: nextSchedules,
    updatedAt: timestamp,
    version: scheduleStore.version + 1
  });

  await appendActivityRecord({
    id: randomUUID(),
    action: "schedule-repair",
    actor: "local-system",
    entityId: "schedules",
    entityType: "schedule",
    message:
      removedScheduleCount > 0
        ? `Repaired schedules by removing ${removedScreenReferenceCount} stale screen assignment(s) and ${removedScheduleCount} empty schedule(s).`
        : `Repaired schedules by removing ${removedScreenReferenceCount} stale screen assignment(s).`,
    result: "warning",
    timestamp
  });

  return { removedScheduleCount, removedScreenReferenceCount };
}

export async function createScreen(input: {
  deviceId?: string | null;
  group?: string;
  location?: string;
  name: string;
  playlistId?: string | null;
}): Promise<ScreenRecord> {
  const store = await readScreenStore();
  const timestamp = isoNow();
  const next: ScreenRecord = {
    deviceId: input.deviceId ?? null,
    group: input.group?.trim() || "General",
    id: `screen-${randomUUID()}`,
    location: input.location?.trim() || "Unassigned",
    name: input.name.trim(),
    notes: "",
    playlistId: input.playlistId ?? null,
    updatedAt: timestamp
  };

  await writeScreenStore({
    ...store,
    items: [...store.items, next],
    updatedAt: timestamp,
    version: store.version + 1
  });

  await appendActivityRecord({
    id: randomUUID(),
    action: "screen-add",
    actor: "local-operator",
    entityId: next.id,
    entityType: "screen",
    message: `Added screen ${next.name}.`,
    result: "success",
    timestamp
  });

  return next;
}

export async function createScreenWithDevice(input: {
  group?: string;
  host: string;
  location?: string;
  name: string;
  playlistId?: string | null;
  sshUser?: string;
}): Promise<{
  device: DeviceRecord;
  screen: ScreenRecord;
}> {
  const [screenStore, deviceStore] = await Promise.all([readScreenStore(), readDeviceStore()]);
  const timestamp = isoNow();
  const screenId = `screen-${randomUUID()}`;
  const deviceId = `device-${randomUUID()}`;
  const screenName = input.name.trim();
  const group = input.group?.trim() || "General";
  const location = input.location?.trim() || "Unassigned";
  const screen: ScreenRecord = {
    deviceId,
    group,
    id: screenId,
    location,
    name: screenName,
    notes: "",
    playlistId: input.playlistId ?? null,
    updatedAt: timestamp
  };
  const device: DeviceRecord = {
    group,
    host: input.host.trim(),
    id: deviceId,
    location,
    name: `${screenName} Pi`,
    notes: "",
    playlistId: input.playlistId ?? null,
    playerType: "vlc",
    rootPath: "~",
    screenId,
    sshUser: input.sshUser?.trim() || "donnoel",
    updatedAt: timestamp
  };

  await writeScreenStore({
    ...screenStore,
    items: [...screenStore.items, screen],
    updatedAt: timestamp,
    version: screenStore.version + 1
  });
  await writeDeviceStore({
    ...deviceStore,
    items: [...deviceStore.items, device],
    updatedAt: timestamp,
    version: deviceStore.version + 1
  });

  await appendActivityRecord({
    id: randomUUID(),
    action: "screen-add",
    actor: "local-operator",
    entityId: screen.id,
    entityType: "screen",
    message: `Added screen ${screen.name} with Pi at ${device.host}.`,
    result: "success",
    timestamp
  });

  return { device, screen };
}

export async function createScreenForDevice(input: {
  deviceId: string;
  group?: string;
  host: string;
  location?: string;
  name: string;
  playlistId?: string | null;
  sshUser?: string;
}): Promise<{
  device: DeviceRecord;
  screen: ScreenRecord;
}> {
  const [screenStore, deviceStore] = await Promise.all([readScreenStore(), readDeviceStore()]);
  const deviceIndex = deviceStore.items.findIndex((item) => item.id === input.deviceId);
  if (deviceIndex === -1) {
    throw new Error("Device was not found.");
  }

  const timestamp = isoNow();
  const screenId = `screen-${randomUUID()}`;
  const screenName = input.name.trim();
  const group = input.group?.trim() || "General";
  const location = input.location?.trim() || "Unassigned";
  const screen: ScreenRecord = {
    deviceId: input.deviceId,
    group,
    id: screenId,
    location,
    name: screenName,
    notes: "",
    playlistId: input.playlistId ?? null,
    updatedAt: timestamp
  };
  const devices = [...deviceStore.items];
  devices[deviceIndex] = {
    ...devices[deviceIndex],
    group,
    host: input.host.trim(),
    location,
    name: `${screenName} Pi`,
    playlistId: input.playlistId ?? null,
    screenId,
    sshUser: input.sshUser?.trim() || devices[deviceIndex].sshUser || "donnoel",
    updatedAt: timestamp
  };

  await writeScreenStore({
    ...screenStore,
    items: [...screenStore.items, screen],
    updatedAt: timestamp,
    version: screenStore.version + 1
  });
  await writeDeviceStore({
    ...deviceStore,
    items: devices,
    updatedAt: timestamp,
    version: deviceStore.version + 1
  });

  await appendActivityRecord({
    id: randomUUID(),
    action: "screen-add",
    actor: "local-operator",
    entityId: screen.id,
    entityType: "screen",
    message: `Linked screen ${screen.name} to ${devices[deviceIndex].name} at ${devices[deviceIndex].host}.`,
    result: "success",
    timestamp
  });

  return { device: devices[deviceIndex], screen };
}

export async function createDevice(input: {
  group?: string;
  host: string;
  location?: string;
  name: string;
  playlistId?: string | null;
  screenId?: string | null;
  sshUser?: string;
}): Promise<DeviceRecord> {
  const store = await readDeviceStore();
  const timestamp = isoNow();
  const next: DeviceRecord = {
    group: input.group?.trim() || "General",
    host: input.host.trim(),
    id: `device-${randomUUID()}`,
    location: input.location?.trim() || "Unassigned",
    name: input.name.trim(),
    notes: "",
    playlistId: input.playlistId ?? null,
    playerType: "vlc",
    rootPath: "~",
    screenId: input.screenId ?? null,
    sshUser: input.sshUser?.trim() || "donnoel",
    updatedAt: timestamp
  };

  await writeDeviceStore({
    ...store,
    items: [...store.items, next],
    updatedAt: timestamp,
    version: store.version + 1
  });

  await appendActivityRecord({
    id: randomUUID(),
    action: "device-add",
    actor: "local-operator",
    entityId: next.id,
    entityType: "device",
    message: `Added device ${next.name} at ${next.host}.`,
    result: "success",
    timestamp
  });

  return next;
}

export async function removeScreen(screenId: string): Promise<void> {
  const [screenStore, deviceStore] = await Promise.all([readScreenStore(), readDeviceStore()]);
  const timestamp = isoNow();
  const target = screenStore.items.find((item) => item.id === screenId);
  if (!target) {
    throw new Error("Screen was not found.");
  }

  await writeScreenStore({
    ...screenStore,
    items: screenStore.items.filter((item) => item.id !== screenId),
    updatedAt: timestamp,
    version: screenStore.version + 1
  });

  const nextDevices = deviceStore.items.filter(
    (device) => device.screenId !== screenId && device.id !== target.deviceId
  );
  await writeDeviceStore({
    ...deviceStore,
    items: nextDevices,
    updatedAt: timestamp,
    version: deviceStore.version + 1
  });

  await repairSchedulesForScreens(screenStore.items.filter((item) => item.id !== screenId).map((item) => item.id));

  await appendActivityRecord({
    id: randomUUID(),
    action: "screen-remove",
    actor: "local-operator",
    entityId: screenId,
    entityType: "screen",
    message: `Removed screen ${target.name} and its linked Pi record.`,
    result: "success",
    timestamp
  });
}

export async function removeDevice(deviceId: string): Promise<void> {
  const [deviceStore, screenStore] = await Promise.all([readDeviceStore(), readScreenStore()]);
  const timestamp = isoNow();
  const target = deviceStore.items.find((item) => item.id === deviceId);
  if (!target) {
    throw new Error("Device was not found.");
  }

  await writeDeviceStore({
    ...deviceStore,
    items: deviceStore.items.filter((item) => item.id !== deviceId),
    updatedAt: timestamp,
    version: deviceStore.version + 1
  });

  const nextScreens = screenStore.items.map((screen) =>
    screen.deviceId === deviceId
      ? {
          ...screen,
          deviceId: null,
          updatedAt: timestamp
        }
      : screen
  );
  await writeScreenStore({
    ...screenStore,
    items: nextScreens,
    updatedAt: timestamp,
    version: screenStore.version + 1
  });

  await appendActivityRecord({
    id: randomUUID(),
    action: "device-remove",
    actor: "local-operator",
    entityId: deviceId,
    entityType: "device",
    message: `Removed device ${target.name}.`,
    result: "success",
    timestamp
  });
}
