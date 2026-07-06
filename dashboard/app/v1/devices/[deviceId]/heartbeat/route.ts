import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { NextResponse } from "next/server";

import { ensureCloudCallHomeDevice } from "../../../../lib/inventory-store";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

type HeartbeatBody = {
  appVersion?: unknown;
  currentAssetId?: unknown;
  currentPlaylistId?: unknown;
  deviceId?: unknown;
  diskFreeBytes?: unknown;
  hostname?: unknown;
  localIpAddress?: unknown;
  networkOnline?: unknown;
  playbackState?: unknown;
  playlistVersion?: unknown;
  scheduleDetail?: unknown;
  scheduleDisplayAction?: unknown;
  scheduleDisplayControlOk?: unknown;
  scheduleOverrideExpiresAt?: unknown;
  scheduleState?: unknown;
  timestamp?: unknown;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultAccountId = "beam-dev";
const dynamoDb = new DynamoDBClient({});
const nextHeartbeatInSeconds = 60;

function heartbeatsTableName(): string | null {
  return process.env.BEAM_HEARTBEATS_TABLE_NAME?.trim() || null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function nullableNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value));
}

function nullableBoolean(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === "boolean";
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      error: {
        code,
        message
      }
    },
    { status }
  );
}

function validateHeartbeat(body: HeartbeatBody, pathDeviceId: string): string | null {
  const deviceId = stringOrNull(body.deviceId);
  const timestamp = stringOrNull(body.timestamp);
  const appVersion = stringOrNull(body.appVersion);
  const currentPlaylistId = stringOrNull(body.currentPlaylistId);

  if (!deviceId || deviceId !== pathDeviceId) {
    return "Heartbeat deviceId must match the request path.";
  }
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    return "Heartbeat timestamp must be an ISO 8601 string.";
  }
  if (!appVersion) {
    return "Heartbeat appVersion is required.";
  }
  if (!currentPlaylistId) {
    return "Heartbeat currentPlaylistId is required.";
  }
  if (!nullableString(body.currentAssetId)) {
    return "Heartbeat currentAssetId must be a string or null.";
  }
  if (!nullableNumber(body.diskFreeBytes)) {
    return "Heartbeat diskFreeBytes must be a number or null.";
  }
  if (typeof body.networkOnline !== "boolean") {
    return "Heartbeat networkOnline must be a boolean.";
  }
  if (!nullableString(body.hostname)) {
    return "Heartbeat hostname must be a string or null.";
  }
  if (!nullableString(body.localIpAddress)) {
    return "Heartbeat localIpAddress must be a string or null.";
  }
  if (!nullableString(body.playbackState)) {
    return "Heartbeat playbackState must be a string or null.";
  }
  if (!nullableNumber(body.playlistVersion)) {
    return "Heartbeat playlistVersion must be a number or null.";
  }
  if (!nullableString(body.scheduleDetail)) {
    return "Heartbeat scheduleDetail must be a string or null.";
  }
  if (!nullableString(body.scheduleDisplayAction)) {
    return "Heartbeat scheduleDisplayAction must be a string or null.";
  }
  if (!nullableBoolean(body.scheduleDisplayControlOk)) {
    return "Heartbeat scheduleDisplayControlOk must be a boolean or null.";
  }
  if (!nullableString(body.scheduleOverrideExpiresAt)) {
    return "Heartbeat scheduleOverrideExpiresAt must be a string or null.";
  }
  if (!nullableString(body.scheduleState)) {
    return "Heartbeat scheduleState must be a string or null.";
  }

  return null;
}

function heartbeatFromItem(item: Record<string, { BOOL?: boolean; N?: string; NULL?: boolean; S?: string }> | undefined) {
  if (!item) {
    return null;
  }

  return {
    accountId: item.accountId?.S ?? null,
    appVersion: item.appVersion?.S ?? null,
    currentAssetId: item.currentAssetId?.S ?? null,
    currentPlaylistId: item.currentPlaylistId?.S ?? null,
    deviceId: item.deviceId?.S ?? null,
    diskFreeBytes: item.diskFreeBytes?.N ? Number(item.diskFreeBytes.N) : null,
    hostname: item.hostname?.S ?? null,
    localIpAddress: item.localIpAddress?.S ?? null,
    networkOnline: item.networkOnline?.BOOL ?? false,
    playbackState: item.playbackState?.S ?? null,
    playlistVersion: item.playlistVersion?.N ? Number(item.playlistVersion.N) : null,
    receivedAt: item.receivedAt?.S ?? null,
    scheduleDetail: item.scheduleDetail?.S ?? null,
    scheduleDisplayAction: item.scheduleDisplayAction?.S ?? null,
    scheduleDisplayControlOk: item.scheduleDisplayControlOk?.BOOL ?? null,
    scheduleOverrideExpiresAt: item.scheduleOverrideExpiresAt?.S ?? null,
    scheduleState: item.scheduleState?.S ?? null,
    timestamp: item.timestamp?.S ?? null
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { deviceId } = await context.params;
  const tableName = heartbeatsTableName();

  if (!tableName) {
    return errorResponse(503, "server_misconfigured", "Heartbeat storage is not configured.");
  }
  if (!request.headers.get("x-api-key")) {
    return errorResponse(401, "missing_api_key", "Heartbeat requests must include x-api-key.");
  }

  const result = await dynamoDb.send(new GetItemCommand({
    ConsistentRead: true,
    Key: {
      deviceId: { S: deviceId }
    },
    TableName: tableName
  }));
  const heartbeat = heartbeatFromItem(result.Item);

  if (!heartbeat) {
    return errorResponse(404, "heartbeat_not_found", "No heartbeat has been recorded for this device.");
  }

  return NextResponse.json({ heartbeat });
}

export async function POST(request: Request, context: RouteContext) {
  const { deviceId } = await context.params;
  const tableName = heartbeatsTableName();

  if (!tableName) {
    return errorResponse(503, "server_misconfigured", "Heartbeat storage is not configured.");
  }
  if (!request.headers.get("x-api-key")) {
    return errorResponse(401, "missing_api_key", "Heartbeat requests must include x-api-key.");
  }

  let body: HeartbeatBody;
  try {
    body = (await request.json()) as HeartbeatBody;
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }

  const validationError = validateHeartbeat(body, deviceId);
  if (validationError) {
    return errorResponse(400, "invalid_heartbeat", validationError);
  }

  const registeredDevice = await ensureCloudCallHomeDevice({
    deviceId,
    hostname: stringOrNull(body.hostname),
    localIpAddress: stringOrNull(body.localIpAddress)
  });

  const receivedAt = new Date().toISOString();
  await dynamoDb.send(new PutItemCommand({
    Item: {
      accountId: { S: defaultAccountId },
      appVersion: { S: stringOrNull(body.appVersion) ?? "unknown" },
      currentAssetId: body.currentAssetId === null || body.currentAssetId === undefined ? { NULL: true } : { S: String(body.currentAssetId) },
      currentPlaylistId: { S: stringOrNull(body.currentPlaylistId) ?? "unknown" },
      deviceId: { S: deviceId },
      diskFreeBytes: body.diskFreeBytes === null || body.diskFreeBytes === undefined ? { NULL: true } : { N: String(body.diskFreeBytes) },
      hostname: body.hostname === null || body.hostname === undefined ? { NULL: true } : { S: String(body.hostname) },
      localIpAddress: body.localIpAddress === null || body.localIpAddress === undefined ? { NULL: true } : { S: String(body.localIpAddress) },
      networkOnline: { BOOL: Boolean(body.networkOnline) },
      playbackState: body.playbackState === null || body.playbackState === undefined ? { NULL: true } : { S: String(body.playbackState) },
      playlistVersion: body.playlistVersion === null || body.playlistVersion === undefined ? { NULL: true } : { N: String(body.playlistVersion) },
      receivedAt: { S: receivedAt },
      scheduleDetail: body.scheduleDetail === null || body.scheduleDetail === undefined ? { NULL: true } : { S: String(body.scheduleDetail) },
      scheduleDisplayAction: body.scheduleDisplayAction === null || body.scheduleDisplayAction === undefined ? { NULL: true } : { S: String(body.scheduleDisplayAction) },
      scheduleDisplayControlOk: body.scheduleDisplayControlOk === null || body.scheduleDisplayControlOk === undefined ? { NULL: true } : { BOOL: Boolean(body.scheduleDisplayControlOk) },
      scheduleOverrideExpiresAt: body.scheduleOverrideExpiresAt === null || body.scheduleOverrideExpiresAt === undefined ? { NULL: true } : { S: String(body.scheduleOverrideExpiresAt) },
      scheduleState: body.scheduleState === null || body.scheduleState === undefined ? { NULL: true } : { S: String(body.scheduleState) },
      timestamp: { S: stringOrNull(body.timestamp) ?? receivedAt }
    },
    TableName: tableName
  }));

  return NextResponse.json(
    {
      accepted: true,
      registeredDevice: registeredDevice.created,
      serverTime: receivedAt,
      nextHeartbeatInSeconds
    },
    { status: 202 }
  );
}
