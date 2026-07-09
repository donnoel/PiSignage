import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { timingSafeEqual } from "node:crypto";

const dynamoDb = new DynamoDBClient({});
const devicesTableName = process.env.DEVICES_TABLE_NAME;
const deviceApiKey = process.env.DEVICE_API_KEY?.trim() ?? "";
const heartbeatTableName = process.env.HEARTBEATS_TABLE_NAME;
const defaultAccountId = process.env.DEFAULT_ACCOUNT_ID ?? "beam-dev";
const nextHeartbeatInSeconds = Number.parseInt(process.env.NEXT_HEARTBEAT_IN_SECONDS ?? "30", 10);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function errorResponse(statusCode, code, message, requestId) {
  return jsonResponse(statusCode, {
    error: {
      code,
      message,
      requestId
    }
  });
}

function parseBody(event) {
  if (!event.body) {
    throw new Error("Missing JSON request body.");
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(body);
}

function stringOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nullableString(value) {
  return value === undefined || value === null || typeof value === "string";
}

function nullableNumber(value) {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value));
}

function nullableBoolean(value) {
  return value === undefined || value === null || typeof value === "boolean";
}

function numberOrNull(attribute) {
  if (!attribute || attribute.NULL || !attribute.N) {
    return null;
  }

  const parsed = Number(attribute.N);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNullAttribute(attribute) {
  return attribute?.S ?? null;
}

function booleanOrNull(attribute) {
  if (!attribute || attribute.NULL) {
    return null;
  }

  return attribute.BOOL ?? null;
}

function heartbeatFromItem(item) {
  if (!item) {
    return null;
  }

  return {
    deviceId: stringOrNullAttribute(item.deviceId),
    accountId: stringOrNullAttribute(item.accountId),
    timestamp: stringOrNullAttribute(item.timestamp),
    appVersion: stringOrNullAttribute(item.appVersion),
    currentPlaylistId: stringOrNullAttribute(item.currentPlaylistId),
    currentAssetId: stringOrNullAttribute(item.currentAssetId),
    diskFreeBytes: numberOrNull(item.diskFreeBytes),
    hostname: stringOrNullAttribute(item.hostname),
    localIpAddress: stringOrNullAttribute(item.localIpAddress),
    networkOnline: item.networkOnline?.BOOL ?? false,
    playbackState: stringOrNullAttribute(item.playbackState),
    playlistVersion: numberOrNull(item.playlistVersion),
    scheduleDetail: stringOrNullAttribute(item.scheduleDetail),
    scheduleDisplayAction: stringOrNullAttribute(item.scheduleDisplayAction),
    scheduleDisplayControlOk: booleanOrNull(item.scheduleDisplayControlOk),
    scheduleOverrideExpiresAt: stringOrNullAttribute(item.scheduleOverrideExpiresAt),
    scheduleState: stringOrNullAttribute(item.scheduleState),
    tailscaleIpAddress: stringOrNullAttribute(item.tailscaleIpAddress),
    receivedAt: stringOrNullAttribute(item.receivedAt)
  };
}

async function registerDeviceIfMissing(deviceId, receivedAt, heartbeat) {
  if (!devicesTableName) {
    return false;
  }

  const reportedHost = stringOrNull(heartbeat.localIpAddress) ?? "Not configured";
  const reportedHostname = stringOrNull(heartbeat.hostname);

  try {
    await dynamoDb.send(new PutItemCommand({
      ConditionExpression: "attribute_not_exists(deviceId)",
      TableName: devicesTableName,
      Item: {
        accountId: { S: defaultAccountId },
        deviceId: { S: deviceId },
        group: { S: "Unassigned" },
        host: { S: reportedHost },
        id: { S: deviceId },
        location: { S: "Unassigned" },
        name: { S: reportedHostname ? `Unassigned Pi ${reportedHostname}` : `Unassigned Pi ${deviceId}` },
        notes: { S: "Registered automatically from a device heartbeat." },
        playerType: { S: "vlc" },
        playlistId: { NULL: true },
        publishedAt: { NULL: true },
        publishedPlaylistId: { NULL: true },
        publishedPlaylistVersion: { NULL: true },
        registeredAt: { S: receivedAt },
        rootPath: { S: "~" },
        screenId: { NULL: true },
        sshUser: { S: "donnoel" },
        updatedAt: { S: receivedAt }
      }
    }));
    return true;
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
}

function validateHeartbeat(body, pathDeviceId) {
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
  if (body.hostname !== undefined && !nullableString(body.hostname)) {
    return "Heartbeat hostname must be a string or null.";
  }
  if (body.localIpAddress !== undefined && !nullableString(body.localIpAddress)) {
    return "Heartbeat localIpAddress must be a string or null.";
  }
  if (body.playbackState !== undefined && !nullableString(body.playbackState)) {
    return "Heartbeat playbackState must be a string or null.";
  }
  if (body.playlistVersion !== undefined && !nullableNumber(body.playlistVersion)) {
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
  if (!nullableString(body.tailscaleIpAddress)) {
    return "Heartbeat tailscaleIpAddress must be a string or null.";
  }

  return null;
}

function methodFromEvent(event) {
  return event.httpMethod ?? event.requestContext?.http?.method ?? "";
}

function deviceIdFromPath(event) {
  if (event.pathParameters?.deviceId) {
    return event.pathParameters.deviceId;
  }

  const rawPath = event.rawPath ?? event.path ?? "";
  const match = rawPath.match(/^\/v1\/devices\/([^/]+)\/heartbeat\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function headerValue(event, headerName) {
  const headers = event.headers ?? {};
  const lowered = headerName.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return null;
}

function safeStringEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function authorizeDeviceRequest(event) {
  if (!deviceApiKey) {
    return {
      code: "server_misconfigured",
      message: "Device API authentication is not configured.",
      statusCode: 500
    };
  }

  const providedKey = headerValue(event, "x-api-key")?.trim();
  if (!providedKey) {
    return {
      code: "missing_api_key",
      message: "Device API requests must include x-api-key.",
      statusCode: 401
    };
  }

  if (!safeStringEquals(providedKey, deviceApiKey)) {
    return {
      code: "device_not_authenticated",
      message: "Device API key is invalid.",
      statusCode: 403
    };
  }

  return null;
}

export async function handler(event, context) {
  const requestId = context.awsRequestId;
  const pathDeviceId = deviceIdFromPath(event);
  const httpMethod = methodFromEvent(event);

  if (!heartbeatTableName) {
    return errorResponse(500, "server_misconfigured", "Heartbeat storage is not configured.", requestId);
  }
  if (!pathDeviceId) {
    return errorResponse(400, "invalid_heartbeat", "Missing deviceId path parameter.", requestId);
  }

  const authError = authorizeDeviceRequest(event);
  if (authError) {
    return errorResponse(authError.statusCode, authError.code, authError.message, requestId);
  }

  if (httpMethod === "GET") {
    const result = await dynamoDb.send(new GetItemCommand({
      ConsistentRead: true,
      Key: {
        deviceId: { S: pathDeviceId }
      },
      TableName: heartbeatTableName
    }));
    const heartbeat = heartbeatFromItem(result.Item);

    if (!heartbeat) {
      return errorResponse(404, "heartbeat_not_found", "No heartbeat has been recorded for this device.", requestId);
    }

    return jsonResponse(200, {
      heartbeat
    });
  }

  if (httpMethod !== "POST") {
    return errorResponse(405, "method_not_allowed", "Heartbeat only supports GET and POST.", requestId);
  }

  let body;
  try {
    body = parseBody(event);
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.", requestId);
  }

  const validationError = validateHeartbeat(body, pathDeviceId);
  if (validationError) {
    return errorResponse(400, "invalid_heartbeat", validationError, requestId);
  }

  const receivedAt = new Date().toISOString();
  const item = {
    deviceId: { S: body.deviceId },
    accountId: { S: defaultAccountId },
    timestamp: { S: body.timestamp },
    appVersion: { S: body.appVersion },
    currentPlaylistId: { S: body.currentPlaylistId },
    currentAssetId: body.currentAssetId === null ? { NULL: true } : { S: body.currentAssetId },
    diskFreeBytes: body.diskFreeBytes === null ? { NULL: true } : { N: String(body.diskFreeBytes) },
    hostname: body.hostname === null || body.hostname === undefined ? { NULL: true } : { S: body.hostname },
    localIpAddress: body.localIpAddress === null || body.localIpAddress === undefined ? { NULL: true } : { S: body.localIpAddress },
    networkOnline: { BOOL: body.networkOnline },
    playbackState: body.playbackState === null || body.playbackState === undefined ? { NULL: true } : { S: body.playbackState },
    playlistVersion: body.playlistVersion === null || body.playlistVersion === undefined ? { NULL: true } : { N: String(body.playlistVersion) },
    scheduleDetail: body.scheduleDetail === null || body.scheduleDetail === undefined ? { NULL: true } : { S: body.scheduleDetail },
    scheduleDisplayAction: body.scheduleDisplayAction === null || body.scheduleDisplayAction === undefined ? { NULL: true } : { S: body.scheduleDisplayAction },
    scheduleDisplayControlOk: body.scheduleDisplayControlOk === null || body.scheduleDisplayControlOk === undefined ? { NULL: true } : { BOOL: body.scheduleDisplayControlOk },
    scheduleOverrideExpiresAt: body.scheduleOverrideExpiresAt === null || body.scheduleOverrideExpiresAt === undefined ? { NULL: true } : { S: body.scheduleOverrideExpiresAt },
    scheduleState: body.scheduleState === null || body.scheduleState === undefined ? { NULL: true } : { S: body.scheduleState },
    tailscaleIpAddress: body.tailscaleIpAddress === null || body.tailscaleIpAddress === undefined ? { NULL: true } : { S: body.tailscaleIpAddress },
    receivedAt: { S: receivedAt }
  };

  await dynamoDb.send(new PutItemCommand({
    TableName: heartbeatTableName,
    Item: item
  }));
  const registeredDevice = await registerDeviceIfMissing(body.deviceId, receivedAt, body);

  return jsonResponse(202, {
    accepted: true,
    registeredDevice,
    serverTime: receivedAt,
    nextHeartbeatInSeconds
  });
}
