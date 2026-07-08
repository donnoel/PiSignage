import { BatchGetItemCommand, DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export type CloudHeartbeat = {
  accountId: string | null;
  appVersion: string | null;
  currentAssetId: string | null;
  currentPlaylistId: string | null;
  deviceId: string | null;
  diskFreeBytes: number | null;
  hostname: string | null;
  localIpAddress: string | null;
  networkOnline: boolean;
  playbackState: string | null;
  playlistVersion: number | null;
  receivedAt: string | null;
  scheduleDetail: string | null;
  scheduleDisplayAction: string | null;
  scheduleDisplayControlOk: boolean | null;
  scheduleOverrideExpiresAt: string | null;
  scheduleState: string | null;
  timestamp: string | null;
};

export type CloudHeartbeatState = {
  configured: boolean;
  deviceId: string;
  fetchedAt: string | null;
  heartbeat: CloudHeartbeat | null;
  message: string;
  ok: boolean;
  status: "available" | "error" | "not_configured" | "not_found";
};

const dynamoDb = new DynamoDBClient({});

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function cloudDeviceId(): string {
  return trimmedEnv("BEAM_CLOUD_DEVICE_ID") ?? trimmedEnv("PISIGNAGE_DEVICE_ID") ?? "device-local-demo";
}

function heartbeatsTableName(): string | null {
  return trimmedEnv("BEAM_HEARTBEATS_TABLE_NAME");
}

function numberOrNull(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function heartbeatFromDynamoItem(item: Record<string, AttributeValue>): CloudHeartbeat {
  return {
    accountId: item.accountId?.S ?? null,
    appVersion: item.appVersion?.S ?? null,
    currentAssetId: item.currentAssetId?.S ?? null,
    currentPlaylistId: item.currentPlaylistId?.S ?? null,
    deviceId: item.deviceId?.S ?? null,
    diskFreeBytes: item.diskFreeBytes?.NULL ? null : numberOrNull(item.diskFreeBytes?.N),
    hostname: item.hostname?.S ?? null,
    localIpAddress: item.localIpAddress?.S ?? null,
    networkOnline: item.networkOnline?.BOOL ?? false,
    playbackState: item.playbackState?.S ?? null,
    playlistVersion: item.playlistVersion?.NULL ? null : numberOrNull(item.playlistVersion?.N),
    receivedAt: item.receivedAt?.S ?? null,
    scheduleDetail: item.scheduleDetail?.S ?? null,
    scheduleDisplayAction: item.scheduleDisplayAction?.S ?? null,
    scheduleDisplayControlOk: item.scheduleDisplayControlOk?.NULL ? null : item.scheduleDisplayControlOk?.BOOL ?? null,
    scheduleOverrideExpiresAt: item.scheduleOverrideExpiresAt?.S ?? null,
    scheduleState: item.scheduleState?.S ?? null,
    timestamp: item.timestamp?.S ?? null
  };
}

function notConfiguredState(deviceId: string): CloudHeartbeatState {
  return {
    configured: false,
    deviceId,
    fetchedAt: null,
    heartbeat: null,
    message: "Set BEAM_HEARTBEATS_TABLE_NAME on the dashboard server to read AWS heartbeat status.",
    ok: false,
    status: "not_configured"
  };
}

function heartbeatStateFromHeartbeat(deviceId: string, fetchedAt: string, heartbeat: CloudHeartbeat | null): CloudHeartbeatState {
  if (!heartbeat) {
    return {
      configured: true,
      deviceId,
      fetchedAt,
      heartbeat: null,
      message: "AWS has not recorded a heartbeat for this device yet.",
      ok: false,
      status: "not_found"
    };
  }

  return {
    configured: true,
    deviceId,
    fetchedAt,
    heartbeat,
    message: "Latest AWS heartbeat read from DynamoDB.",
    ok: true,
    status: "available"
  };
}

export async function readCloudHeartbeats(deviceIds: string[]): Promise<Record<string, CloudHeartbeatState>> {
  const uniqueDeviceIds = [...new Set(deviceIds.map((id) => id.trim()).filter(Boolean))];
  const tableName = heartbeatsTableName();
  const fetchedAt = new Date().toISOString();

  if (uniqueDeviceIds.length === 0) {
    return {};
  }

  if (!tableName) {
    return Object.fromEntries(uniqueDeviceIds.map((deviceId) => [deviceId, notConfiguredState(deviceId)]));
  }

  try {
    const result = await dynamoDb.send(new BatchGetItemCommand({
      RequestItems: {
        [tableName]: {
          ConsistentRead: true,
          Keys: uniqueDeviceIds.map((deviceId) => ({
            deviceId: { S: deviceId }
          }))
        }
      }
    }));
    const heartbeatsByDeviceId = new Map(
      (result.Responses?.[tableName] ?? [])
        .map(heartbeatFromDynamoItem)
        .filter((heartbeat): heartbeat is CloudHeartbeat & { deviceId: string } => Boolean(heartbeat.deviceId))
        .map((heartbeat) => [heartbeat.deviceId, heartbeat])
    );

    return Object.fromEntries(
      uniqueDeviceIds.map((deviceId) => [
        deviceId,
        heartbeatStateFromHeartbeat(deviceId, fetchedAt, heartbeatsByDeviceId.get(deviceId) ?? null)
      ])
    );
  } catch (error) {
    return Object.fromEntries(
      uniqueDeviceIds.map((deviceId) => [
        deviceId,
        {
          configured: true,
          deviceId,
          fetchedAt,
          heartbeat: null,
          message: error instanceof Error ? error.message : "AWS heartbeat read failed.",
          ok: false,
          status: "error"
        }
      ])
    );
  }
}

export async function readCloudHeartbeat(): Promise<CloudHeartbeatState> {
  const deviceId = cloudDeviceId();
  const tableName = heartbeatsTableName();
  const fetchedAt = new Date().toISOString();

  if (!tableName) {
    return notConfiguredState(deviceId);
  }

  try {
    const result = await dynamoDb.send(new GetItemCommand({
      ConsistentRead: true,
      Key: {
        deviceId: { S: deviceId }
      },
      TableName: tableName
    }));

    if (!result.Item) {
      return {
        configured: true,
        deviceId,
        fetchedAt,
        heartbeat: null,
        message: "AWS has not recorded a heartbeat for this device yet.",
        ok: false,
        status: "not_found"
      };
    }

    return {
      configured: true,
      deviceId,
      fetchedAt,
      heartbeat: heartbeatFromDynamoItem(result.Item),
      message: "Latest AWS heartbeat read from DynamoDB.",
      ok: true,
      status: "available"
    };
  } catch (error) {
    return {
      configured: true,
      deviceId,
      fetchedAt,
      heartbeat: null,
      message: error instanceof Error ? error.message : "AWS heartbeat read failed.",
      ok: false,
      status: "error"
    };
  }
}
