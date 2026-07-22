import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const heartbeatSourcePath = path.join(repoRoot, "infra", "beam", "lambda", "heartbeat", "index.mjs");
const requireFromHeartbeat = createRequire(heartbeatSourcePath);
const { DynamoDBClient } = requireFromHeartbeat("@aws-sdk/client-dynamodb");
const inventorySourcePath = path.join(repoRoot, "dashboard", "app", "lib", "inventory-store.ts");
const playlistRoutePath = path.join(
  repoRoot,
  "dashboard",
  "app",
  "api",
  "cloud",
  "devices",
  "[deviceId]",
  "playlist",
  "route.ts"
);

const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function heartbeatEvent(deviceId) {
  return {
    body: JSON.stringify({
      appVersion: "0.1.0",
      currentAssetId: "asset-1",
      currentPlaylistId: "playlist-1",
      deviceId,
      diskFreeBytes: 1_000_000,
      hostname: "C1",
      localIpAddress: "192.0.2.10",
      networkOnline: true,
      playbackState: "playing",
      playlistVersion: 1,
      timestamp: "2026-07-22T00:00:00.000Z"
    }),
    headers: {
      "x-api-key": "test-key"
    },
    pathParameters: {
      deviceId
    },
    requestContext: {
      http: {
        method: "POST"
      }
    }
  };
}

process.env.DEFAULT_ACCOUNT_ID = "beam-dev";
process.env.DEVICES_TABLE_NAME = "beam-dev-devices";
process.env.DEVICE_API_KEY = "test-key";
process.env.HEARTBEATS_TABLE_NAME = "beam-dev-heartbeats";

const sentCommands = [];
const originalSend = DynamoDBClient.prototype.send;
let heartbeatExists = true;

DynamoDBClient.prototype.send = async function send(command) {
  sentCommands.push(command);
  if (command.constructor.name === "GetItemCommand") {
    return heartbeatExists
      ? { Item: { deviceId: { S: command.input.Key.deviceId.S } } }
      : {};
  }
  return {};
};

try {
  const heartbeatModule = await import(pathToFileURL(heartbeatSourcePath).href);

  const existingResponse = await heartbeatModule.handler(
    heartbeatEvent("device-existing"),
    { awsRequestId: "request-existing" }
  );
  const existingBody = JSON.parse(existingResponse.body);
  assert(existingResponse.statusCode === 202, "existing device heartbeat is accepted");
  assert(existingBody.registeredDevice === false, "existing device is not registered again");
  assert(
    sentCommands.filter((command) => command.input.TableName === "beam-dev-devices").length === 0,
    "existing heartbeat does not write to the devices table"
  );

  sentCommands.length = 0;
  heartbeatExists = false;
  const firstResponse = await heartbeatModule.handler(
    heartbeatEvent("device-first"),
    { awsRequestId: "request-first" }
  );
  const firstBody = JSON.parse(firstResponse.body);
  const deviceWrites = sentCommands.filter(
    (command) => command.constructor.name === "PutItemCommand" && command.input.TableName === "beam-dev-devices"
  );
  assert(firstResponse.statusCode === 202, "first device heartbeat is accepted");
  assert(firstBody.registeredDevice === true, "first heartbeat registers a missing device");
  assert(deviceWrites.length === 1, "first heartbeat performs one devices-table registration write");
  assert(
    deviceWrites[0]?.input.ConditionExpression === "attribute_not_exists(deviceId)",
    "first-heartbeat registration remains race safe"
  );
} finally {
  DynamoDBClient.prototype.send = originalSend;
}

const [inventorySource, playlistRouteSource] = await Promise.all([
  readFile(inventorySourcePath, "utf8"),
  readFile(playlistRoutePath, "utf8")
]);
const targetedReadStart = inventorySource.indexOf("export async function readInventoryDeviceContext");
const targetedReadEnd = inventorySource.indexOf("export async function ensureCloudCallHomeDevice", targetedReadStart);
const targetedReadSource = inventorySource.slice(targetedReadStart, targetedReadEnd);
const callHomeReadStart = targetedReadEnd;
const callHomeReadEnd = inventorySource.indexOf("export function isCloudInventoryConfigured", callHomeReadStart);
const callHomeReadSource = inventorySource.slice(callHomeReadStart, callHomeReadEnd);

assert(targetedReadStart >= 0 && targetedReadEnd > targetedReadStart, "targeted device context reader exists");
assert(
  playlistRouteSource.includes("readInventoryDeviceContext(deviceId, \"playlist-main-playlist\")"),
  "playlist polling uses the targeted device context reader"
);
assert(
  !playlistRouteSource.includes("readInventory(\"playlist-main-playlist\")"),
  "playlist polling no longer loads the full inventory"
);
assert(
  (targetedReadSource.match(/new GetItemCommand/g) ?? []).length === 2,
  "cloud device context uses keyed device and screen reads"
);
assert(
  !targetedReadSource.includes("queryWorkspaceItems") && !targetedReadSource.includes("readCloudInventory"),
  "cloud device context does not query workspace-wide inventory"
);
assert(callHomeReadStart >= 0 && callHomeReadEnd > callHomeReadStart, "call-home device reader exists");
assert(
  callHomeReadSource.includes("new GetItemCommand") && !callHomeReadSource.includes("readCloudInventory"),
  "legacy call-home registration uses a keyed device read"
);

if (failures.length > 0) {
  console.error("AWS cost hot-path smoke failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("AWS cost hot-path smoke checks passed.");
