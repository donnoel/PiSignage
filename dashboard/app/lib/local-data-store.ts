import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { localStateDirectory, writeFileAtomic } from "./local-playlist";
import {
  activeWorkspaceId,
  defaultWorkspaceId,
  filterWorkspaceItems,
  requireActiveWorkspacePermission,
  withDefaultWorkspace
} from "./workspace";

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
  playbackStorageBucket?: string;
  preparedAt?: string;
  sourceObjectKey?: string;
  sourceStorageBucket?: string;
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
  desiredReleaseId?: string | null;
  desiredReleaseManifestChecksum?: string | null;
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

export type DeviceCommandStatus = "failed" | "pending" | "running" | "succeeded";
export type DeviceActionType = "mute-audio" | "open-screen" | "reboot-device" | "restart-playback" | "resume-playback" | "run-recovery" | "screen-snapshot" | "show-desktop" | "unmute-audio";
export type DeviceActionStatus = DeviceCommandStatus;
export type DeviceDiagnosticsStatus = DeviceCommandStatus;
export type DeviceResetStatus = DeviceCommandStatus;

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
  actionCommandId?: string | null;
  actionFinishedAt?: string | null;
  actionRequestedAt?: string | null;
  actionResult?: string | null;
  actionStartedAt?: string | null;
  actionStatus?: DeviceActionStatus | null;
  actionStatusMessage?: string | null;
  actionType?: DeviceActionType | null;
  actionUpdatedAt?: string | null;
  desiredReleaseId?: string | null;
  desiredReleaseManifestChecksum?: string | null;
  publishedAt?: string | null;
  publishedPlaylistId?: string | null;
  publishedPlaylistVersion?: number | null;
  diagnosticsCommandId?: string | null;
  diagnosticsFinishedAt?: string | null;
  diagnosticsRequestedAt?: string | null;
  diagnosticsResult?: string | null;
  diagnosticsStartedAt?: string | null;
  diagnosticsStatus?: DeviceDiagnosticsStatus | null;
  diagnosticsStatusMessage?: string | null;
  diagnosticsUpdatedAt?: string | null;
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
  entityType: "media" | "screen" | "device" | "playlist" | "schedule" | "system";
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
  mediaFolders: string;
  media: string;
  recovery: string;
  schedules: string;
  screens: string;
  settings: string;
};

const dynamoDb = new DynamoDBClient({});
const scheduleStoreRecordType = "schedule-store";

function isoNow(): string {
  return new Date().toISOString();
}

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function cloudScheduleConfig(): { assetsTableName: string } | null {
  if (trimmedEnv("BEAM_DASHBOARD_MODE") !== "cloud") {
    return null;
  }

  const assetsTableName = trimmedEnv("BEAM_ASSETS_TABLE_NAME");
  return assetsTableName ? { assetsTableName } : null;
}

function stringAttribute(value: string): AttributeValue {
  return { S: value };
}

function numberAttribute(value: number): AttributeValue {
  return { N: String(value) };
}

function stringOrNull(value: AttributeValue | undefined): string | null {
  if (!value || value.NULL) {
    return null;
  }

  return value.S ?? null;
}

function numberOrDefault(value: AttributeValue | undefined, fallback: number): number {
  const parsed = value?.N ? Number(value.N) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scheduleStoreRecordId(): string {
  return `schedule-store#${activeWorkspaceId()}`;
}

function normalizeScheduleStore(store: ScheduleStore): ScheduleStore {
  return {
    ...store,
    items: Array.isArray(store.items) ? filterWorkspaceItems(store.items) : [],
    updatedAt: typeof store.updatedAt === "string" ? store.updatedAt : isoNow(),
    version: typeof store.version === "number" ? store.version : 1
  };
}

function parseScheduleStoreJson(value: AttributeValue | undefined): ScheduleStore {
  const fallback = defaultScheduleStore();
  const json = stringOrNull(value);
  if (!json) {
    return fallback;
  }

  try {
    return normalizeScheduleStore(JSON.parse(json) as ScheduleStore);
  } catch {
    return fallback;
  }
}

async function readCloudScheduleStore(config: { assetsTableName: string }): Promise<ScheduleStore> {
  const result = await dynamoDb.send(new GetItemCommand({
    Key: { assetId: stringAttribute(scheduleStoreRecordId()) },
    TableName: config.assetsTableName
  }));

  if (!result.Item || stringOrNull(result.Item.recordType) !== scheduleStoreRecordType) {
    return defaultScheduleStore();
  }

  const store = parseScheduleStoreJson(result.Item.scheduleStoreJson);
  return {
    ...store,
    updatedAt: stringOrNull(result.Item.updatedAt) ?? store.updatedAt,
    version: numberOrDefault(result.Item.version, store.version)
  };
}

async function writeCloudScheduleStore(config: { assetsTableName: string }, value: ScheduleStore): Promise<void> {
  const workspaceId = activeWorkspaceId();
  const normalizedStore: ScheduleStore = {
    ...value,
    items: value.items.map(withDefaultWorkspace),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : isoNow(),
    version: typeof value.version === "number" ? value.version : 1
  };

  await dynamoDb.send(new PutItemCommand({
    Item: {
      accountId: stringAttribute("beam-dev"),
      assetId: stringAttribute(scheduleStoreRecordId()),
      id: stringAttribute(scheduleStoreRecordId()),
      recordType: stringAttribute(scheduleStoreRecordType),
      scheduleStoreJson: stringAttribute(JSON.stringify(normalizedStore)),
      updatedAt: stringAttribute(normalizedStore.updatedAt),
      version: numberAttribute(normalizedStore.version),
      workspaceId: stringAttribute(workspaceId)
    },
    TableName: config.assetsTableName
  }));
}

function jsonStorePaths(): JsonStorePaths {
  const root = localStateDirectory();
  return {
    activity: path.join(root, "activity.local.json"),
    devices: path.join(root, "devices.local.json"),
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
    items: Array.isArray(store.items) ? filterWorkspaceItems(store.items) : []
  };
}

export async function writeMediaStore(value: MediaStore): Promise<void> {
  requireActiveWorkspacePermission("write");
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
    items: Array.isArray(store.items) ? filterWorkspaceItems(store.items) : []
  };
}

export async function writeMediaFolderStore(value: MediaFolderStore): Promise<void> {
  requireActiveWorkspacePermission("write");
  const paths = jsonStorePaths();
  await writeJsonStore(paths.mediaFolders, {
    ...value,
    items: value.items.map(withDefaultWorkspace)
  });
}

export async function readScreenStore(): Promise<ScreenStore> {
  const paths = jsonStorePaths();
  const store = await readJsonOrDefaults(paths.screens, defaultScreenStore());
  return {
    ...store,
    items: Array.isArray(store.items) ? filterWorkspaceItems(store.items) : []
  };
}

export async function writeScreenStore(value: ScreenStore): Promise<void> {
  requireActiveWorkspacePermission("write");
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
    items: Array.isArray(store.items) ? filterWorkspaceItems(store.items) : []
  };
}

export async function writeDeviceStore(value: DeviceStore): Promise<void> {
  requireActiveWorkspacePermission("write");
  const paths = jsonStorePaths();
  await writeJsonStore(paths.devices, {
    ...value,
    items: value.items.map(withDefaultWorkspace)
  });
}

export async function readScheduleStore(): Promise<ScheduleStore> {
  const config = cloudScheduleConfig();
  if (config) {
    return readCloudScheduleStore(config);
  }

  const paths = jsonStorePaths();
  const store = await readJsonOrDefaults(paths.schedules, defaultScheduleStore());
  return normalizeScheduleStore(store);
}

export function scheduleStorePath(): string {
  return jsonStorePaths().schedules;
}

export async function writeScheduleStore(value: ScheduleStore): Promise<void> {
  requireActiveWorkspacePermission("write");
  const config = cloudScheduleConfig();
  if (config) {
    await writeCloudScheduleStore(config, value);
    return;
  }

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
    items: Array.isArray(store.items) ? filterWorkspaceItems(store.items) : []
  };
}

export async function writeActivityStore(value: ActivityStore): Promise<void> {
  requireActiveWorkspacePermission("activity");
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
    runs: Array.isArray(store.runs) ? filterWorkspaceItems(store.runs) : []
  };
}

export async function writeRecoveryStore(value: RecoveryStore): Promise<void> {
  requireActiveWorkspacePermission("recover");
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
  requireActiveWorkspacePermission("admin");
  const paths = jsonStorePaths();
  await writeJsonStore(paths.settings, withDefaultWorkspace(value));
}
