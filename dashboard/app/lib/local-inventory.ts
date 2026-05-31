import { randomUUID } from "node:crypto";
import type { DeviceRecord, DeviceStore, ScreenRecord, ScreenStore } from "./local-data-store";
import {
  appendActivityRecord,
  readDeviceStore,
  readScreenStore,
  writeDeviceStore,
  writeScreenStore
} from "./local-data-store";

type InventorySeed = {
  host: string | null;
  location: string;
  playlistId: string;
  rootPath: string | null;
  screenName: string;
  sshUser: string | null;
};

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
    sshUser: typeof device.sshUser === "string" && device.sshUser.trim() ? device.sshUser.trim() : "pi"
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

export async function ensureInventorySeed(seed: InventorySeed): Promise<{
  devices: DeviceStore;
  screens: ScreenStore;
}> {
  const [rawScreens, rawDevices] = await Promise.all([readScreenStore(), readDeviceStore()]);
  let screens = normalizeScreenStore(rawScreens, seed.playlistId);
  let devices = normalizeDeviceStore(rawDevices, seed.playlistId);
  const timestamp = isoNow();
  let screensUpdated = recordsChanged(rawScreens.items, screens.items);
  let devicesUpdated = recordsChanged(rawDevices.items, devices.items);

  if (screens.items.length === 0) {
    screens = {
      ...screens,
      items: [
        {
          deviceId: "device-primary",
          group: "Primary",
          id: "screen-primary",
          location: seed.location,
          name: seed.screenName,
          notes: "",
          playlistId: seed.playlistId,
          updatedAt: timestamp
        }
      ],
      updatedAt: timestamp,
      version: screens.version + 1
    };
    screensUpdated = true;
  } else if (screensUpdated) {
    screens = {
      ...screens,
      updatedAt: timestamp,
      version: screens.version + 1
    };
  }

  if (devices.items.length === 0) {
    devices = {
      ...devices,
      items: [
        {
          group: "Primary",
          host: seed.host ?? "Not configured",
          id: "device-primary",
          location: seed.location,
          name: "Primary Device",
          notes: "",
          playlistId: seed.playlistId,
          playerType: "vlc",
          rootPath: seed.rootPath ?? "~",
          screenId: screens.items[0]?.id ?? null,
          sshUser: seed.sshUser ?? "pi",
          updatedAt: timestamp
        }
      ],
      updatedAt: timestamp,
      version: devices.version + 1
    };
    devicesUpdated = true;
  } else if (devicesUpdated) {
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
    sshUser: input.sshUser?.trim() || "pi",
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

  const nextDevices = deviceStore.items.map((device) =>
    device.screenId === screenId
      ? {
          ...device,
          screenId: null,
          updatedAt: timestamp
        }
      : device
  );
  await writeDeviceStore({
    ...deviceStore,
    items: nextDevices,
    updatedAt: timestamp,
    version: deviceStore.version + 1
  });

  await appendActivityRecord({
    id: randomUUID(),
    action: "screen-remove",
    actor: "local-operator",
    entityId: screenId,
    entityType: "screen",
    message: `Removed screen ${target.name}.`,
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
