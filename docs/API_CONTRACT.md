# API Contract

This document records the future API and MQTT contract before cloud implementation. The current repository still uses local files, local dashboard routes, and direct Pi SSH/SCP operations; it does not expose or deploy a real cloud API.

These contracts are intentionally scoped to the initial product path: one account, a small local fleet, reusable media, playlists, and playback-safe assets. They must remain locally testable until a future AWS phase is explicitly approved.

All examples are illustrative and contain no real secrets.

## Contract Rules

- Base path starts at `/v1`.
- All timestamps are ISO 8601 UTC strings.
- IDs are stable opaque strings; clients must not parse meaning from them.
- JSON field names use `camelCase`.
- Requests and responses use `application/json` unless an upload URL is being used directly.
- Device clients should treat duplicate commands and repeated playlist versions as idempotent.
- Devices must keep using the last known good local playlist if cloud requests fail.
- Signed URLs and credentials must never be logged.
- Breaking changes require a new version or an explicit migration note.

## Shared Types

### Playlist Asset

```json
{
  "assetId": "asset-welcome",
  "type": "image",
  "uri": "https://example.cloudfront.net/assets/welcome.png",
  "durationSeconds": 10,
  "altText": "Welcome title card",
  "checksumSha256": "example-checksum"
}
```

Rules:

- `type` starts with `image` and `video`; the current Pi field path should receive playback-safe MP4 assets.
- `durationSeconds` must be at least `1`.
- `altText` is required so dashboard/player UI has a meaningful accessible label.
- `checksumSha256` is optional for the local phase but expected before production device caching.

### Error Response

```json
{
  "error": {
    "code": "playlist_not_found",
    "message": "Playlist could not be found.",
    "requestId": "req-example"
  }
}
```

Rules:

- `message` should be safe to show in dashboard diagnostics.
- `requestId` should be safe to log.
- Secrets, signed URLs, and credentials must not appear in errors.

## Device Pairing

Pairing creates a relationship between one physical device and one screen. The initial POC does not support organizations, fleet ownership transfer, or advanced RBAC.

Future endpoint:

```http
POST /v1/devices/pair
```

Request:

```json
{
  "pairingCode": "ABCD-1234",
  "deviceLabel": "Lobby Pi",
  "screenName": "Lobby TV",
  "agentVersion": "0.1.0"
}
```

Response:

```json
{
  "deviceId": "device-local-demo",
  "screenId": "screen-lobby",
  "screenName": "Lobby TV",
  "mqttClientId": "device-local-demo",
  "heartbeatIntervalSeconds": 60,
  "playlistPollIntervalSeconds": 300
}
```

Expected failures:

- `400 invalid_pairing_code`
- `409 device_already_paired`
- `410 pairing_code_expired`

Security notes:

- Pairing codes must be short-lived.
- Device credentials are not returned in this plain JSON response until the credential provisioning design is approved.
- A device should not erase its last known good local playlist during re-pairing.

## Heartbeat

Heartbeat is the first monitoring model. It tells the dashboard whether the device recently reported status, but it is not a command channel.

Future endpoint:

```http
POST /v1/devices/{deviceId}/heartbeat
```

The dev AWS alpha currently gates heartbeat write and read routes with an API Gateway API key. That is a temporary alpha control, not the final device identity or dashboard auth model. Production device authentication remains a future pairing/certificate contract, and production dashboard reads still need a real authenticated UI/backend boundary.

Request:

```json
{
  "deviceId": "device-local-demo",
  "timestamp": "2026-05-20T20:17:32.971Z",
  "appVersion": "0.1.0",
  "currentPlaylistId": "playlist-local-demo",
  "currentAssetId": "asset-welcome",
  "diskFreeBytes": 1234567890,
  "networkOnline": false
}
```

Response:

```json
{
  "accepted": true,
  "serverTime": "2026-05-20T20:17:33.100Z",
  "nextHeartbeatInSeconds": 60
}
```

Expected failures:

- `400 invalid_heartbeat`
- `401 device_not_authenticated`
- `403 forbidden` when the dev API key is missing or invalid
- `404 device_not_found`

Device behavior:

- Heartbeat failure must not stop playback.
- Device should log the failure and retry on the next interval.
- Device should keep writing local heartbeat JSON for local diagnostics.
- The current device-agent alpha sends cloud heartbeat only when `PISIGNAGE_CLOUD_API_URL` and `PISIGNAGE_CLOUD_API_KEY` are configured.

### Latest Heartbeat Read

The dev AWS alpha also exposes the latest stored heartbeat for status smoke tests:

```http
GET /v1/devices/{deviceId}/heartbeat
```

Response:

```json
{
  "heartbeat": {
    "deviceId": "device-local-demo",
    "accountId": "beam-dev",
    "timestamp": "2026-05-20T20:17:32.971Z",
    "appVersion": "0.1.0",
    "currentPlaylistId": "playlist-local-demo",
    "currentAssetId": "asset-welcome",
    "diskFreeBytes": 1234567890,
    "networkOnline": false,
    "receivedAt": "2026-05-20T20:17:33.100Z"
  }
}
```

Expected failures:

- `403 forbidden` when the dev API key is missing or invalid
- `404 heartbeat_not_found`

## Playlist Fetch

Playlist fetch gives the device the current screen assignment and asset list. It must be safe for the device to call repeatedly.

Future endpoint:

```http
GET /v1/devices/{deviceId}/playlist
```

Response:

```json
{
  "screenId": "screen-lobby",
  "playlistId": "playlist-local-demo",
  "name": "Local Demo Playlist",
  "version": 1,
  "updatedAt": "2026-05-20T00:00:00.000Z",
  "assets": [
    {
      "assetId": "asset-welcome",
      "type": "image",
      "uri": "https://example.cloudfront.net/assets/welcome.png",
      "durationSeconds": 10,
      "altText": "PiSignage demo title card",
      "checksumSha256": "example-checksum"
    }
  ]
}
```

Expected failures:

- `401 device_not_authenticated`
- `404 playlist_not_assigned`
- `409 playlist_not_ready`

Device behavior:

- If the response version is unchanged, the device may keep its current cache.
- If fetch fails, the device must keep playing the last known good cached playlist.
- If a new playlist references assets that fail to download, the device must not delete the current working asset set.

## Asset Upload

The dashboard eventually needs a way to upload media without sending large files through Lambda. The first contract returns a signed upload URL and records intended metadata.

Future endpoint:

```http
POST /v1/assets/upload-url
```

Request:

```json
{
  "fileName": "welcome.png",
  "contentType": "image/png",
  "sizeBytes": 245760
}
```

Response:

```json
{
  "assetId": "asset-welcome",
  "uploadUrl": "https://example-signed-upload-url",
  "expiresAt": "2026-05-20T20:32:00.000Z",
  "requiredHeaders": {
    "content-type": "image/png"
  }
}
```

Expected failures:

- `400 unsupported_media_type`
- `400 file_too_large`
- `401 dashboard_not_authenticated`

Rules:

- The dashboard must not log `uploadUrl`.
- Image upload comes before video.
- Server-side validation and processing status should be designed before production uploads.

## Screen Assignment

Screen assignment connects the single screen to a playlist. This is intentionally not a scheduling system yet.

Future endpoint:

```http
PUT /v1/screens/{screenId}/assignment
```

Request:

```json
{
  "playlistId": "playlist-local-demo"
}
```

Response:

```json
{
  "screenId": "screen-lobby",
  "playlistId": "playlist-local-demo",
  "version": 1,
  "updatedAt": "2026-05-20T20:20:00.000Z"
}
```

Expected failures:

- `401 dashboard_not_authenticated`
- `404 screen_not_found`
- `404 playlist_not_found`
- `409 playlist_not_ready`

Device notification:

- Assignment changes should publish a lightweight MQTT notification.
- The notification should tell the device to fetch the latest playlist rather than embedding the full playlist.

## MQTT Topics

Future AWS IoT Core topics:

```text
pisignage/devices/{deviceId}/commands
pisignage/devices/{deviceId}/events
pisignage/devices/{deviceId}/heartbeat
pisignage/screens/{screenId}/playlist-updated
```

### Playlist Updated Message

```json
{
  "type": "playlist.updated",
  "screenId": "screen-lobby",
  "playlistId": "playlist-local-demo",
  "version": 2,
  "timestamp": "2026-05-20T20:20:00.000Z"
}
```

### Device Event Message

```json
{
  "type": "device.playback.started",
  "deviceId": "device-local-demo",
  "playlistId": "playlist-local-demo",
  "assetId": "asset-welcome",
  "timestamp": "2026-05-20T20:20:05.000Z"
}
```

MQTT rules:

- Commands must be idempotent where practical.
- Large payloads do not belong in MQTT messages.
- Device policies must scope each device to its own topics.
- MQTT is not required for the current local POC.

## Local-To-Cloud Mapping

Current local files map to future contracts:

| Local file | Future contract |
| --- | --- |
| `sample-content/playlist.local.json` | `GET /v1/devices/{deviceId}/playlist` response |
| `device-agent/local-state/heartbeat.json` | `POST /v1/devices/{deviceId}/heartbeat` request |
| `device-agent/local-cache/playlists/current.json` | Last known good playlist cache |

No local file should contain credentials or signed production URLs.
