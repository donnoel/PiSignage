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
- `pollIntervalSeconds`: device-agent loop interval. The default loop interval is 60 seconds.
- `appVersion`: agent/player version reported in heartbeat.

## Current Environment Variable Mapping

```text
PISIGNAGE_DEVICE_ID
PISIGNAGE_PLAYLIST_PATH
PISIGNAGE_CACHE_DIR
PISIGNAGE_HEARTBEAT_PATH
PISIGNAGE_NETWORK_ONLINE
PISIGNAGE_HEARTBEAT_INTERVAL_SECONDS
PISIGNAGE_AGENT_LOOP
```

## Future Rules

- Pairing may write a generated device config later, but not until AWS/device identity work is approved.
- Device config should be readable by the agent without involving the dashboard.
- Local config should remain usable without network access.
- Runtime state such as heartbeat and cache should remain separate from config.

## Optional Cloud Heartbeat

The device agent can fetch an assigned cloud playlist and send the same heartbeat payload to the Beam dev API when these environment variables are present:

```sh
PISIGNAGE_CLOUD_PLAYLIST_URL=https://example.awsapprunner.com/api/cloud/devices/device-local-demo/playlist
PISIGNAGE_CLOUD_API_URL=https://example.execute-api.us-west-2.amazonaws.com/dev
PISIGNAGE_CLOUD_API_KEY='<dev-api-key>'
```

The agent can run once or continuously:

```sh
npm run agent:heartbeat
PISIGNAGE_HEARTBEAT_INTERVAL_SECONDS=60 npm run agent:loop
```

On a Pi, keep cloud settings in an ignored local env file loaded by the user
service:

```text
~/.config/pisignage/device-agent.env
```

On the dashboard server, use dashboard-only environment variables so the API key
never reaches browser JavaScript:

```sh
BEAM_CLOUD_API_URL=https://example.execute-api.us-west-2.amazonaws.com/dev
BEAM_CLOUD_API_KEY='<dev-api-key>'
BEAM_CLOUD_DEVICE_ID=device-local-demo
```

Rules:

- Keep `PISIGNAGE_CLOUD_API_KEY` in the shell, systemd environment, or another ignored local secret store.
- Keep `BEAM_CLOUD_API_KEY` only in ignored dashboard server environment.
- Do not commit cloud API keys to git.
- A cloud playlist fetch failure must fall back to the local playlist or last cached playlist.
- A cloud heartbeat failure must not fail the local heartbeat write.
- A failed loop cycle should log and retry instead of stopping playback supervision.
- Local playback and cached playlist behavior must not depend on the cloud heartbeat.
