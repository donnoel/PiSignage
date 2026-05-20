# Device Configuration

PiSignage device configuration is local and mockable today. The current agent primarily reads environment variables; `device-agent/config.example.json` documents the intended stable config shape for tomorrow’s Pi work and future pairing.

No config file should contain AWS credentials, IoT private keys, signed URLs, or production secrets.

## Example Fields

```json
{
  "deviceId": "device-local-demo",
  "screenId": "screen-lobby",
  "environment": "local",
  "playlistSourcePath": "sample-content/playlist.local.json",
  "cacheDirectory": "device-agent/local-cache",
  "heartbeatPath": "device-agent/local-state/heartbeat.json",
  "pollIntervalSeconds": 60,
  "appVersion": "0.1.0"
}
```

## Field Notes

- `deviceId`: stable local device ID. Future pairing will provision this.
- `screenId`: assigned screen ID. Initial POC uses one screen.
- `environment`: `local` for the current repo; future values may include `dev` or `alpha`.
- `playlistSourcePath`: local playlist path or future HTTPS playlist endpoint.
- `cacheDirectory`: local last-known-good playlist and asset cache root.
- `heartbeatPath`: local heartbeat JSON output path.
- `pollIntervalSeconds`: future agent loop interval; current command runs once.
- `appVersion`: agent/player version reported in heartbeat.

## Current Environment Variable Mapping

```text
PISIGNAGE_DEVICE_ID
PISIGNAGE_PLAYLIST_PATH
PISIGNAGE_CACHE_DIR
PISIGNAGE_HEARTBEAT_PATH
PISIGNAGE_NETWORK_ONLINE
```

## Future Rules

- Pairing may write a generated device config later, but not until AWS/device identity work is approved.
- Device config should be readable by the agent without involving the dashboard.
- Local config should remain usable without network access.
- Runtime state such as heartbeat and cache should remain separate from config.
