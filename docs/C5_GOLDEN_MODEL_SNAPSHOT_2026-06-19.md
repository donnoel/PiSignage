# C5 Golden Model Snapshot - 2026-06-19

Captured from the workstation and C5 on 2026-06-19 around 08:22 PDT.

## Purpose

C5 is the current working Beam appliance model. C1-C4 should be brought back to this same managed baseline, except for intentional identity/network fields:

- hostname
- IP address
- Beam/cloud device ID
- screen name and screen assignment
- location/group labels

Everything managed by Beam should match: service units, Pi scripts, device-agent runtime, VLC player path, cache layout, heartbeat behavior, and local-first playback behavior.

## Workstation State

- Repo: `/Users/donnoel/Development/PiSignage`
- Branch: `main`
- Latest local commits:
  - `beda6fd Bridge device heartbeats through dashboard`
  - `5c98362 Repair App Runner redeploy path`
  - `a7dae27 Add publish-gated cloud release sync`
- At capture time, the working tree had one local UI polish change:
  - `dashboard/app/device-health-fleet-panel.tsx`
  - Clicking `Publish required` now changes that device row to `Publishing...`.
  - This UI change passed dashboard typecheck.
- AWS CLI read-only checks were blocked because the local AWS session had expired.

## Cloud/Dashboard Baseline

- Region: `us-west-2`
- Dashboard App Runner URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`
- Current model is publish-gated:
  - idle devices send heartbeat/status only
  - release manifests/assets move only after manual publish
  - cached assets are reused by checksum
  - local cached playback must survive cloud/network loss
- Budget guardrail exists in AWS console:
  - `beam-dev-daily-cost-guardrail`
  - `$1/day`
  - email destination configured during setup

## C5 Identity

- Hostname: `C5`
- SSH host/IP: `192.168.100.34`
- User: `donnoel`
- Cloud device ID: `device-c5-aws-pilot`
- Cloud playlist URL: `https://8yyptjawdv.us-west-2.awsapprunner.com/api/cloud/devices/device-c5-aws-pilot/playlist`
- Cloud API URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`
- API key: redacted; do not commit or paste it into docs.

## C5 Runtime State

Captured from C5:

- `pisignage-device-agent.service`: active
- `pisignage-vlc.service`: active
- `pisignage-schedule.timer`: active
- `pisignage-player.service`: inactive
- `pisignage-kiosk.service`: inactive

C5 is running:

- Device agent: `/usr/bin/node /home/donnoel/PiSignage/device-agent/dist/index.js --loop`
- VLC controller: `/usr/bin/node /home/donnoel/.local/bin/pisignage-vlc-playlist.mjs`
- VLC playback: `/usr/bin/vlc` with local cached media files from `/home/donnoel/.local/cache/pisignage/device-agent/assets`

Recent C5 device-agent evidence:

- `cloud.release.unchanged`
- `playlist.ready` from source `cache`
- `cloud.heartbeat.complete`
- release ID: `release-playlist-main-playlist-v107-f23fdb6fc219e9e0`
- manifest checksum: `f23fdb6fc219e9e09b3b0d8ad5ac61e0770bc2a162a0c2b6796e178c96d2db62`

Recent C5 VLC evidence:

- On 2026-06-17 it fell back to `playlist-first-run-fallback` with 1 asset.
- On 2026-06-19 at 08:12 PDT it returned to `playlist-main-playlist` version 107 with 12 assets.
- This fallback incident is important: when repairing C1-C4, verify local-first behavior so cloud/API interruption does not replace good cached playback with fallback.

## C5 Player Status

Current player status path:

- `/home/donnoel/.local/state/pisignage/player-status.json`

Current player facts:

- mode: `vlc`
- state: `playing`
- display output: `HDMI-A-1`
- display mode: `1920x1080@60.000000`
- playlist path: `/home/donnoel/.local/cache/pisignage/device-agent/playlists/current.json`
- playlist ID: `playlist-main-playlist`
- playlist version: `107`
- asset count: `12`
- quarantined assets: none
- last error: none

Current heartbeat path:

- `/home/donnoel/.local/state/pisignage/heartbeat.json`

Current heartbeat facts:

- device ID: `device-c5-aws-pilot`
- hostname: `C5`
- local IP: `192.168.100.34`
- app version: `0.1.0`
- current playlist ID: `playlist-main-playlist`
- playlist version: `107`
- playback state: `playing`
- network online: `true`
- disk free: about `19.9 GB`

## C5 Cache Counts

- cached asset files: `13`
- cached playlist files: `3`
- actively playing assets: `12`

The extra cached asset is acceptable as cache residue; the active playlist has 12 assets and no quarantines.

## Managed File Hashes

These hashes match between the workstation repo/build output and C5 at snapshot time:

```text
cc2b91728f1fa9eb7b11b1ae62ff3a7a85340c36c5a49ffb76b54940cb90bbb8  pisignage-device-agent.service
f88178de10763a2a25328a9083a88f14a122b9cc44d4a30eedc2e54007be05bf  pisignage-vlc.service
a597a1abe90713125c788ff390fd617147ad6487f194ac0f6d20089d0267a933  pisignage-vlc-playlist.mjs
1925340e192bdef988b057085765de50968790d2e20c1c7a2886cd0f6ad118a0  device-agent/dist/index.js
```

Use these as the first parity checks for C1-C4.

## C5 Repo Note

C5's `~/PiSignage` checkout reported:

- Git HEAD: `5c98362`
- Working tree: `D sample-content/assets/welcome.svg`

Do not use C5 git HEAD alone as the parity source. The running managed files and hashes above are the appliance baseline.

## C1-C4 Initial Studio State

Before studio repair, local inventory and live checks showed:

| Screen | Device | Host | Current dashboard state |
| --- | --- | --- | --- |
| C1 | C1 Pi | `192.168.1.130` | SSH reachable, services active, playing fallback |
| C2 | C2 Pi | `192.168.1.71` | SSH reachable, services active, playing fallback |
| C3 | C3 Pi | `192.168.1.168` | SSH reachable, services active, playing fallback |
| C4 | C4 Pi | `192.168.1.175` | SSH reachable, services active, playing fallback |
| C5 | C5 Pi | `192.168.100.34` | online/playing model |

C1-C4 initially had matching service/script hashes, but their compiled device-agent runtime was stale and their cloud URLs pointed at the retired App Runner/API Gateway endpoints.

## Studio Bring-Up Result

Completed on 2026-06-19 around 09:07 PDT.

For C1-C4:

- Preserved each Pi's hostname, IP address, and cloud device ID.
- Copied the current compiled `device-agent/dist/index.js`.
- Updated private device env URLs to the current App Runner dashboard:
  - `PISIGNAGE_CLOUD_PLAYLIST_URL=https://8yyptjawdv.us-west-2.awsapprunner.com/api/cloud/devices/<device-id>/playlist`
  - `PISIGNAGE_CLOUD_API_URL=https://8yyptjawdv.us-west-2.awsapprunner.com`
- Restarted `pisignage-device-agent.service`.
- Published `playlist-main-playlist` v107 through the dashboard publish API for each device.
- Verified `pisignage-device-agent.service`, `pisignage-vlc.service`, and `pisignage-schedule.timer` were active.
- Verified `pisignage-player.service` and `pisignage-kiosk.service` remained inactive, matching C5.

Final live verification:

| Screen | Device ID | Player status | Heartbeat status | Asset count |
| --- | --- | --- | --- | --- |
| C1 | `device-c1-aws-pilot` | `playlist-main-playlist` v107 playing | `playlist-main-playlist` v107 playing | 12 |
| C2 | `device-c2-aws-pilot` | `playlist-main-playlist` v107 playing | `playlist-main-playlist` v107 playing | 12 |
| C3 | `device-c3-aws-pilot` | `playlist-main-playlist` v107 playing | `playlist-main-playlist` v107 playing | 12 |
| C4 | `device-c4-aws-pilot` | `playlist-main-playlist` v107 playing | `playlist-main-playlist` v107 playing | 12 |

All four studio Pis matched the C5 golden managed hashes after repair:

```text
cc2b91728f1fa9eb7b11b1ae62ff3a7a85340c36c5a49ffb76b54940cb90bbb8  pisignage-device-agent.service
f88178de10763a2a25328a9083a88f14a122b9cc44d4a30eedc2e54007be05bf  pisignage-vlc.service
a597a1abe90713125c788ff390fd617147ad6487f194ac0f6d20089d0267a933  pisignage-vlc-playlist.mjs
1925340e192bdef988b057085765de50968790d2e20c1c7a2886cd0f6ad118a0  device-agent/dist/index.js
```

C5 was not reachable from the studio network during final verification, so final C1-C5 live parity is inferred from the earlier C5 snapshot plus matching C1-C4 managed hashes.

## Studio Bring-Up Checklist

For each C1-C4:

1. Confirm SSH access and hostname/IP.
2. Preserve device-specific identity fields.
3. Install or refresh the same managed service units and scripts as C5.
4. Copy/build the same `device-agent/dist/index.js` runtime as C5.
5. Configure cloud URLs to the App Runner dashboard, with the correct unique device ID.
6. Enable and start user services:
   - `pisignage-device-agent.service`
   - `pisignage-vlc.service`
   - `pisignage-schedule.timer`
7. Verify `player-status.json` reports:
   - `state: playing`
   - `playlistId: playlist-main-playlist`
   - `playlistVersion: 107`
   - `assetCount: 12`
   - no quarantined assets
8. Verify `heartbeat.json` reports:
   - the correct per-device ID
   - the correct hostname/IP
   - `networkOnline: true`
   - `playbackState: playing`
9. Verify dashboard shows the device online.
10. Confirm local-first behavior:
    - restart the device agent
    - interrupt cloud/API briefly if safe
    - verify VLC keeps playing cached playlist instead of reverting to fallback

## Do Not Drift

Do not let C1-C4 differ from C5 in:

- service unit contents
- Pi script contents
- device-agent compiled runtime
- VLC player command behavior
- local cache directory structure
- heartbeat interval
- playback status path
- manual publish/cache contract

Only identity/network/screen assignment fields should differ.
