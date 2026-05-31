import { promises as fs } from "node:fs";
import path from "node:path";
import { localStateDirectory, writeFileAtomic } from "./local-playlist";

export type MediaRecord = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  sourceFileName: string;
  playbackFileName: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  status: "ready" | "processing" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type MediaStore = {
  items: MediaRecord[];
  updatedAt: string;
  version: number;
};

export type ScreenRecord = {
  deviceId: string | null;
  group: string;
  id: string;
  location: string;
  name: string;
  notes: string;
  playlistId: string | null;
  updatedAt: string;
};

export type ScreenStore = {
  items: ScreenRecord[];
  updatedAt: string;
  version: number;
};

export type DeviceRecord = {
  group: string;
  host: string;
  id: string;
  location: string;
  name: string;
  notes: string;
  playlistId: string | null;
  playerType: "vlc";
  rootPath: string;
  screenId: string | null;
  sshUser: string;
  updatedAt: string;
};

export type DeviceStore = {
  items: DeviceRecord[];
  updatedAt: string;
  version: number;
};

export type ScheduleRule = {
  daysOfWeek: number[];
  endTime: string;
  startTime: string;
};

export type ScheduleRecord = {
  id: string;
  name: string;
  rules: ScheduleRule[];
  screenIds: string[];
  timezone: string;
  updatedAt: string;
};

export type ScheduleStore = {
  items: ScheduleRecord[];
  updatedAt: string;
  version: number;
};

export type ActivityRecord = {
  action: string;
  actor: string;
  entityId: string;
  entityType: "media" | "screen" | "device" | "playlist" | "schedule" | "system";
  id: string;
  message: string;
  result: "success" | "warning" | "error";
  timestamp: string;
};

export type ActivityStore = {
  items: ActivityRecord[];
  updatedAt: string;
  version: number;
};

export type SettingsRecord = {
  defaultImageDurationSeconds: number;
  defaultScheduleTimezone: string;
  maxUploadBytes: number;
  preferredPlaybackMode: "vlc";
  updatedAt: string;
};

export type RecoveryStep = {
  detail: string;
  finishedAt: string;
  id: string;
  startedAt: string;
  status: "failed" | "succeeded";
  title: string;
};

export type RecoveryRun = {
  finishedAt: string;
  id: string;
  startedAt: string;
  steps: RecoveryStep[];
  summary: string;
  triggeredBy: string;
  ok: boolean;
};

export type RecoveryStore = {
  runs: RecoveryRun[];
  updatedAt: string;
  version: number;
};

type JsonStorePaths = {
  activity: string;
  devices: string;
  media: string;
  recovery: string;
  schedules: string;
  screens: string;
  settings: string;
};

function isoNow(): string {
  return new Date().toISOString();
}

function jsonStorePaths(): JsonStorePaths {
  const root = localStateDirectory();
  return {
    activity: path.join(root, "activity.local.json"),
    devices: path.join(root, "devices.local.json"),
    media: path.join(root, "media.local.json"),
    recovery: path.join(root, "recovery.local.json"),
    schedules: path.join(root, "schedules.local.json"),
    screens: path.join(root, "screens.local.json"),
    settings: path.join(root, "settings.local.json")
  };
}

function defaultMediaStore(): MediaStore {
  return {
    items: [],
    updatedAt: isoNow(),
    version: 1
  };
}

function defaultScreenStore(): ScreenStore {
  return {
    items: [],
    updatedAt: isoNow(),
    version: 1
  };
}

function defaultDeviceStore(): DeviceStore {
  return {
    items: [],
    updatedAt: isoNow(),
    version: 1
  };
}

function defaultScheduleStore(): ScheduleStore {
  return {
    items: [],
    updatedAt: isoNow(),
    version: 1
  };
}

function defaultActivityStore(): ActivityStore {
  return {
    items: [],
    updatedAt: isoNow(),
    version: 1
  };
}

function defaultRecoveryStore(): RecoveryStore {
  return {
    runs: [],
    updatedAt: isoNow(),
    version: 1
  };
}

function defaultSettingsRecord(): SettingsRecord {
  return {
    defaultImageDurationSeconds: 10,
    defaultScheduleTimezone: "America/Los_Angeles",
    maxUploadBytes: 1024 * 1024 * 1024,
    preferredPlaybackMode: "vlc",
    updatedAt: isoNow()
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureJsonFile<TStore>(filePath: string, defaults: TStore): Promise<void> {
  if (await pathExists(filePath)) {
    return;
  }

  await writeFileAtomic(filePath, `${JSON.stringify(defaults, null, 2)}\n`);
}

async function readJsonOrDefaults<TStore>(filePath: string, defaults: TStore): Promise<TStore> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as TStore;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return defaults;
    }

    throw error;
  }
}

async function writeJsonStore<TStore>(filePath: string, value: TStore): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function ensureLocalDataFoundation(): Promise<void> {
  const paths = jsonStorePaths();

  await fs.mkdir(localStateDirectory(), { recursive: true });
  await Promise.all([
    ensureJsonFile(paths.media, defaultMediaStore()),
    ensureJsonFile(paths.screens, defaultScreenStore()),
    ensureJsonFile(paths.devices, defaultDeviceStore()),
    ensureJsonFile(paths.schedules, defaultScheduleStore()),
    ensureJsonFile(paths.activity, defaultActivityStore()),
    ensureJsonFile(paths.recovery, defaultRecoveryStore()),
    ensureJsonFile(paths.settings, defaultSettingsRecord())
  ]);
}

export async function readMediaStore(): Promise<MediaStore> {
  const paths = jsonStorePaths();
  return readJsonOrDefaults(paths.media, defaultMediaStore());
}

export async function writeMediaStore(value: MediaStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.media, value);
}

export async function readScreenStore(): Promise<ScreenStore> {
  const paths = jsonStorePaths();
  return readJsonOrDefaults(paths.screens, defaultScreenStore());
}

export async function writeScreenStore(value: ScreenStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.screens, value);
}

export async function readDeviceStore(): Promise<DeviceStore> {
  const paths = jsonStorePaths();
  return readJsonOrDefaults(paths.devices, defaultDeviceStore());
}

export async function writeDeviceStore(value: DeviceStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.devices, value);
}

export async function readScheduleStore(): Promise<ScheduleStore> {
  const paths = jsonStorePaths();
  return readJsonOrDefaults(paths.schedules, defaultScheduleStore());
}

export async function writeScheduleStore(value: ScheduleStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.schedules, value);
}

export async function readActivityStore(): Promise<ActivityStore> {
  const paths = jsonStorePaths();
  return readJsonOrDefaults(paths.activity, defaultActivityStore());
}

export async function writeActivityStore(value: ActivityStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.activity, value);
}

export async function readRecoveryStore(): Promise<RecoveryStore> {
  const paths = jsonStorePaths();
  return readJsonOrDefaults(paths.recovery, defaultRecoveryStore());
}

export async function writeRecoveryStore(value: RecoveryStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.recovery, value);
}

export async function appendRecoveryRun(run: RecoveryRun): Promise<void> {
  const store = await readRecoveryStore();
  const nextStore: RecoveryStore = {
    ...store,
    runs: [run, ...store.runs].slice(0, 200),
    updatedAt: isoNow(),
    version: store.version + 1
  };
  await writeRecoveryStore(nextStore);
}

export async function appendActivityRecord(record: ActivityRecord): Promise<void> {
  const store = await readActivityStore();
  const nextStore: ActivityStore = {
    ...store,
    items: [record, ...store.items].slice(0, 1000),
    updatedAt: isoNow(),
    version: store.version + 1
  };
  await writeActivityStore(nextStore);
}

export async function readSettingsRecord(): Promise<SettingsRecord> {
  const paths = jsonStorePaths();
  return readJsonOrDefaults(paths.settings, defaultSettingsRecord());
}

export async function writeSettingsRecord(value: SettingsRecord): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.settings, value);
}
