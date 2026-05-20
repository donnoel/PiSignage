# Architecture

PiSignage is a small digital signage proof of concept with three runtime surfaces:

- Dashboard: the operator UI for one account and one screen.
- Device agent: the Raspberry Pi background process responsible for local state, heartbeat, cache, and future MQTT communication.
- Player: the fullscreen playback surface shown on the TV.

The near-term architecture is local-first. AWS is documented but not deployed.

## Target Shape

```text
Dashboard -> API Gateway/Lambda -> DynamoDB
                         |
                         v
                        S3 -> CloudFront -> Player asset URLs

AWS IoT Core MQTT <-> Device Agent -> local playlist/cache -> Player
```

In the current POC, cloud services are replaced by local JSON fixtures.

## Repository Boundaries

- `dashboard/` contains the Next.js dashboard mock.
- `device-agent/` contains the local Raspberry Pi agent skeleton.
- `player/` contains the fullscreen playback app.
- `sample-content/` contains local playlists and mock media.
- `docs/` contains architecture and operating guidance.
- `infra/` is reserved for future IaC and must not deploy real resources yet.

## Local Data Flow

1. `sample-content/playlist.local.json` defines a single local playlist.
2. The player loads that playlist fixture and renders the current image full-viewport.
3. The device agent reads the same playlist fixture.
4. The device agent writes `device-agent/local-state/heartbeat.json` atomically.
5. The dashboard shows mocked screen, playlist, and status data.

## Future Cloud Data Flow

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

- Raspberry Pi OS runs Chromium in kiosk mode.
- One device is paired to one account for the initial POC.
- Image playback comes before video, scheduling, screenshots, and remote control.
- AWS credentials and infrastructure are intentionally absent until a later approved phase.
