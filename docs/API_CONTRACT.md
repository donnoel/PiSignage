# API Contract

Contracts are documented before deployment. The current implementation uses local mocks and does not expose a real API.

All examples are illustrative and contain no real secrets.

## Versioning

Start with `/v1`. Breaking changes should create a new version or a clearly documented migration.

## Device Pairing

Future endpoint:

```http
POST /v1/devices/pair
```

Request:

```json
{
  "pairingCode": "ABCD-1234",
  "deviceLabel": "Lobby TV"
}
```

Response:

```json
{
  "deviceId": "device-local-demo",
  "screenId": "screen-lobby",
  "mqttClientId": "device-local-demo"
}
```

## Heartbeat

Future endpoint:

```http
POST /v1/devices/{deviceId}/heartbeat
```

Request:

```json
{
  "deviceId": "device-local-demo",
  "timestamp": "2026-05-20T12:00:00.000Z",
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
  "serverTime": "2026-05-20T12:00:01.000Z"
}
```

## Playlist Fetch

Future endpoint:

```http
GET /v1/devices/{deviceId}/playlist
```

Response:

```json
{
  "playlistId": "playlist-local-demo",
  "version": 1,
  "assets": [
    {
      "assetId": "asset-welcome",
      "type": "image",
      "uri": "https://example.cloudfront.net/assets/welcome.png",
      "durationSeconds": 10,
      "altText": "Welcome title card"
    }
  ]
}
```

## Asset Upload

Future endpoint:

```http
POST /v1/assets/upload-url
```

Request:

```json
{
  "fileName": "welcome.png",
  "contentType": "image/png"
}
```

Response:

```json
{
  "assetId": "asset-welcome",
  "uploadUrl": "https://example-signed-upload-url",
  "expiresAt": "2026-05-20T12:15:00.000Z"
}
```

Do not log signed URLs.

## Screen Assignment

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
  "version": 1
}
```

## MQTT Topics

Future AWS IoT Core topics:

```text
pisignage/devices/{deviceId}/commands
pisignage/devices/{deviceId}/events
pisignage/devices/{deviceId}/heartbeat
pisignage/screens/{screenId}/playlist-updated
```

MQTT commands should be idempotent where practical. Playlist update messages should notify the device to fetch the latest contract rather than embedding large payloads.
