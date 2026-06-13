import { randomUUID } from "node:crypto";
import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { DeviceRecord, DeviceResetStatus, DeviceStore, ScreenRecord, ScreenStore } from "./local-data-store";
import {
  createDevice,
  createScreen,
  createScreenForDevice,
  createScreenWithDevice,
  readNormalizedInventory,
  removeDevice,
  removeScreen
} from "./local-inventory";
import {
  appendActivityRecord,
  readDeviceStore,
  readScreenStore,
  writeDeviceStore,
  writeScreenStore
} from "./local-data-store";
import { filterWorkspaceItems, requireActiveWorkspacePermission, withDefaultWorkspace, workspaceIdOrDefault } from "./workspace";

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
  id: string;
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

const dynamoDb = new DynamoDBClient({});

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

function stringOrDefault(value: string | undefined | null, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
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

function resetStatusOrNull(value: AttributeValue | undefined): DeviceResetStatus | null {
  const status = stringOrNullAttribute(value);
  return status === "failed" || status === "pending" || status === "running" || status === "succeeded"
    ? status
    : null;
}

function nullableNumber(value: number | undefined | null): AttributeValue {
  return typeof value === "number" && Number.isFinite(value) ? numberAttribute(value) : { NULL: true };
}

function screenToItem(screen: ScreenRecord): Record<string, AttributeValue> {
  const normalizedScreen = withDefaultWorkspace(screen);
  return {
    deviceId: nullableString(normalizedScreen.deviceId),
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
    deviceId: stringAttribute(normalizedDevice.id),
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
    group: stringAttributeOrDefault(item.group, "General"),
    host: stringAttributeOrDefault(item.host, "Not configured"),
    id,
    location: stringAttributeOrDefault(item.location, "Unassigned"),
    name: stringAttributeOrDefault(item.name, "Unnamed Device"),
    notes: stringAttributeOrDefault(item.notes, ""),
    playlistId: stringOrNullAttribute(item.playlistId),
    playerType: "vlc",
    publishedAt: stringOrNullAttribute(item.publishedAt),
    publishedPlaylistId: stringOrNullAttribute(item.publishedPlaylistId),
    publishedPlaylistVersion: numberOrNullAttribute(item.publishedPlaylistVersion),
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

async function scanAllItems(tableName: string): Promise<Record<string, AttributeValue>[]> {
  const items: Record<string, AttributeValue>[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamoDb.send(new ScanCommand({
      ExclusiveStartKey: exclusiveStartKey,
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
    scanAllItems(config.screensTableName),
    scanAllItems(config.devicesTableName)
  ]);

  return {
    devices: storeFromItems(filterWorkspaceItems(deviceItems.map(deviceFromItem))),
    screens: storeFromItems(filterWorkspaceItems(screenItems.map(screenFromItem)))
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
    const screenId = `screen-${randomUUID()}`;
    const deviceId =
      existingDevice?.id ??
      input.deviceId?.trim() ??
      trimmedEnv("BEAM_CLOUD_DEVICE_ID") ??
      `device-${randomUUID()}`;
    const screenName = input.name.trim();
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
        {
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
        }
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

  if (input.targetType === "screen") {
    const inventory = await readCloudInventory(config);
    const screen = inventory.screens.items.find((item) => item.id === input.id);
    if (!screen) {
      throw new Error("Screen was not found.");
    }
    if (input.name !== undefined && !input.name.trim()) {
      throw new Error("Screen name is required.");
    }

    await dynamoDb.send(new PutItemCommand({
      Item: screenToItem({
        ...screen,
        name: input.name?.trim() ?? screen.name,
        playlistId: input.playlistId === undefined ? screen.playlistId : input.playlistId,
        updatedAt: timestamp
      }),
      TableName: config.screensTableName
    }));
    return;
  }

  const inventory = await readCloudInventory(config);
  const device = inventory.devices.items.find((item) => item.id === input.id);
  if (!device) {
    throw new Error("Device was not found.");
  }

  await dynamoDb.send(new PutItemCommand({
    Item: deviceToItem({
      ...device,
      playlistId: input.playlistId === undefined ? device.playlistId : input.playlistId,
      updatedAt: timestamp
    }),
    TableName: config.devicesTableName
  }));
}

export async function readInventory(fallbackPlaylistId: string): Promise<InventoryStore> {
  const config = cloudInventoryConfig();
  return config ? readCloudInventory(config) : readNormalizedInventory(fallbackPlaylistId);
}

export function isCloudInventoryConfigured(): boolean {
  return cloudInventoryConfig() !== null;
}

function configuredDevice(device: DeviceRecord): boolean {
  return Boolean(device.host.trim()) && device.host !== "Not configured";
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
    return device && configuredDevice(device) ? [{ device, screen }] : [];
  }

  if (input.screenId) {
    const screen = inventory.screens.items.find((item) => item.id === input.screenId);
    const device = screen
      ? inventory.devices.items.find((item) => item.id === screen.deviceId || item.screenId === screen.id) ?? null
      : null;
    return device && configuredDevice(device) ? [{ device, screen: screen ?? null }] : [];
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
      configuredDevice(device) &&
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
  const linkedScreen = inventory.screens.items.find((screen) =>
    screen.deviceId === device.id || screen.id === device.screenId
  ) ?? null;
  const resetSucceeded = input.status === "succeeded";
  const nextDevice: DeviceRecord = {
    ...device,
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

  if (resetSucceeded && linkedScreen) {
    writes.push(
      dynamoDb.send(new PutItemCommand({
        Item: screenToItem({
          ...linkedScreen,
          deviceId: null,
          playlistId: null,
          publishedAt: null,
          publishedPlaylistId: null,
          publishedPlaylistVersion: null,
          updatedAt: timestamp
        }),
        TableName: config.screensTableName
      }))
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
    const nextItems = [...store.items];
    const previous = nextItems[index];
    nextItems[index] = {
      ...previous,
      name: nextName ?? previous.name,
      playlistId: input.playlistId === undefined ? previous.playlistId : input.playlistId,
      updatedAt: timestamp
    };
    await writeScreenStore({
      ...store,
      items: nextItems,
      updatedAt: timestamp,
      version: store.version + 1
    });
    if (nextName && nextName !== previous.name) {
      await appendActivityRecord({
        id: randomUUID(),
        action: "screen-rename",
        actor: "local-operator",
        entityId: previous.id,
        entityType: "screen",
        message: `Renamed screen ${previous.name} to ${nextName}.`,
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
  nextItems[index] = {
    ...nextItems[index],
    playlistId: input.playlistId === undefined ? nextItems[index].playlistId : input.playlistId,
    updatedAt: timestamp
  };
  await writeDeviceStore({
    ...store,
    items: nextItems,
    updatedAt: timestamp,
    version: store.version + 1
  });
}
