import { randomUUID } from "node:crypto";
import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type {
  DeviceActionStatus,
  DeviceActionType,
  DeviceDiagnosticsStatus,
  DeviceRecord,
  DeviceResetStatus,
  DeviceStore,
  ScreenRecord,
  ScreenStore
} from "./local-data-store";
import {
  createDevice,
  createScreen,
  createScreenForDevice,
  createScreenWithDevice,
  readNormalizedInventory,
  removeDevice,
  removeScreen
} from "./local-inventory";
import { linkedDevicesForScreen, linkedScreensForDevice } from "./inventory-assignment";
import {
  appendActivityRecord,
  readDeviceStore,
  readScreenStore,
  writeDeviceStore,
  writeScreenStore
} from "./local-data-store";
import { activeWorkspaceId, requireActiveWorkspacePermission, withDefaultWorkspace, workspaceIdOrDefault } from "./workspace";

type InventoryStore = {
  devices: DeviceStore;
  screens: ScreenStore;
};

type CreateScreenInput = {
  deviceId?: string | null;
  group?: string;
  host?: string;
  location?: string;
  name: string;
  playlistId?: string | null;
  sshUser?: string;
};

type CreateDeviceInput = {
  group?: string;
  host: string;
  location?: string;
  name: string;
  playlistId?: string | null;
  screenId?: string | null;
  sshUser?: string;
};

type InventoryUpdateInput = {
  group?: string;
  id: string;
  location?: string;
  name?: string;
  playlistId?: string | null;
  targetType: "screen" | "device";
};

export type InventoryPublishTarget = {
  device: DeviceRecord | null;
  screen: ScreenRecord | null;
};

export type DeviceResetCommand = {
  id: string;
  requestedAt: string;
  status: "pending" | "running";
  statusUrl?: string;
  type: "reset-device";
};

export type DeviceActionCommand = {
  id: string;
  requestedAt: string;
  status: "pending" | "running";
  statusUrl?: string;
  type: DeviceActionType;
};

export type DeviceDiagnosticsCommand = {
  id: string;
  requestedAt: string;
  status: "pending" | "running";
  statusUrl?: string;
  type: "collect-diagnostics";
};

export type DeviceCommand = DeviceActionCommand | DeviceDiagnosticsCommand | DeviceResetCommand;

const dynamoDb = new DynamoDBClient({});
const maxDiagnosticsResultLength = 16_000;
const maxActionResultLength = 240_000;

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function cloudInventoryConfig(): { devicesTableName: string; screensTableName: string } | null {
  if (trimmedEnv("BEAM_DASHBOARD_MODE") !== "cloud") {
    return null;
  }

  const devicesTableName = trimmedEnv("BEAM_DEVICES_TABLE_NAME");
  const screensTableName = trimmedEnv("BEAM_SCREENS_TABLE_NAME");
  if (!devicesTableName || !screensTableName) {
    return null;
  }

  return { devicesTableName, screensTableName };
}

function isoNow(): string {
  return new Date().toISOString();
}

function screenWithPlaylistUpdate(screen: ScreenRecord, playlistId: string | null | undefined, timestamp: string): ScreenRecord {
  if (playlistId === undefined) {
    return {
      ...screen,
      updatedAt: timestamp
    };
  }

  return {
    ...screen,
    desiredReleaseId: playlistId === null ? null : screen.desiredReleaseId,
    desiredReleaseManifestChecksum: playlistId === null ? null : screen.desiredReleaseManifestChecksum,
    playlistId,
    publishedAt: playlistId === null ? null : screen.publishedAt,
    publishedPlaylistId: playlistId === null ? null : screen.publishedPlaylistId,
    publishedPlaylistVersion: playlistId === null ? null : screen.publishedPlaylistVersion,
    updatedAt: timestamp
  };
}

function deviceWithPlaylistUpdate(device: DeviceRecord, playlistId: string | null | undefined, timestamp: string): DeviceRecord {
  if (playlistId === undefined) {
    return {
      ...device,
      updatedAt: timestamp
    };
  }

  return {
    ...device,
    desiredReleaseId: playlistId === null ? null : device.desiredReleaseId,
    desiredReleaseManifestChecksum: playlistId === null ? null : device.desiredReleaseManifestChecksum,
    playlistId,
    publishedAt: playlistId === null ? null : device.publishedAt,
    publishedPlaylistId: playlistId === null ? null : device.publishedPlaylistId,
    publishedPlaylistVersion: playlistId === null ? null : device.publishedPlaylistVersion,
    updatedAt: timestamp
  };
}

function stringOrDefault(value: string | undefined | null, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function normalizedScreenName(value: string | undefined | null): string {
  return (value ?? "")
    .trim()
    .replace(/(?:\s+pi)+$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function displayScreenNameFromLink(value: string): string {
  return value.trim().replace(/(?:\s+pi)+$/i, "").trim() || value.trim();
}

function screenMatchesDeviceLink(screen: ScreenRecord, input: CreateScreenInput, existingDevice: DeviceRecord): boolean {
  if (screen.deviceId && screen.deviceId !== existingDevice.id) {
    return false;
  }

  if (existingDevice.screenId && screen.id === existingDevice.screenId) {
    return true;
  }

  const screenName = normalizedScreenName(screen.name);
  if (!screenName) {
    return false;
  }

  return screenName === normalizedScreenName(input.name);
}

function screenIsLinkedToDevice(screen: ScreenRecord, device: DeviceRecord): boolean {
  return screen.deviceId === device.id || Boolean(device.screenId && screen.id === device.screenId);
}

function unlinkedScreenMatchesName(screen: ScreenRecord, name: string): boolean {
  if (screen.deviceId) {
    return false;
  }

  return Boolean(normalizedScreenName(name)) && normalizedScreenName(screen.name) === normalizedScreenName(name);
}

function screenMatchesDeviceIdentity(screen: ScreenRecord, device: DeviceRecord): boolean {
  if (screen.deviceId && screen.deviceId !== device.id) {
    return false;
  }

  return screenIsLinkedToDevice(screen, device);
}

function preferredScreenForDeviceLink(
  screens: ScreenRecord[],
  input: CreateScreenInput,
  existingDevice: DeviceRecord
): ScreenRecord | null {
  const candidates = screens.filter((screen) => screenMatchesDeviceLink(screen, input, existingDevice));
  if (candidates.length === 0) {
    return null;
  }

  const inputName = normalizedScreenName(input.name);
  const exactCandidates = candidates.filter((screen) => normalizedScreenName(screen.name) === inputName);
  return (
    exactCandidates.find((screen) => !screen.deviceId) ??
    candidates.find((screen) => existingDevice.screenId && screen.id === existingDevice.screenId) ??
    exactCandidates[0] ??
    candidates[0] ??
    null
  );
}

function nullableString(value: string | undefined | null): AttributeValue {
  const trimmed = typeof value === "string" ? value.trim() : value;
  return trimmed ? { S: trimmed } : { NULL: true };
}

function stringAttribute(value: string): AttributeValue {
  return { S: value };
}

function numberAttribute(value: number): AttributeValue {
  return { N: String(value) };
}

function stringOrNullAttribute(value: AttributeValue | undefined): string | null {
  if (!value || value.NULL) {
    return null;
  }

  return value.S ?? null;
}

function stringAttributeOrDefault(value: AttributeValue | undefined, fallback: string): string {
  const candidate = stringOrNullAttribute(value);
  return candidate && candidate.trim() ? candidate : fallback;
}

function numberOrNullAttribute(value: AttributeValue | undefined): number | null {
  const parsed = value?.N ? Number(value.N) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function commandStatusOrNull(value: AttributeValue | undefined): DeviceActionStatus | null {
  const status = stringOrNullAttribute(value);
  return status === "failed" || status === "pending" || status === "running" || status === "succeeded"
    ? status
    : null;
}

function actionStatusOrNull(value: AttributeValue | undefined): DeviceActionStatus | null {
  return commandStatusOrNull(value);
}

function actionTypeOrNull(value: AttributeValue | undefined): DeviceActionType | null {
  const type = stringOrNullAttribute(value);
  return type === "mute-audio" ||
    type === "open-screen" ||
    type === "reboot-device" ||
    type === "restart-playback" ||
    type === "resume-playback" ||
    type === "run-recovery" ||
    type === "screen-snapshot" ||
    type === "show-desktop" ||
    type === "unmute-audio"
    ? type
    : null;
}

function diagnosticsStatusOrNull(value: AttributeValue | undefined): DeviceDiagnosticsStatus | null {
  return commandStatusOrNull(value);
}

function resetStatusOrNull(value: AttributeValue | undefined): DeviceResetStatus | null {
  return commandStatusOrNull(value);
}

function nullableNumber(value: number | undefined | null): AttributeValue {
  return typeof value === "number" && Number.isFinite(value) ? numberAttribute(value) : { NULL: true };
}

function screenToItem(screen: ScreenRecord): Record<string, AttributeValue> {
  const normalizedScreen = withDefaultWorkspace(screen);
  return {
    deviceId: nullableString(normalizedScreen.deviceId),
    desiredReleaseId: nullableString(normalizedScreen.desiredReleaseId),
    desiredReleaseManifestChecksum: nullableString(normalizedScreen.desiredReleaseManifestChecksum),
    group: stringAttribute(normalizedScreen.group),
    id: stringAttribute(normalizedScreen.id),
    location: stringAttribute(normalizedScreen.location),
    name: stringAttribute(normalizedScreen.name),
    notes: stringAttribute(normalizedScreen.notes),
    playlistId: nullableString(normalizedScreen.playlistId),
    publishedAt: nullableString(normalizedScreen.publishedAt),
    publishedPlaylistId: nullableString(normalizedScreen.publishedPlaylistId),
    publishedPlaylistVersion: nullableNumber(normalizedScreen.publishedPlaylistVersion),
    screenId: stringAttribute(normalizedScreen.id),
    updatedAt: stringAttribute(normalizedScreen.updatedAt),
    workspaceId: stringAttribute(normalizedScreen.workspaceId)
  };
}

function deviceToItem(device: DeviceRecord): Record<string, AttributeValue> {
  const normalizedDevice = withDefaultWorkspace(device);
  return {
    actionCommandId: nullableString(normalizedDevice.actionCommandId),
    actionFinishedAt: nullableString(normalizedDevice.actionFinishedAt),
    actionRequestedAt: nullableString(normalizedDevice.actionRequestedAt),
    actionResult: nullableString(normalizedDevice.actionResult),
    actionStartedAt: nullableString(normalizedDevice.actionStartedAt),
    actionStatus: nullableString(normalizedDevice.actionStatus),
    actionStatusMessage: nullableString(normalizedDevice.actionStatusMessage),
    actionType: nullableString(normalizedDevice.actionType),
    actionUpdatedAt: nullableString(normalizedDevice.actionUpdatedAt),
    deviceId: stringAttribute(normalizedDevice.id),
    desiredReleaseId: nullableString(normalizedDevice.desiredReleaseId),
    desiredReleaseManifestChecksum: nullableString(normalizedDevice.desiredReleaseManifestChecksum),
    group: stringAttribute(normalizedDevice.group),
    host: stringAttribute(normalizedDevice.host),
    id: stringAttribute(normalizedDevice.id),
    location: stringAttribute(normalizedDevice.location),
    name: stringAttribute(normalizedDevice.name),
    notes: stringAttribute(normalizedDevice.notes),
    playerType: stringAttribute(normalizedDevice.playerType),
    playlistId: nullableString(normalizedDevice.playlistId),
    publishedAt: nullableString(normalizedDevice.publishedAt),
    publishedPlaylistId: nullableString(normalizedDevice.publishedPlaylistId),
    publishedPlaylistVersion: nullableNumber(normalizedDevice.publishedPlaylistVersion),
    diagnosticsCommandId: nullableString(normalizedDevice.diagnosticsCommandId),
    diagnosticsFinishedAt: nullableString(normalizedDevice.diagnosticsFinishedAt),
    diagnosticsRequestedAt: nullableString(normalizedDevice.diagnosticsRequestedAt),
    diagnosticsResult: nullableString(normalizedDevice.diagnosticsResult),
    diagnosticsStartedAt: nullableString(normalizedDevice.diagnosticsStartedAt),
    diagnosticsStatus: nullableString(normalizedDevice.diagnosticsStatus),
    diagnosticsStatusMessage: nullableString(normalizedDevice.diagnosticsStatusMessage),
    diagnosticsUpdatedAt: nullableString(normalizedDevice.diagnosticsUpdatedAt),
    resetCommandId: nullableString(normalizedDevice.resetCommandId),
    resetFinishedAt: nullableString(normalizedDevice.resetFinishedAt),
    resetRequestedAt: nullableString(normalizedDevice.resetRequestedAt),
    resetStartedAt: nullableString(normalizedDevice.resetStartedAt),
    resetStatus: nullableString(normalizedDevice.resetStatus),
    resetStatusMessage: nullableString(normalizedDevice.resetStatusMessage),
    resetUpdatedAt: nullableString(normalizedDevice.resetUpdatedAt),
    rootPath: stringAttribute(normalizedDevice.rootPath),
    screenId: nullableString(normalizedDevice.screenId),
    sshUser: stringAttribute(normalizedDevice.sshUser),
    updatedAt: stringAttribute(normalizedDevice.updatedAt),
    workspaceId: stringAttribute(normalizedDevice.workspaceId)
  };
}

function screenFromItem(item: Record<string, AttributeValue>): ScreenRecord {
  const id = stringAttributeOrDefault(item.id ?? item.screenId, "screen-unknown");
  return {
    deviceId: stringOrNullAttribute(item.deviceId),
    desiredReleaseId: stringOrNullAttribute(item.desiredReleaseId),
    desiredReleaseManifestChecksum: stringOrNullAttribute(item.desiredReleaseManifestChecksum),
    group: stringAttributeOrDefault(item.group, "General"),
    id,
    location: stringAttributeOrDefault(item.location, "Unassigned"),
    name: stringAttributeOrDefault(item.name, "Unnamed Screen"),
    notes: stringAttributeOrDefault(item.notes, ""),
    playlistId: stringOrNullAttribute(item.playlistId),
    publishedAt: stringOrNullAttribute(item.publishedAt),
    publishedPlaylistId: stringOrNullAttribute(item.publishedPlaylistId),
    publishedPlaylistVersion: numberOrNullAttribute(item.publishedPlaylistVersion),
    updatedAt: stringAttributeOrDefault(item.updatedAt, isoNow()),
    workspaceId: workspaceIdOrDefault(stringOrNullAttribute(item.workspaceId))
  };
}

function deviceFromItem(item: Record<string, AttributeValue>): DeviceRecord {
  const id = stringAttributeOrDefault(item.id ?? item.deviceId, "device-unknown");
  return {
    actionCommandId: stringOrNullAttribute(item.actionCommandId),
    actionFinishedAt: stringOrNullAttribute(item.actionFinishedAt),
    actionRequestedAt: stringOrNullAttribute(item.actionRequestedAt),
    actionResult: stringOrNullAttribute(item.actionResult),
    actionStartedAt: stringOrNullAttribute(item.actionStartedAt),
    actionStatus: actionStatusOrNull(item.actionStatus),
    actionStatusMessage: stringOrNullAttribute(item.actionStatusMessage),
    actionType: actionTypeOrNull(item.actionType),
    actionUpdatedAt: stringOrNullAttribute(item.actionUpdatedAt),
    group: stringAttributeOrDefault(item.group, "General"),
    host: stringAttributeOrDefault(item.host, "Not configured"),
    id,
    location: stringAttributeOrDefault(item.location, "Unassigned"),
    name: stringAttributeOrDefault(item.name, "Unnamed Device"),
    notes: stringAttributeOrDefault(item.notes, ""),
    desiredReleaseId: stringOrNullAttribute(item.desiredReleaseId),
    desiredReleaseManifestChecksum: stringOrNullAttribute(item.desiredReleaseManifestChecksum),
    playlistId: stringOrNullAttribute(item.playlistId),
    playerType: "vlc",
    publishedAt: stringOrNullAttribute(item.publishedAt),
    publishedPlaylistId: stringOrNullAttribute(item.publishedPlaylistId),
    publishedPlaylistVersion: numberOrNullAttribute(item.publishedPlaylistVersion),
    diagnosticsCommandId: stringOrNullAttribute(item.diagnosticsCommandId),
    diagnosticsFinishedAt: stringOrNullAttribute(item.diagnosticsFinishedAt),
    diagnosticsRequestedAt: stringOrNullAttribute(item.diagnosticsRequestedAt),
    diagnosticsResult: stringOrNullAttribute(item.diagnosticsResult),
    diagnosticsStartedAt: stringOrNullAttribute(item.diagnosticsStartedAt),
    diagnosticsStatus: diagnosticsStatusOrNull(item.diagnosticsStatus),
    diagnosticsStatusMessage: stringOrNullAttribute(item.diagnosticsStatusMessage),
    diagnosticsUpdatedAt: stringOrNullAttribute(item.diagnosticsUpdatedAt),
    resetCommandId: stringOrNullAttribute(item.resetCommandId),
    resetFinishedAt: stringOrNullAttribute(item.resetFinishedAt),
    resetRequestedAt: stringOrNullAttribute(item.resetRequestedAt),
    resetStartedAt: stringOrNullAttribute(item.resetStartedAt),
    resetStatus: resetStatusOrNull(item.resetStatus),
    resetStatusMessage: stringOrNullAttribute(item.resetStatusMessage),
    resetUpdatedAt: stringOrNullAttribute(item.resetUpdatedAt),
    rootPath: stringAttributeOrDefault(item.rootPath, "~"),
    screenId: stringOrNullAttribute(item.screenId),
    sshUser: stringAttributeOrDefault(item.sshUser, "donnoel"),
    updatedAt: stringAttributeOrDefault(item.updatedAt, isoNow()),
    workspaceId: workspaceIdOrDefault(stringOrNullAttribute(item.workspaceId))
  };
}

async function queryWorkspaceItems(tableName: string): Promise<Record<string, AttributeValue>[]> {
  const items: Record<string, AttributeValue>[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamoDb.send(new QueryCommand({
      ExclusiveStartKey: exclusiveStartKey,
      ExpressionAttributeValues: {
        ":workspaceId": stringAttribute(activeWorkspaceId())
      },
      IndexName: "byWorkspace",
      KeyConditionExpression: "workspaceId = :workspaceId",
      TableName: tableName
    }));
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

function storeFromItems<TRecord extends { updatedAt: string }>(items: TRecord[]): {
  items: TRecord[];
  updatedAt: string;
  version: number;
} {
  return {
    items,
    updatedAt: items.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, ""),
    version: 1
  };
}

async function readCloudInventory(config: { devicesTableName: string; screensTableName: string }): Promise<InventoryStore> {
  const [screenItems, deviceItems] = await Promise.all([
    queryWorkspaceItems(config.screensTableName),
    queryWorkspaceItems(config.devicesTableName)
  ]);

  return {
    devices: storeFromItems(deviceItems.map(deviceFromItem)),
    screens: storeFromItems(screenItems.map(screenFromItem))
  };
}

function buildScreen(input: CreateScreenInput, timestamp: string, deviceId: string | null): ScreenRecord {
  return {
    deviceId,
    group: stringOrDefault(input.group, "General"),
    id: `screen-${randomUUID()}`,
    location: stringOrDefault(input.location, "Unassigned"),
    name: input.name.trim(),
    notes: "",
    playlistId: input.playlistId ?? null,
    updatedAt: timestamp
  };
}

function buildDevice(input: CreateDeviceInput, timestamp: string, screenId: string | null): DeviceRecord {
  return {
    group: stringOrDefault(input.group, "General"),
    host: input.host.trim(),
    id: `device-${randomUUID()}`,
    location: stringOrDefault(input.location, "Unassigned"),
    name: input.name.trim(),
    notes: "",
    playlistId: input.playlistId ?? null,
    playerType: "vlc",
    rootPath: "~",
    screenId,
    sshUser: stringOrDefault(input.sshUser, "donnoel"),
    updatedAt: timestamp
  };
}

async function createCloudScreen(config: { devicesTableName: string; screensTableName: string }, input: CreateScreenInput): Promise<void> {
  const timestamp = isoNow();

  if (input.host?.trim()) {
    const inventory = await readCloudInventory(config);
    const existingDevice = input.deviceId
      ? inventory.devices.items.find((device) => device.id === input.deviceId)
      : null;
    const existingScreen = existingDevice
      ? preferredScreenForDeviceLink(inventory.screens.items, input, existingDevice)
      : null;
    const staleScreens = existingDevice
      ? inventory.screens.items.filter((screen) =>
          screen.id !== existingScreen?.id &&
          (screenIsLinkedToDevice(screen, existingDevice) || unlinkedScreenMatchesName(screen, input.name))
        )
      : [];
    const screenId = existingScreen?.id ?? `screen-${randomUUID()}`;
    const screenName = existingScreen?.name ?? displayScreenNameFromLink(input.name);
    const deviceId =
      existingDevice?.id ??
      input.deviceId?.trim() ??
      trimmedEnv("BEAM_CLOUD_DEVICE_ID") ??
      `device-${randomUUID()}`;
    const group = stringOrDefault(input.group, "General");
    const location = stringOrDefault(input.location, "Unassigned");
    const screen: ScreenRecord = {
      deviceId,
      group,
      id: screenId,
      location,
      name: screenName,
      notes: "",
      playlistId: input.playlistId ?? null,
      publishedAt: null,
      publishedPlaylistId: null,
      publishedPlaylistVersion: null,
      updatedAt: timestamp
    };
    const device: DeviceRecord = {
      ...existingDevice,
      group,
      host: input.host.trim(),
      id: deviceId,
      location,
      name: `${screenName} Pi`,
      notes: existingDevice?.notes ?? "",
      playlistId: input.playlistId ?? null,
      playerType: "vlc",
      publishedAt: existingDevice?.publishedAt ?? null,
      publishedPlaylistId: existingDevice?.publishedPlaylistId ?? null,
      publishedPlaylistVersion: existingDevice?.publishedPlaylistVersion ?? null,
      rootPath: existingDevice?.rootPath ?? "~",
      screenId,
      sshUser: stringOrDefault(input.sshUser, "donnoel"),
      updatedAt: timestamp
    };

    await dynamoDb.send(new TransactWriteItemsCommand({
      TransactItems: [
        existingScreen
          ? {
              Put: {
                ConditionExpression: "attribute_exists(screenId)",
                Item: screenToItem(screen),
                TableName: config.screensTableName
              }
            }
          : {
              Put: {
                ConditionExpression: "attribute_not_exists(screenId)",
                Item: screenToItem(screen),
                TableName: config.screensTableName
              }
            },
        {
          Put: {
            ConditionExpression: existingDevice ? undefined : "attribute_not_exists(deviceId)",
            Item: deviceToItem(device),
            TableName: config.devicesTableName
          }
        },
        ...staleScreens.map((staleScreen) => ({
          Delete: {
            Key: { screenId: stringAttribute(staleScreen.id) },
            TableName: config.screensTableName
          }
        }))
      ]
    }));
    return;
  }

  const screen = buildScreen(input, timestamp, input.deviceId ?? null);
  await dynamoDb.send(new PutItemCommand({
    ConditionExpression: "attribute_not_exists(screenId)",
    Item: screenToItem(screen),
    TableName: config.screensTableName
  }));
}

async function createCloudDevice(config: { devicesTableName: string }, input: CreateDeviceInput): Promise<void> {
  const device = buildDevice(input, isoNow(), input.screenId ?? null);
  await dynamoDb.send(new PutItemCommand({
    ConditionExpression: "attribute_not_exists(deviceId)",
    Item: deviceToItem(device),
    TableName: config.devicesTableName
  }));
}

async function removeCloudScreen(config: { devicesTableName: string; screensTableName: string }, screenId: string): Promise<void> {
  const inventory = await readCloudInventory(config);
  const target = inventory.screens.items.find((screen) => screen.id === screenId);
  if (!target) {
    throw new Error("Screen was not found.");
  }

  const linkedDevices = inventory.devices.items.filter(
    (device) => device.screenId === screenId || device.id === target.deviceId
  );

  await dynamoDb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Delete: {
          Key: { screenId: stringAttribute(screenId) },
          TableName: config.screensTableName
        }
      },
      ...linkedDevices.map((device) => ({
        Delete: {
          Key: { deviceId: stringAttribute(device.id) },
          TableName: config.devicesTableName
        }
      }))
    ]
  }));
}

async function removeCloudDevice(config: { devicesTableName: string; screensTableName: string }, deviceId: string): Promise<void> {
  const inventory = await readCloudInventory(config);
  const target = inventory.devices.items.find((device) => device.id === deviceId);
  if (!target) {
    throw new Error("Device was not found.");
  }
  const timestamp = isoNow();

  await dynamoDb.send(new DeleteItemCommand({
    Key: { deviceId: stringAttribute(deviceId) },
    TableName: config.devicesTableName
  }));

  await Promise.all(
    inventory.screens.items
      .filter((screen) => screen.deviceId === deviceId)
      .map((screen) =>
        dynamoDb.send(new PutItemCommand({
          Item: screenToItem({
            ...screen,
            deviceId: null,
            updatedAt: timestamp
          }),
          TableName: config.screensTableName
        }))
      )
  );
}

async function updateCloudInventory(config: { devicesTableName: string; screensTableName: string }, input: InventoryUpdateInput): Promise<void> {
  const timestamp = isoNow();
  const inventory = await readCloudInventory(config);

  if (input.targetType === "screen") {
    const screen = inventory.screens.items.find((item) => item.id === input.id);
    if (!screen) {
      throw new Error("Screen was not found.");
    }
    if (input.name !== undefined && !input.name.trim()) {
      throw new Error("Screen name is required.");
    }

    const nextScreen = {
      ...screenWithPlaylistUpdate(screen, input.playlistId, timestamp),
      group: input.group === undefined ? screen.group : stringOrDefault(input.group, "General"),
      location: input.location === undefined ? screen.location : stringOrDefault(input.location, "Unassigned"),
      name: input.name?.trim() ?? screen.name
    };
    const writes: Promise<unknown>[] = [
      dynamoDb.send(new PutItemCommand({
        Item: screenToItem(nextScreen),
        TableName: config.screensTableName
      }))
    ];

    if (input.playlistId !== undefined) {
      const assignedPlaylistId = input.playlistId;
      writes.push(
        ...linkedDevicesForScreen(inventory.devices.items, screen).map((device) =>
          dynamoDb.send(new PutItemCommand({
            Item: deviceToItem({
              ...deviceWithPlaylistUpdate(device, assignedPlaylistId, timestamp)
            }),
            TableName: config.devicesTableName
          }))
        )
      );
    }

    await Promise.all(writes);
    return;
  }

  const device = inventory.devices.items.find((item) => item.id === input.id);
  if (!device) {
    throw new Error("Device was not found.");
  }

  const nextDevice = {
    ...deviceWithPlaylistUpdate(device, input.playlistId, timestamp)
  };
  const writes: Promise<unknown>[] = [
    dynamoDb.send(new PutItemCommand({
      Item: deviceToItem(nextDevice),
      TableName: config.devicesTableName
    }))
  ];

  if (input.playlistId !== undefined) {
    const assignedPlaylistId = input.playlistId;
    writes.push(
      ...linkedScreensForDevice(inventory.screens.items, device).map((screen) =>
        dynamoDb.send(new PutItemCommand({
          Item: screenToItem({
            ...screenWithPlaylistUpdate(screen, assignedPlaylistId, timestamp)
          }),
          TableName: config.screensTableName
        }))
      )
    );
  }

  await Promise.all(writes);
}

export async function readInventory(fallbackPlaylistId: string): Promise<InventoryStore> {
  const config = cloudInventoryConfig();
  return config ? readCloudInventory(config) : readNormalizedInventory(fallbackPlaylistId);
}

export async function ensureCloudCallHomeDevice(input: {
  deviceId: string;
  hostname?: string | null;
  localIpAddress?: string | null;
}): Promise<{ created: boolean; device: DeviceRecord | null }> {
  const config = cloudInventoryConfig();
  if (!config) {
    return { created: false, device: null };
  }

  const inventory = await readCloudInventory(config);
  const existingDevice = inventory.devices.items.find((device) => device.id === input.deviceId);
  const timestamp = isoNow();
  const localIpAddress = input.localIpAddress?.trim();
  if (existingDevice) {
    if (localIpAddress && existingDevice.host !== localIpAddress) {
      const nextDevice: DeviceRecord = {
        ...existingDevice,
        host: localIpAddress,
        updatedAt: timestamp
      };
      await dynamoDb.send(new PutItemCommand({
        Item: deviceToItem(nextDevice),
        TableName: config.devicesTableName
      }));
      return { created: false, device: nextDevice };
    }

    return { created: false, device: existingDevice };
  }

  const hostname = input.hostname?.trim();
  const device: DeviceRecord = {
    group: "Unassigned",
    host: localIpAddress || "Not configured",
    id: input.deviceId,
    location: "Unassigned",
    name: hostname ? `${hostname} Pi` : `${input.deviceId} Pi`,
    notes: "Created from device call-home.",
    playlistId: null,
    playerType: "vlc",
    rootPath: "~",
    screenId: null,
    sshUser: "donnoel",
    updatedAt: timestamp
  };

  await dynamoDb.send(new PutItemCommand({
    ConditionExpression: "attribute_not_exists(deviceId)",
    Item: deviceToItem(device),
    TableName: config.devicesTableName
  }));

  return { created: true, device };
}

export function isCloudInventoryConfigured(): boolean {
  return cloudInventoryConfig() !== null;
}

export async function resolveCloudPlaylistPublishTargets(input: {
  deviceId?: string | null;
  playlistId?: string | null;
  screenId?: string | null;
}): Promise<InventoryPublishTarget[]> {
  const config = cloudInventoryConfig();
  if (!config) {
    return [];
  }

  const inventory = await readCloudInventory(config);
  return publishTargetsForInventory(inventory, input);
}

function publishableCloudDevice(device: DeviceRecord): boolean {
  return Boolean(device.id.trim());
}

function publishTargetsForInventory(
  inventory: InventoryStore,
  input: {
    deviceId?: string | null;
    playlistId?: string | null;
    screenId?: string | null;
  }
): InventoryPublishTarget[] {
  if (input.deviceId) {
    const device = inventory.devices.items.find((item) => item.id === input.deviceId);
    const screen = device
      ? inventory.screens.items.find((item) => item.id === device.screenId || item.deviceId === device.id) ?? null
      : null;
    return device && publishableCloudDevice(device) ? [{ device, screen }] : [];
  }

  if (input.screenId) {
    const screen = inventory.screens.items.find((item) => item.id === input.screenId);
    const device = screen
      ? inventory.devices.items.find((item) => item.id === screen.deviceId || item.screenId === screen.id) ?? null
      : null;
    return device && publishableCloudDevice(device) ? [{ device, screen: screen ?? null }] : [];
  }

  if (!input.playlistId) {
    return [];
  }

  const screens = inventory.screens.items.filter((screen) => screen.playlistId === input.playlistId);
  const screenIds = new Set(screens.map((screen) => screen.id));
  const deviceIds = new Set(screens.map((screen) => screen.deviceId).filter((id): id is string => Boolean(id)));
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  const screenByDeviceId = new Map(screens.filter((screen) => screen.deviceId).map((screen) => [screen.deviceId as string, screen]));

  return inventory.devices.items
    .filter((device) =>
      publishableCloudDevice(device) &&
      (device.playlistId === input.playlistId ||
        deviceIds.has(device.id) ||
        (device.screenId ? screenIds.has(device.screenId) : false))
    )
    .map((device) => ({
      device,
      screen: screenByDeviceId.get(device.id) ?? (device.screenId ? screenById.get(device.screenId) ?? null : null)
    }));
}

export async function markCloudPlaylistPublished(input: {
  desiredReleaseId?: string | null;
  desiredReleaseManifestChecksum?: string | null;
  deviceId?: string | null;
  playlistId: string;
  playlistVersion: number;
  screenId?: string | null;
}): Promise<InventoryPublishTarget[]> {
  requireActiveWorkspacePermission("publish");
  const config = cloudInventoryConfig();
  if (!config) {
    return [];
  }

  const inventory = await readCloudInventory(config);
  const targets = publishTargetsForInventory(inventory, input);
  const timestamp = isoNow();

  await Promise.all(
    targets.flatMap((target) => {
      const writes: Promise<unknown>[] = [];
      if (target.screen) {
        writes.push(
          dynamoDb.send(new PutItemCommand({
            Item: screenToItem({
              ...target.screen,
              desiredReleaseId: input.desiredReleaseId ?? target.screen.desiredReleaseId ?? null,
              desiredReleaseManifestChecksum: input.desiredReleaseManifestChecksum ?? target.screen.desiredReleaseManifestChecksum ?? null,
              playlistId: input.playlistId,
              publishedAt: timestamp,
              publishedPlaylistId: input.playlistId,
              publishedPlaylistVersion: input.playlistVersion,
              updatedAt: timestamp
            }),
            TableName: config.screensTableName
          }))
        );
      }
      if (target.device) {
        writes.push(
          dynamoDb.send(new PutItemCommand({
            Item: deviceToItem({
              ...target.device,
              desiredReleaseId: input.desiredReleaseId ?? target.device.desiredReleaseId ?? null,
              desiredReleaseManifestChecksum: input.desiredReleaseManifestChecksum ?? target.device.desiredReleaseManifestChecksum ?? null,
              playlistId: input.playlistId,
              publishedAt: timestamp,
              publishedPlaylistId: input.playlistId,
              publishedPlaylistVersion: input.playlistVersion,
              updatedAt: timestamp
            }),
            TableName: config.devicesTableName
          }))
        );
      }
      return writes;
    })
  );

  return targets;
}

export function resetCommandForDevice(device: DeviceRecord, statusUrl?: string): DeviceResetCommand | null {
  if (
    !device.resetCommandId ||
    !device.resetRequestedAt ||
    (device.resetStatus !== "pending" && device.resetStatus !== "running")
  ) {
    return null;
  }

  return {
    id: device.resetCommandId,
    requestedAt: device.resetRequestedAt,
    status: device.resetStatus,
    statusUrl,
    type: "reset-device"
  };
}

export function actionCommandForDevice(device: DeviceRecord, statusUrl?: string): DeviceActionCommand | null {
  if (
    !device.actionCommandId ||
    !device.actionRequestedAt ||
    !device.actionType ||
    (device.actionStatus !== "pending" && device.actionStatus !== "running")
  ) {
    return null;
  }

  return {
    id: device.actionCommandId,
    requestedAt: device.actionRequestedAt,
    status: device.actionStatus,
    statusUrl,
    type: device.actionType
  };
}

export function diagnosticsCommandForDevice(device: DeviceRecord, statusUrl?: string): DeviceDiagnosticsCommand | null {
  if (
    !device.diagnosticsCommandId ||
    !device.diagnosticsRequestedAt ||
    (device.diagnosticsStatus !== "pending" && device.diagnosticsStatus !== "running")
  ) {
    return null;
  }

  return {
    id: device.diagnosticsCommandId,
    requestedAt: device.diagnosticsRequestedAt,
    status: device.diagnosticsStatus,
    statusUrl,
    type: "collect-diagnostics"
  };
}

export function commandForDevice(device: DeviceRecord, input: {
  actionStatusUrl?: string;
  diagnosticsStatusUrl?: string;
  resetStatusUrl?: string;
}): DeviceCommand | null {
  return resetCommandForDevice(device, input.resetStatusUrl) ??
    actionCommandForDevice(device, input.actionStatusUrl) ??
    diagnosticsCommandForDevice(device, input.diagnosticsStatusUrl);
}

function hasActiveCommand(device: DeviceRecord): boolean {
  return device.resetStatus === "pending" ||
    device.resetStatus === "running" ||
    device.actionStatus === "pending" ||
    device.actionStatus === "running" ||
    device.diagnosticsStatus === "pending" ||
    device.diagnosticsStatus === "running";
}

function actionLabel(type: DeviceActionType): string {
  if (type === "mute-audio") {
    return "Mute audio";
  }
  if (type === "unmute-audio") {
    return "Unmute audio";
  }
  if (type === "open-screen") {
    return "Open store";
  }
  if (type === "restart-playback") {
    return "Restart playback";
  }
  if (type === "show-desktop") {
    return "Show desktop";
  }
  if (type === "resume-playback") {
    return "Resume playback";
  }
  if (type === "run-recovery") {
    return "Full recovery";
  }
  if (type === "screen-snapshot") {
    return "Snapshot";
  }
  return "Reboot";
}

export async function requestDeviceReset(deviceId: string): Promise<DeviceRecord> {
  requireActiveWorkspacePermission("recover");
  const config = cloudInventoryConfig();
  if (!config) {
    throw new Error("Cloud inventory is required for remote Pi reset.");
  }

  const inventory = await readCloudInventory(config);
  const device = inventory.devices.items.find((item) => item.id === deviceId);
  if (!device) {
    throw new Error("Device was not found.");
  }
  if (hasActiveCommand(device)) {
    throw new Error("Another remote command is already queued or running for this device.");
  }

  const timestamp = isoNow();
  const nextDevice: DeviceRecord = {
    ...device,
    resetCommandId: randomUUID(),
    resetFinishedAt: null,
    resetRequestedAt: timestamp,
    resetStartedAt: null,
    resetStatus: "pending",
    resetStatusMessage: "Reset is queued. The Pi will run it on its next cloud check-in.",
    resetUpdatedAt: timestamp,
    updatedAt: timestamp
  };

  await dynamoDb.send(new PutItemCommand({
    Item: deviceToItem(nextDevice),
    TableName: config.devicesTableName
  }));

  return nextDevice;
}

export async function requestDeviceAction(deviceId: string, actionType: DeviceActionType): Promise<DeviceRecord> {
  requireActiveWorkspacePermission("recover");
  const config = cloudInventoryConfig();
  if (!config) {
    throw new Error("Cloud inventory is required for remote Pi actions.");
  }

  const inventory = await readCloudInventory(config);
  const device = inventory.devices.items.find((item) => item.id === deviceId);
  if (!device) {
    throw new Error("Device was not found.");
  }
  if (hasActiveCommand(device)) {
    throw new Error("Another remote command is already queued or running for this device.");
  }

  const timestamp = isoNow();
  const label = actionLabel(actionType);
  const nextDevice: DeviceRecord = {
    ...device,
    actionCommandId: randomUUID(),
    actionFinishedAt: null,
    actionRequestedAt: timestamp,
    actionStartedAt: null,
    actionStatus: "pending",
    actionStatusMessage: `${label} is queued. The Pi will run it on its next cloud check-in.`,
    actionType,
    actionUpdatedAt: timestamp,
    updatedAt: timestamp
  };

  await dynamoDb.send(new PutItemCommand({
    Item: deviceToItem(nextDevice),
    TableName: config.devicesTableName
  }));

  return nextDevice;
}

export async function requestDeviceDiagnostics(deviceId: string): Promise<DeviceRecord> {
  requireActiveWorkspacePermission("recover");
  const config = cloudInventoryConfig();
  if (!config) {
    throw new Error("Cloud inventory is required for remote Pi diagnostics.");
  }

  const inventory = await readCloudInventory(config);
  const device = inventory.devices.items.find((item) => item.id === deviceId);
  if (!device) {
    throw new Error("Device was not found.");
  }
  if (hasActiveCommand(device)) {
    throw new Error("Another remote command is already queued or running for this device.");
  }

  const timestamp = isoNow();
  const nextDevice: DeviceRecord = {
    ...device,
    diagnosticsCommandId: randomUUID(),
    diagnosticsFinishedAt: null,
    diagnosticsRequestedAt: timestamp,
    diagnosticsResult: null,
    diagnosticsStartedAt: null,
    diagnosticsStatus: "pending",
    diagnosticsStatusMessage: "Remote diagnostics are queued. The Pi will collect read-only evidence on its next cloud check-in.",
    diagnosticsUpdatedAt: timestamp,
    updatedAt: timestamp
  };

  await dynamoDb.send(new PutItemCommand({
    Item: deviceToItem(nextDevice),
    TableName: config.devicesTableName
  }));

  return nextDevice;
}

function cappedDiagnosticsResult(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > maxDiagnosticsResultLength
    ? `${trimmed.slice(0, maxDiagnosticsResultLength)}\n...diagnostics result truncated...`
    : trimmed;
}

function cappedActionResult(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > maxActionResultLength
    ? JSON.stringify({
        kind: "action-result-too-large",
        message: "The Pi returned a result that was too large for Beam to store.",
        originalLength: trimmed.length
      })
    : trimmed;
}

export async function updateDeviceDiagnosticsStatus(input: {
  commandId: string;
  deviceId: string;
  finishedAt?: string | null;
  message?: string | null;
  result?: string | null;
  startedAt?: string | null;
  status: DeviceDiagnosticsStatus;
}): Promise<DeviceRecord> {
  requireActiveWorkspacePermission("recover");
  const config = cloudInventoryConfig();
  if (!config) {
    throw new Error("Cloud inventory is required for remote Pi diagnostics.");
  }

  const inventory = await readCloudInventory(config);
  const device = inventory.devices.items.find((item) => item.id === input.deviceId);
  if (!device) {
    throw new Error("Device was not found.");
  }
  if (device.diagnosticsCommandId !== input.commandId) {
    throw new Error("Diagnostics command does not match the current pending command.");
  }

  const timestamp = isoNow();
  const finished = input.status === "succeeded" || input.status === "failed";
  const nextDevice: DeviceRecord = {
    ...device,
    diagnosticsFinishedAt: input.finishedAt ?? (finished ? timestamp : null),
    diagnosticsResult: cappedDiagnosticsResult(input.result) ?? device.diagnosticsResult ?? null,
    diagnosticsStartedAt: input.startedAt ?? device.diagnosticsStartedAt ?? (input.status === "running" ? timestamp : null),
    diagnosticsStatus: input.status,
    diagnosticsStatusMessage: input.message?.trim() || (
      input.status === "running"
        ? "Remote diagnostics are running on the Pi."
        : input.status === "succeeded"
          ? "Remote diagnostics completed."
          : input.status === "failed"
            ? "Remote diagnostics failed on the Pi."
            : "Remote diagnostics are queued."
    ),
    diagnosticsUpdatedAt: timestamp,
    updatedAt: timestamp
  };

  await dynamoDb.send(new PutItemCommand({
    Item: deviceToItem(nextDevice),
    TableName: config.devicesTableName
  }));

  return nextDevice;
}

export async function updateDeviceActionStatus(input: {
  commandId: string;
  deviceId: string;
  finishedAt?: string | null;
  message?: string | null;
  result?: string | null;
  startedAt?: string | null;
  status: DeviceActionStatus;
}): Promise<DeviceRecord> {
  requireActiveWorkspacePermission("recover");
  const config = cloudInventoryConfig();
  if (!config) {
    throw new Error("Cloud inventory is required for remote Pi actions.");
  }

  const inventory = await readCloudInventory(config);
  const device = inventory.devices.items.find((item) => item.id === input.deviceId);
  if (!device) {
    throw new Error("Device was not found.");
  }
  if (device.actionCommandId !== input.commandId) {
    throw new Error("Remote action command does not match the current pending command.");
  }

  const timestamp = isoNow();
  const finished = input.status === "succeeded" || input.status === "failed";
  const label = device.actionType ? actionLabel(device.actionType) : "Remote action";
  const nextDevice: DeviceRecord = {
    ...device,
    actionFinishedAt: input.finishedAt ?? (finished ? timestamp : null),
    actionResult: cappedActionResult(input.result) ?? device.actionResult ?? null,
    actionStartedAt: input.startedAt ?? device.actionStartedAt ?? (input.status === "running" ? timestamp : null),
    actionStatus: input.status,
    actionStatusMessage: input.message?.trim() || (
      input.status === "running"
        ? `${label} is running on the Pi.`
        : input.status === "succeeded"
          ? `${label} completed.`
          : input.status === "failed"
            ? `${label} failed on the Pi.`
            : `${label} is queued.`
    ),
    actionUpdatedAt: timestamp,
    updatedAt: timestamp
  };

  await dynamoDb.send(new PutItemCommand({
    Item: deviceToItem(nextDevice),
    TableName: config.devicesTableName
  }));

  return nextDevice;
}

export async function updateDeviceResetStatus(input: {
  commandId: string;
  deviceId: string;
  finishedAt?: string | null;
  message?: string | null;
  startedAt?: string | null;
  status: DeviceResetStatus;
}): Promise<DeviceRecord> {
  requireActiveWorkspacePermission("recover");
  const config = cloudInventoryConfig();
  if (!config) {
    throw new Error("Cloud inventory is required for remote Pi reset.");
  }

  const inventory = await readCloudInventory(config);
  const device = inventory.devices.items.find((item) => item.id === input.deviceId);
  if (!device) {
    throw new Error("Device was not found.");
  }
  if (device.resetCommandId !== input.commandId) {
    throw new Error("Reset command does not match the current pending command.");
  }

  const timestamp = isoNow();
  const resetSucceeded = input.status === "succeeded";
  const staleResetScreens = resetSucceeded
    ? inventory.screens.items.filter((screen) => screenMatchesDeviceIdentity(screen, device))
    : [];
  const nextDevice: DeviceRecord = {
    ...device,
    desiredReleaseId: resetSucceeded ? null : device.desiredReleaseId,
    desiredReleaseManifestChecksum: resetSucceeded ? null : device.desiredReleaseManifestChecksum,
    playlistId: resetSucceeded ? null : device.playlistId,
    publishedAt: resetSucceeded ? null : device.publishedAt,
    publishedPlaylistId: resetSucceeded ? null : device.publishedPlaylistId,
    publishedPlaylistVersion: resetSucceeded ? null : device.publishedPlaylistVersion,
    resetFinishedAt: input.finishedAt ?? (resetSucceeded || input.status === "failed" ? timestamp : null),
    resetStartedAt: input.startedAt ?? device.resetStartedAt ?? (input.status === "running" ? timestamp : null),
    resetStatus: input.status,
    resetStatusMessage: input.message?.trim() || (
      input.status === "running"
        ? "Reset is running on the Pi."
        : input.status === "succeeded"
          ? "Reset completed. Device is ready to redeploy."
          : input.status === "failed"
            ? "Reset failed on the Pi."
            : "Reset is queued."
    ),
    resetUpdatedAt: timestamp,
    screenId: resetSucceeded ? null : device.screenId,
    updatedAt: timestamp
  };

  const writes: Promise<unknown>[] = [
    dynamoDb.send(new PutItemCommand({
      Item: deviceToItem(nextDevice),
      TableName: config.devicesTableName
    }))
  ];

  if (staleResetScreens.length > 0) {
    writes.push(
      ...staleResetScreens.map((screen) =>
        dynamoDb.send(new DeleteItemCommand({
          Key: { screenId: stringAttribute(screen.id) },
          TableName: config.screensTableName
        }))
      )
    );
  }

  await Promise.all(writes);
  return nextDevice;
}

export async function createInventoryScreen(input: CreateScreenInput): Promise<void> {
  requireActiveWorkspacePermission("write");
  const config = cloudInventoryConfig();
  if (config) {
    await createCloudScreen(config, input);
    return;
  }

  if (input.deviceId?.trim() && input.host?.trim()) {
    await createScreenForDevice({
      deviceId: input.deviceId,
      group: input.group,
      host: input.host,
      location: input.location,
      name: input.name,
      playlistId: input.playlistId ?? null,
      sshUser: input.sshUser
    });
    return;
  }

  if (input.host?.trim()) {
    await createScreenWithDevice({
      group: input.group,
      host: input.host,
      location: input.location,
      name: input.name,
      playlistId: input.playlistId ?? null,
      sshUser: input.sshUser
    });
    return;
  }

  await createScreen({
    deviceId: input.deviceId ?? null,
    group: input.group,
    location: input.location,
    name: input.name,
    playlistId: input.playlistId ?? null
  });
}

export async function createInventoryDevice(input: CreateDeviceInput): Promise<void> {
  requireActiveWorkspacePermission("write");
  const config = cloudInventoryConfig();
  if (config) {
    await createCloudDevice(config, input);
    return;
  }

  await createDevice(input);
}

export async function removeInventoryScreen(screenId: string): Promise<void> {
  requireActiveWorkspacePermission("write");
  const config = cloudInventoryConfig();
  if (config) {
    await removeCloudScreen(config, screenId);
    return;
  }

  await removeScreen(screenId);
}

export async function removeInventoryDevice(deviceId: string): Promise<void> {
  requireActiveWorkspacePermission("write");
  const config = cloudInventoryConfig();
  if (config) {
    await removeCloudDevice(config, deviceId);
    return;
  }

  await removeDevice(deviceId);
}

export async function updateInventory(input: InventoryUpdateInput): Promise<void> {
  requireActiveWorkspacePermission("write");
  const config = cloudInventoryConfig();
  if (config) {
    await updateCloudInventory(config, input);
    return;
  }

  const timestamp = isoNow();
  if (input.targetType === "screen") {
    const store = await readScreenStore();
    const index = store.items.findIndex((item) => item.id === input.id);
    if (index === -1) {
      throw new Error("Screen was not found.");
    }
    const nextName = typeof input.name === "string" ? input.name.trim() : undefined;
    if (input.name !== undefined && !nextName) {
      throw new Error("Screen name is required.");
    }
    const nextGroup = input.group === undefined ? undefined : stringOrDefault(input.group, "General");
    const nextLocation = input.location === undefined ? undefined : stringOrDefault(input.location, "Unassigned");
    const nextItems = [...store.items];
    const previous = nextItems[index];
    nextItems[index] = {
      ...screenWithPlaylistUpdate(previous, input.playlistId, timestamp),
      group: nextGroup ?? previous.group,
      location: nextLocation ?? previous.location,
      name: nextName ?? previous.name
    };
    await writeScreenStore({
      ...store,
      items: nextItems,
      updatedAt: timestamp,
      version: store.version + 1
    });
    const detailChanges = [
      nextName && nextName !== previous.name ? `name ${previous.name} to ${nextName}` : null,
      nextGroup && nextGroup !== previous.group ? `group ${previous.group} to ${nextGroup}` : null,
      nextLocation && nextLocation !== previous.location ? `location ${previous.location} to ${nextLocation}` : null
    ].filter((item): item is string => Boolean(item));
    if (detailChanges.length > 0) {
      await appendActivityRecord({
        id: randomUUID(),
        action: nextName && nextName !== previous.name ? "screen-rename" : "screen-update",
        actor: "local-operator",
        entityId: previous.id,
        entityType: "screen",
        message: `Updated screen ${previous.name}: ${detailChanges.join("; ")}.`,
        result: "success",
        timestamp
      });
    }
    return;
  }

  const store = await readDeviceStore();
  const index = store.items.findIndex((item) => item.id === input.id);
  if (index === -1) {
    throw new Error("Device was not found.");
  }
  const nextItems = [...store.items];
  nextItems[index] = deviceWithPlaylistUpdate(nextItems[index], input.playlistId, timestamp);
  await writeDeviceStore({
    ...store,
    items: nextItems,
    updatedAt: timestamp,
    version: store.version + 1
  });
}
