import { promises as fs } from "node:fs";
import path from "node:path";
import { validateLayoutTemplate } from "./layout-contract";
import { localStateDirectory, writeFileAtomic } from "./local-playlist";
import type { LayoutStore, LayoutTemplate } from "./layout-contract";
import { defaultWorkspaceId, withDefaultWorkspace, workspaceIdOrDefault } from "./workspace";

export type MediaRecord = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  sourceFileName: string;
  playbackFileName: string;
  mimeType: string;
  sizeBytes: number;
  sourceSizeBytes?: number;
  durationSeconds: number | null;
  checksumSha256?: string;
  cloudStatusDetail?: string;
  playbackProfile?: string;
  playbackObjectKey?: string;
  preparedAt?: string;
  sourceObjectKey?: string;
  storageBucket?: string;
  storageProvider?: "local" | "s3";
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  videoCodec?: string | null;
  videoProfile?: string | null;
  pixelFormat?: string | null;
  audioCodec?: string | null;
  bitRate?: number | null;
  status: "ready" | "processing" | "failed";
  createdAt: string;
  updatedAt: string;
  workspaceId?: string;
};

export type MediaStore = {
  items: MediaRecord[];
  updatedAt: string;
  version: number;
};

export type MediaFolderRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  workspaceId?: string;
};

export type MediaFolderStore = {
  assignments: Record<string, string | null>;
  items: MediaFolderRecord[];
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
  publishedAt?: string | null;
  publishedPlaylistId?: string | null;
  publishedPlaylistVersion?: number | null;
  updatedAt: string;
  workspaceId?: string;
};

export type ScreenStore = {
  items: ScreenRecord[];
  updatedAt: string;
  version: number;
};

export type DeviceResetStatus = "failed" | "pending" | "running" | "succeeded";

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
  publishedAt?: string | null;
  publishedPlaylistId?: string | null;
  publishedPlaylistVersion?: number | null;
  resetCommandId?: string | null;
  resetFinishedAt?: string | null;
  resetRequestedAt?: string | null;
  resetStartedAt?: string | null;
  resetStatus?: DeviceResetStatus | null;
  resetStatusMessage?: string | null;
  resetUpdatedAt?: string | null;
  updatedAt: string;
  workspaceId?: string;
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
  workspaceId?: string;
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
  entityType: "media" | "screen" | "device" | "playlist" | "layout" | "schedule" | "system";
  id: string;
  message: string;
  result: "success" | "warning" | "error";
  timestamp: string;
  workspaceId?: string;
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
  workspaceId?: string;
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
  workspaceId?: string;
};

export type RecoveryStore = {
  runs: RecoveryRun[];
  updatedAt: string;
  version: number;
};

type JsonStorePaths = {
  activity: string;
  devices: string;
  layouts: string;
  mediaFolders: string;
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
    layouts: path.join(root, "layouts.local.json"),
    mediaFolders: path.join(root, "media-folders.local.json"),
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

function defaultMediaFolderStore(): MediaFolderStore {
  return {
    assignments: {},
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

function defaultLayoutStore(): LayoutStore {
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
    updatedAt: isoNow(),
    workspaceId: defaultWorkspaceId
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
    ensureJsonFile(paths.mediaFolders, defaultMediaFolderStore()),
    ensureJsonFile(paths.layouts, defaultLayoutStore()),
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
  const store = await readJsonOrDefaults(paths.media, defaultMediaStore());
  return {
    ...store,
    items: Array.isArray(store.items) ? store.items.map(withDefaultWorkspace) : []
  };
}

export async function writeMediaStore(value: MediaStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.media, {
    ...value,
    items: value.items.map(withDefaultWorkspace)
  });
}

export async function readMediaFolderStore(): Promise<MediaFolderStore> {
  const paths = jsonStorePaths();
  const store = await readJsonOrDefaults(paths.mediaFolders, defaultMediaFolderStore());
  return {
    ...store,
    assignments: store.assignments ?? {},
    items: Array.isArray(store.items) ? store.items.map(withDefaultWorkspace) : []
  };
}

export async function writeMediaFolderStore(value: MediaFolderStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.mediaFolders, {
    ...value,
    items: value.items.map(withDefaultWorkspace)
  });
}

function normalizeLayoutStore(store: LayoutStore): LayoutStore {
  if (!Array.isArray(store.items)) {
    throw new Error("Layout library is malformed.");
  }

  const items: LayoutTemplate[] = [];
  const errors: string[] = [];

  store.items.forEach((item, index) => {
    const candidate = {
      ...item,
      workspaceId: workspaceIdOrDefault(item.workspaceId)
    };
    const result = validateLayoutTemplate(candidate);
    if (result.ok) {
      items.push(result.value);
    } else {
      errors.push(`Layout ${index + 1}: ${result.errors.join(" ")}`);
    }
  });

  if (errors.length > 0) {
    throw new Error(`Layout library is malformed. ${errors.join(" ")}`);
  }

  return {
    items,
    updatedAt: typeof store.updatedAt === "string" ? store.updatedAt : isoNow(),
    version: typeof store.version === "number" ? store.version : 1
  };
}

export async function readLayoutStore(): Promise<LayoutStore> {
  const paths = jsonStorePaths();
  return normalizeLayoutStore(await readJsonOrDefaults(paths.layouts, defaultLayoutStore()));
}

export async function writeLayoutStore(value: LayoutStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.layouts, normalizeLayoutStore(value));
}

export async function readScreenStore(): Promise<ScreenStore> {
  const paths = jsonStorePaths();
  const store = await readJsonOrDefaults(paths.screens, defaultScreenStore());
  return {
    ...store,
    items: Array.isArray(store.items) ? store.items.map(withDefaultWorkspace) : []
  };
}

export async function writeScreenStore(value: ScreenStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.screens, {
    ...value,
    items: value.items.map(withDefaultWorkspace)
  });
}

export async function readDeviceStore(): Promise<DeviceStore> {
  const paths = jsonStorePaths();
  const store = await readJsonOrDefaults(paths.devices, defaultDeviceStore());
  return {
    ...store,
    items: Array.isArray(store.items) ? store.items.map(withDefaultWorkspace) : []
  };
}

export async function writeDeviceStore(value: DeviceStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.devices, {
    ...value,
    items: value.items.map(withDefaultWorkspace)
  });
}

export async function readScheduleStore(): Promise<ScheduleStore> {
  const paths = jsonStorePaths();
  const store = await readJsonOrDefaults(paths.schedules, defaultScheduleStore());
  return {
    ...store,
    items: Array.isArray(store.items) ? store.items.map(withDefaultWorkspace) : []
  };
}

export function scheduleStorePath(): string {
  return jsonStorePaths().schedules;
}

export async function writeScheduleStore(value: ScheduleStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.schedules, {
    ...value,
    items: value.items.map(withDefaultWorkspace)
  });
}

export async function readActivityStore(): Promise<ActivityStore> {
  const paths = jsonStorePaths();
  const store = await readJsonOrDefaults(paths.activity, defaultActivityStore());
  return {
    ...store,
    items: Array.isArray(store.items) ? store.items.map(withDefaultWorkspace) : []
  };
}

export async function writeActivityStore(value: ActivityStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.activity, {
    ...value,
    items: value.items.map(withDefaultWorkspace)
  });
}

export async function readRecoveryStore(): Promise<RecoveryStore> {
  const paths = jsonStorePaths();
  const store = await readJsonOrDefaults(paths.recovery, defaultRecoveryStore());
  return {
    ...store,
    runs: Array.isArray(store.runs) ? store.runs.map(withDefaultWorkspace) : []
  };
}

export async function writeRecoveryStore(value: RecoveryStore): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.recovery, {
    ...value,
    runs: value.runs.map(withDefaultWorkspace)
  });
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
  const settings = await readJsonOrDefaults(paths.settings, defaultSettingsRecord());
  return withDefaultWorkspace(settings);
}

export async function writeSettingsRecord(value: SettingsRecord): Promise<void> {
  const paths = jsonStorePaths();
  await writeJsonStore(paths.settings, withDefaultWorkspace(value));
}
