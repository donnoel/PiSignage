# Device Configuration

PiSignage device configuration is local-first. The current agent reads environment variables for both local mode and optional AWS dev alpha mode; `device-agent/config.example.json` documents the intended stable config shape for provisioning and future pairing.

No config file should contain AWS credentials, IoT private keys, signed URLs, or production secrets.

## Example Fields

```json
{
  "deviceId": "device-c5-aws-pilot",
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

- `deviceId`: stable local device ID. Cloud-connected Pis must be provisioned
  with a unique value before the device-agent service starts.
- `screenId`: assigned screen ID.
- `environment`: `local` for local operation, or `dev` for the current AWS alpha.
- `playlistSourcePath`: local playlist path or cloud dashboard playlist endpoint.
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
PISIGNAGE_CLOUD_PLAYLIST_URL
PISIGNAGE_CLOUD_API_URL
PISIGNAGE_CLOUD_API_KEY
```

## Provisioning Rules

- Run `device/pi/bin/pisignage-provision-device.sh` on each Pi to generate
  `~/.config/pisignage/device-agent.env` and `~/.config/pisignage/device.json`.
- Keep `PISIGNAGE_DEVICE_ID` unique per Pi. The five appliances should share the
  same scripts/services/packages and differ only in identity/network fields.
- Keep `PISIGNAGE_CLOUD_API_KEY` only in the private env file or another ignored
  local secret store.
- Device config should be readable by the agent without involving the dashboard.
- Local config should remain usable without network access.
- Runtime state such as heartbeat and cache should remain separate from config.

## Optional Cloud Heartbeat

The device agent can fetch an assigned cloud playlist and send the same heartbeat payload to the Beam dev API when these environment variables are present:

```sh
PISIGNAGE_CLOUD_PLAYLIST_URL=https://example.awsapprunner.com/api/cloud/devices/device-c5-aws-pilot/playlist
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
BEAM_CLOUD_DEVICE_ID=device-c5-aws-pilot
```

Rules:

- Keep `PISIGNAGE_CLOUD_API_KEY` in the shell, systemd environment, or another ignored local secret store.
- Keep `BEAM_CLOUD_API_KEY` only in ignored dashboard server environment.
- Do not commit cloud API keys to git.
- `PISIGNAGE_DEVICE_ID` is required when cloud playlist or heartbeat settings are configured.
- A cloud playlist fetch failure must fall back to the local playlist or last cached playlist.
- A cloud heartbeat failure must not fail the local heartbeat write.
- A failed loop cycle should log and retry instead of stopping playback supervision.
- Local playback and cached playlist behavior must not depend on the cloud heartbeat.
