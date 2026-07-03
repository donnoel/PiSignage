# API Contract

This document records the API and MQTT contract direction for Beam. The current repository uses local files, local dashboard routes, and direct Pi SSH/SCP operations for the default local product path, and it also includes a limited AWS `dev` alpha for heartbeat, cloud-backed dashboard data, media cataloging, and device playlist fetch.

These contracts are intentionally scoped to the initial product path: one pilot workspace, a small fleet, reusable media, playlists, and playback-safe assets. Local behavior must remain testable without AWS credentials. Production multi-client use must follow `docs/WORKSPACES_AND_ROLES.md` so users can belong to multiple workspaces without crossing client boundaries.

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
- Workspace-owned requests must be scoped by authenticated membership and active workspace before multi-client production use.
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

Pairing creates a relationship between one physical device and one screen. The current POC uses one pilot workspace, but production pairing must bind the device and screen to a workspace. Fleet ownership transfer, cross-workspace sharing, and enterprise-grade custom RBAC remain future explicit designs.

Target endpoint:

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

Implemented in the dev AWS alpha:

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

Playlist fetch is now the device's cheap release check. It must be safe for the
device to call repeatedly without moving media bytes. Normal checks return only
release metadata; assets are downloaded only after a manual publish creates a
new desired release and the device finds missing or changed cached assets.

Implemented for the dashboard-hosted dev device playlist bridge:

```http
GET /v1/devices/{deviceId}/playlist
```

Response:

```json
{
  "deviceId": "device-local-demo",
  "playlist": null,
  "release": {
    "releaseId": "release-playlist-local-demo-v2-abc123",
    "manifestChecksum": "example-checksum",
    "manifestUrl": "https://dashboard.example/api/cloud/devices/device-local-demo/releases/release-playlist-local-demo-v2-abc123/manifest",
    "plannedBytes": 123456789,
    "playlistId": "playlist-local-demo",
    "playlistName": "Local Demo Playlist",
    "playlistVersion": 2,
    "publishedAt": "2026-05-20T20:20:00.000Z"
  },
  "unchanged": false
}
```

Expected failures:

- `401 device_not_authenticated`
- `404 playlist_not_assigned`
- `409 playlist_not_ready`

Device behavior:

- If `unchanged` is true, the device must keep its current cache and download nothing.
- If fetch fails, the device must keep playing the last known good cached playlist before trying any first-run fallback.
- The tracked first-run fallback asset is only for a device with no valid local cache.
- If a new release references assets that fail to download or verify, the device must not delete or replace the current working asset set.

### Device Command Plane

The dev dashboard-hosted playlist check can include one pending command. This
is the first Beam control-plane slice: the Pi initiates the request, receives an
allowlisted command type, runs the local implementation, and posts status back
to the provided result URL. The dashboard must not send arbitrary shell.

Implemented command types:

- `reset-device`: deployment reset, already guarded by explicit operator action.
- `collect-diagnostics`: read-only evidence collection for VLC service state,
  player status, heartbeat, schedule status, display, network, health,
  playback cache footprint, and capped recent VLC logs.

Command behavior:

- Commands are tiny JSON and must not include media URLs or media payloads.
- Read-only diagnostics must not restart services, reboot the Pi, change
  playlists, delete cache, or modify device identity.
- Device failures to fetch or report command status must not stop cached
  playback.
- Reset commands take precedence over diagnostics if both are pending.

### Release Manifest And Asset URL

Release manifests are fetched only after the release check reports a new desired
release. Manifests contain metadata, checksums, sizes, and app endpoints for
missing assets; they do not contain signed S3 media URLs.

```http
GET /v1/devices/{deviceId}/releases/{releaseId}/manifest
```

The device compares each asset by `assetId`, `fileName`, `sizeBytes`, and
`checksumSha256`. Only missing or changed assets call:

```http
GET /v1/devices/{deviceId}/releases/{releaseId}/assets/{assetId}/url
```

That endpoint returns one short-lived signed URL for one asset. After syncing,
the device posts:

```http
POST /v1/devices/{deviceId}/releases/{releaseId}/sync-result
```

with `downloadedBytes`, `skippedBytes`, `failedAssetIds`, and result status so
Beam can explain daily transfer.

## Asset Upload

The dashboard cloud alpha currently uploads source media through the hosted dashboard into private S3 and records media metadata in DynamoDB. The later production contract should avoid sending large files through Lambda by returning a signed upload URL and recording intended metadata.

Target endpoint:

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
- MP4 video is already supported in the alpha; image and MOV sources still require playback-safe processing before playlist use.
- Server-side validation and processing status should be designed before production uploads.

## Screen Assignment

Screen assignment connects the single screen to a playlist. This is intentionally not a scheduling system yet.

Target endpoint:

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
- MQTT is not required for current local operation or the current dev alpha.

## Local-To-Cloud Mapping

Current local files map to cloud contracts like this:

| Local file | Future contract |
| --- | --- |
| `sample-content/playlist.local.json` | `GET /v1/devices/{deviceId}/playlist` response |
| `device-agent/local-state/heartbeat.json` | `POST /v1/devices/{deviceId}/heartbeat` request |
| `device-agent/local-cache/playlists/current.json` | Last known good playlist cache |

No local file should contain credentials or signed production URLs.
