import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";

const dynamoDb = new DynamoDBClient({});
const devicesTableName = process.env.DEVICES_TABLE_NAME;
const heartbeatTableName = process.env.HEARTBEATS_TABLE_NAME;
const defaultAccountId = process.env.DEFAULT_ACCOUNT_ID ?? "beam-dev";
const nextHeartbeatInSeconds = Number.parseInt(process.env.NEXT_HEARTBEAT_IN_SECONDS ?? "60", 10);

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
  return value === null || typeof value === "string";
}

function nullableNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
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
    networkOnline: item.networkOnline?.BOOL ?? false,
    receivedAt: stringOrNullAttribute(item.receivedAt)
  };
}

async function registerDeviceIfMissing(deviceId, receivedAt) {
  if (!devicesTableName) {
    return false;
  }

  try {
    await dynamoDb.send(new PutItemCommand({
      ConditionExpression: "attribute_not_exists(deviceId)",
      TableName: devicesTableName,
      Item: {
        accountId: { S: defaultAccountId },
        deviceId: { S: deviceId },
        group: { S: "Unassigned" },
        host: { S: "Not configured" },
        id: { S: deviceId },
        location: { S: "Unassigned" },
        name: { S: `Unassigned Pi ${deviceId}` },
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

  return null;
}

export async function handler(event, context) {
  const requestId = context.awsRequestId;
  const pathDeviceId = event.pathParameters?.deviceId;
  const httpMethod = event.httpMethod;

  if (!heartbeatTableName) {
    return errorResponse(500, "server_misconfigured", "Heartbeat storage is not configured.", requestId);
  }
  if (!pathDeviceId) {
    return errorResponse(400, "invalid_heartbeat", "Missing deviceId path parameter.", requestId);
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
    networkOnline: { BOOL: body.networkOnline },
    receivedAt: { S: receivedAt }
  };

  await dynamoDb.send(new PutItemCommand({
    TableName: heartbeatTableName,
    Item: item
  }));
  const registeredDevice = await registerDeviceIfMissing(body.deviceId, receivedAt);

  return jsonResponse(202, {
    accepted: true,
    registeredDevice,
    serverTime: receivedAt,
    nextHeartbeatInSeconds
  });
}
