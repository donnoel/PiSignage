# Architecture

PiSignage is a small digital signage operations product with three primary runtime surfaces:

- Dashboard: the operator UI for the active workspace's local screens, media, playlists, scheduling, health, and recovery.
- Device agent: the Raspberry Pi background process responsible for local state, heartbeat, cache, optional cloud playlist fetch, and optional cloud heartbeat.
- Player: the fullscreen playback surface shown on the TV.

The near-term architecture is still local-first. AWS dev alpha infrastructure and code paths now exist, but they are opt-in and must not replace local playback or recovery.

## Target Shape

```text
Dashboard -> API Gateway/Lambda -> DynamoDB
                         |
                         v
                        S3 -> CloudFront -> Player asset URLs

AWS IoT Core MQTT <-> Device Agent -> local playlist/cache -> Player
```

In normal local operation, local JSON state, uploaded local media, and direct Pi SSH/SCP operations provide the real product path. In cloud mode, selected dashboard stores use DynamoDB/S3 and the hosted dashboard can expose a device playlist endpoint, but the Pi must still cache content and continue playback through cloud or network failures.

## Repository Boundaries

- `dashboard/` contains the Next.js local operations dashboard.
- `device-agent/` contains the local Raspberry Pi heartbeat/cache agent.
- `player/` contains the browser playback fallback/experimental app.
- `device/pi/` contains Pi service, display, static serving, scheduling, and VLC playback scripts.
- `sample-content/` contains the tracked seed playlist and local media fixtures.
- `docs/` contains architecture and operating guidance.
- `infra/` contains the `infra/beam` CDK scaffold for the opt-in AWS `dev` alpha.

## Local Data Flow

1. `sample-content/playlist.local.json` is the tracked seed playlist.
2. `dashboard/local-state/playlist.local.json` and `dashboard/local-state/playlists.local.json` are ignored live playlist state.
3. The dashboard Library writes uploaded local media under ignored `sample-content/assets/*` media paths and stores metadata in ignored local JSON.
4. JPEG and PNG uploads are converted into Pi-safe MP4 still clips before they can enter active playback.
5. The dashboard publishes local media and playlist JSON to a configured Pi with SSH/SCP.
6. The VLC field player reads local playlist/cache files and writes `~/.local/state/pisignage/player-status.json`.
7. The dashboard reads local JSON, optional device-agent heartbeat, and optional Pi SSH probe output to render status and recovery evidence.

## Future Cloud Data Flow

Current cloud alpha data flow is partial and intentionally narrow:

1. App Runner can host the Next.js dashboard container.
2. DynamoDB can back screens, devices, playlists, media catalog records, heartbeat, and activity tables.
3. S3 stores source media and prepared playback media in private buckets.
4. API Gateway/Lambda stores and reads the latest device heartbeat.
5. The dashboard exposes `/api/cloud/devices/{deviceId}/playlist` for a provisioned Pi to fetch its manually published playlist with short-lived signed S3 URLs.
6. The device agent caches fetched playlists and media locally, writes local heartbeat JSON, and keeps local fallback behavior.

Later production cloud data flow:

1. Dashboard publishes playlist metadata and uploads assets.
2. API stores screen, playlist, and assignment records in DynamoDB.
3. Assets are stored in S3 and served through CloudFront signed URLs.
4. Device receives assignment/change notifications over AWS IoT Core MQTT.
5. Device fetches playlist and assets, updates local cache, and continues playback offline.
6. Device sends heartbeat status on a fixed interval.

## Reliability Contracts

- Playback must continue from local cache during network outages.
- Reboot recovery must return the TV to playback without dashboard interaction.
- Heartbeat failures must not stop playback.
- Cloud unavailability must not erase the last known good playlist.
- Local state writes should be atomic where practical.

## Assumptions

- Raspberry Pi OS can run VLC appliance playback as the field path; Chromium/browser playback remains a fallback/experimental path.
- One dashboard account and a small local fleet are enough for the current pilot and soak.
- Playback-safe MP4 assets come before transitions, screenshots, remote reboot, OTA updates, analytics, or fleet management.
- AWS credentials are intentionally unnecessary for local operation. Infrastructure changes require explicit approval and must preserve the local-first playback contract.
