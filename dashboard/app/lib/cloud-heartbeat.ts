import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export type CloudHeartbeat = {
  accountId: string | null;
  appVersion: string | null;
  currentAssetId: string | null;
  currentPlaylistId: string | null;
  deviceId: string | null;
  diskFreeBytes: number | null;
  networkOnline: boolean;
  receivedAt: string | null;
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

type CloudHeartbeatResponse = {
  heartbeat?: CloudHeartbeat;
  error?: {
    code?: string;
    message?: string;
  };
};

const cloudHeartbeatTimeoutMs = 4_000;
const dynamoDb = new DynamoDBClient({});

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function cloudApiUrl(): string | null {
  const rawUrl = trimmedEnv("BEAM_CLOUD_API_URL") ?? trimmedEnv("PISIGNAGE_CLOUD_API_URL");
  return rawUrl ? rawUrl.replace(/\/+$/, "") : null;
}

function cloudApiKey(): string | null {
  return trimmedEnv("BEAM_CLOUD_API_KEY") ?? trimmedEnv("PISIGNAGE_CLOUD_API_KEY");
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
    networkOnline: item.networkOnline?.BOOL ?? false,
    receivedAt: item.receivedAt?.S ?? null,
    timestamp: item.timestamp?.S ?? null
  };
}

function notConfiguredState(deviceId: string): CloudHeartbeatState {
  return {
    configured: false,
    deviceId,
    fetchedAt: null,
    heartbeat: null,
    message: "Set BEAM_CLOUD_API_URL and BEAM_CLOUD_API_KEY on the dashboard server to read AWS heartbeat status.",
    ok: false,
    status: "not_configured"
  };
}

export async function readCloudHeartbeat(): Promise<CloudHeartbeatState> {
  const deviceId = cloudDeviceId();
  const tableName = heartbeatsTableName();
  const apiUrl = cloudApiUrl();
  const apiKey = cloudApiKey();
  const fetchedAt = new Date().toISOString();

  if (tableName) {
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

  if (!apiUrl || !apiKey) {
    return notConfiguredState(deviceId);
  }

  const url = `${apiUrl}/v1/devices/${encodeURIComponent(deviceId)}/heartbeat`;

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "x-api-key": apiKey
      },
      signal: AbortSignal.timeout(cloudHeartbeatTimeoutMs)
    });
    const body = (await response.json().catch(() => ({}))) as CloudHeartbeatResponse;

    if (response.status === 404) {
      return {
        configured: true,
        deviceId,
        fetchedAt,
        heartbeat: null,
        message: body.error?.message ?? "AWS has not recorded a heartbeat for this device yet.",
        ok: false,
        status: "not_found"
      };
    }

    if (!response.ok || !body.heartbeat) {
      return {
        configured: true,
        deviceId,
        fetchedAt,
        heartbeat: null,
        message: body.error?.message ?? `AWS heartbeat read failed with HTTP ${response.status}.`,
        ok: false,
        status: "error"
      };
    }

    return {
      configured: true,
      deviceId,
      fetchedAt,
      heartbeat: body.heartbeat,
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
