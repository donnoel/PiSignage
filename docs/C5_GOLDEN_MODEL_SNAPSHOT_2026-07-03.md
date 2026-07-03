# C5 Golden Model Snapshot - 2026-07-03

Captured from the workstation and live C5 on 2026-07-03 around 08:40 PDT.

## Purpose

C5 is the current Beam appliance model for the next studio bring-up. C1-C4 should be brought to this same managed baseline, except for intentional identity/network fields:

- hostname
- IP address
- Beam/cloud device ID
- screen name and screen assignment
- location/group labels

Everything Beam-managed should match: user service units, Pi scripts, device-agent runtime, VLC player behavior, cache layout, heartbeat behavior, schedule timer behavior, and current-video reporting.

## Workstation State

- Repo: `/Users/donnoel/Development/PiSignage`
- Branch: `main`
- HEAD: `ee31bdf Keep screen selection restore on whats playing`
- Working tree at capture time: clean
- Dashboard URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`

## C5 Identity

- Hostname: `C5`
- Reachable host: `C5.local`
- Current IP: `192.168.100.24`
- Network route: Wi-Fi via `wlan0`, default gateway `192.168.100.1`
- SSH user: `donnoel`
- Cloud device ID: `device-c5-aws-pilot`
- Cloud playlist URL: `https://8yyptjawdv.us-west-2.awsapprunner.com/api/cloud/devices/device-c5-aws-pilot/playlist`
- Cloud API URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`
- API key: configured locally on C5 and redacted from this snapshot

## Runtime Baseline

- OS: `Debian GNU/Linux 13 (trixie)`
- Kernel: `Linux C5 6.18.33+rpt-rpi-v8 #1 SMP PREEMPT Debian 1:6.18.33-1+rpt1 (2026-06-01) aarch64`
- Node: `v20.19.2`
- npm: unavailable from shell during this capture
- VLC: `VLC version 3.0.23 Vetinari (3.0.23-2-0-g79128878dd)`
- Chromium: `Chromium 148.0.7778.167 built on Debian GNU/Linux 13 (trixie)`
- User linger: `Linger=no`
- C5 repo checkout: `5c98362`, dirty/stale; do not use C5 git HEAD as the source of truth

## Managed Service State

| Unit | Enabled | Active state | Substate | Notes |
| --- | --- | --- | --- | --- |
| `pisignage-device-agent.service` | enabled | active | running | Main PID `67613`; no restarts reported |
| `pisignage-vlc.service` | enabled | active | running | Main PID `67668`; no restarts reported |
| `pisignage-schedule.timer` | enabled | active | running | Runs schedule enforcement every minute |
| `pisignage-schedule.service` | static | transient active during capture | start | One-shot service invoked by timer |
| `pisignage-player.service` | disabled | inactive | dead | Browser player remains fallback/experimental |
| `pisignage-kiosk.service` | disabled | inactive | dead | Browser kiosk remains fallback/experimental |

Active processes:

- Device agent: `/usr/bin/node /home/donnoel/PiSignage/device-agent/dist/index.js --loop`
- VLC controller: `/usr/bin/node /home/donnoel/.local/bin/pisignage-vlc-playlist.mjs`
- VLC player: `/usr/bin/vlc` with cached media from `/home/donnoel/.local/cache/pisignage/device-agent/assets`

## Display Baseline

- Output: `HDMI-A-1`
- Display: `ONN 100147048`
- Current mode: `1920x1080 px, 60.000000 Hz`
- VLC service environment:
  - `DISPLAY=:0`
  - `XDG_RUNTIME_DIR=/run/user/1000`
  - `WAYLAND_DISPLAY=wayland-0`
  - `PISIGNAGE_DISPLAY_OUTPUT=HDMI-A-1`
  - `PISIGNAGE_DISPLAY_RESOLUTION=1920x1080@60.000000`
  - `PISIGNAGE_VLC_VIDEO_OUTPUT=wl_shm`
  - `PISIGNAGE_VLC_PLAYBACK_MODE=continuous`
  - `PISIGNAGE_PLAYLIST_HANDOFF_OVERLAP_MS=2500`
  - `PISIGNAGE_VLC_RESTART_BACKOFF_MS=15000`
  - `PISIGNAGE_VLC_RESTART_BACKOFF_MAX_MS=120000`
  - `PISIGNAGE_STATUS_PATH=/home/donnoel/.local/state/pisignage/player-status.json`
  - `PISIGNAGE_CONTENT_ROOT=/home/donnoel/.local/cache/pisignage/device-agent`
  - `PISIGNAGE_PLAYLIST_FILE=playlists/current.json`

## Current Playback Evidence

Player status path:

- `/home/donnoel/.local/state/pisignage/player-status.json`

Current player facts:

- mode: `vlc`
- state: `playing`
- playlist path: `/home/donnoel/.local/cache/pisignage/device-agent/playlists/current.json`
- playlist ID: `playlist-community-vision`
- playlist name: `Community Vision`
- playlist version: `32`
- asset count in active playlist: `29`
- quarantined assets: none
- last error: none
- current-video reporting fields present:
  - `currentAssetId`
  - `currentAssetPath`
  - `currentAssetDurationSeconds`

At capture time, `player-status.json` reported:

- current asset ID: `asset-2026-03-20-country-financial-revision-signage-1080p`
- current asset path: `/home/donnoel/.local/cache/pisignage/device-agent/assets/2026-03-20-Country-Financial-Revision.signage-1080p.mp4`
- current asset duration: `29.951s`

Heartbeat path:

- `/home/donnoel/.local/state/pisignage/heartbeat.json`

Current heartbeat facts:

- device ID: `device-c5-aws-pilot`
- hostname: `C5`
- local IP: `192.168.100.24`
- app version: `0.1.0`
- current playlist ID: `playlist-community-vision`
- playlist version: `32`
- playback state: `playing`
- network online: `true`
- disk free bytes: `19685220352`
- current-video heartbeat field present:
  - `currentAssetId`

At capture time, `heartbeat.json` reported current asset ID `asset-2026-03-17-c-h-window-cleaning-with-music-signage-1080p`. This may differ from `player-status.json` for a short window because the player can advance between the two reads.

## Schedule Evidence

Schedule status path:

- `/home/donnoel/.local/state/pisignage/schedule-status.json`

Current schedule facts:

- screen ID: `screen-primary`
- schedule path: `/home/donnoel/PiSignage/sample-content/schedules.local.json`
- service: `pisignage-vlc.service`
- state: `unassigned`
- action: `none`
- detail: `No schedule is assigned to this screen. Playback is not schedule-limited.`

## Cache And Playlist Baseline

Playlist cache directory:

- `/home/donnoel/.local/cache/pisignage/device-agent/playlists`

Playlist hashes:

```text
f3630ae5edbe67456cd21eb4df7324028dee82887d28ebc1707d431cb18e2ad2  current.json
f3630ae5edbe67456cd21eb4df7324028dee82887d28ebc1707d431cb18e2ad2  playlist-community-vision.json
2d4a88d742eb52eaf36e638c2fa1d2e112d2ab44e2cc953870568077386bc2e9  playlist-donnoel.json
591339147f2f358232c50f9c7e43fa0e2be3c7a6749fc608926997251bac42f8  playlist-main-playlist.json
0fe9fa1922924a77114c3fa26183d60eb221894a6caad65224a282c8711601e8  playlist-most-high-holy-rabbi-jeffry.json
```

Asset cache directory:

- `/home/donnoel/.local/cache/pisignage/device-agent/assets`

Cached asset files:

- total cached files: `31`
- active playlist asset count: `29`
- extra cached files are acceptable cache residue unless they replace or block active playlist playback

## Managed File Hashes

These hashes matched between the workstation repo and C5 installed managed files at capture time.

Managed Pi scripts:

```text
75104faff5c772e90230edc1a9a560549f131ab63e2bb048309958aa70c30ba1  pisignage-call-home-now.sh
714c3dbf585980c3cb8829f7f88b280f0bb1e6026b3890b41b4153434eb4d577  pisignage-configure-wifi.sh
62b80a17a594556c1bfd3fa8095d7596179ad9a35ea77cb9e102d46e660bb0c4  pisignage-enforce-schedule.mjs
c577963b8233b225a663319fb95c0411015cf85c5a1635dc2e5e76801cd92a08  pisignage-hide-desktop.sh
d5b0d4e750e068a8e7666ddb3d26014c9bb0b3e70cfe46fd3789a299a5cc3578  pisignage-install-runtime.sh
76e47c87c4afb21b8d682c4a58542aae072328fc0789b9b7492b788bd5c4f56d  pisignage-provision-device.sh
d29401576124591b2b834aaae6b6a296412931737bef6aa999e9c8043d070593  pisignage-reset-device.sh
bc01cf6dc91e857da42d753361113c7cf979c6f9486e391ba86e38c64b6e71f0  pisignage-serve-player.mjs
5ad55c8d2fb4a027693113f8c9bd2ebd92e83b1619e54468f8e997030d7a52b0  pisignage-start-display.sh
fedafe95d4405cb2edfce5d28585b593f9b4f3a763f9a3936dd0d0e21ab87d2b  pisignage-vlc-playlist.mjs
```

Managed user services:

```text
cc2b91728f1fa9eb7b11b1ae62ff3a7a85340c36c5a49ffb76b54940cb90bbb8  pisignage-device-agent.service
7308c0a0cac88246a8e041d21a1c74e7bf88ef8a6500201237b78ee2efe7491f  pisignage-kiosk.service
ae7252d0fc886f5fc134c8e4f7a677b01ee391371cec79583b0077f4465755ec  pisignage-player.service
46b769fd2b619074811c9a6958f15d654969f1e508059ca95b4fe14ada5b8317  pisignage-schedule.service
596b5adad2708f97b21c2cb38fb6798e54dd4b5e95163bfd10ea38c235b27c74  pisignage-schedule.timer
726a6456ab2d877ba1b7ece992fba006679598cab550578806684b02e9e33aa1  pisignage-vlc.service
```

Compiled device agent:

```text
5a028206129f02f1189969f5978b2bf60a192181920dd5b91514dc475dd1caae  device-agent/dist/index.js
```

Managed device assets:

```text
50d0c8de376fb2760219ea9caf6c778ed421e66e731fdc5601bf6aebea124ff1  device/pi/assets/ad-dad-logo.png
feac26778e52d042e4b8c3661321498439ee45fcb1000713dfee13cc4a17e9e6  device/pi/assets/ad-dad-logo.ppm
```

## Studio Bring-Up Checklist

For each C1-C4 when the studio network is reachable:

1. Confirm SSH access via stable hostnames `C1.local`, `C2.local`, `C3.local`, and `C4.local`.
2. Preserve per-device identity fields:
   - hostname
   - current IP/network route
   - cloud device ID
   - screen ID/name/location
3. Confirm OS/runtime baseline:
   - Debian 13 or intentional OS baseline
   - Node `v20.19.2`
   - VLC `3.0.23`
   - Chromium `148.0.7778.167`
4. Install or refresh the same managed scripts and user services from the workstation repo.
5. Copy or build the same `device-agent/dist/index.js` runtime hash:
   - `5a028206129f02f1189969f5978b2bf60a192181920dd5b91514dc475dd1caae`
6. Confirm service state:
   - `pisignage-device-agent.service`: enabled/active/running
   - `pisignage-vlc.service`: enabled/active/running
   - `pisignage-schedule.timer`: enabled/active/running
   - `pisignage-player.service`: disabled/inactive
   - `pisignage-kiosk.service`: disabled/inactive
7. Confirm display and VLC environment:
   - output `HDMI-A-1`
   - mode `1920x1080@60.000000`
   - VLC video output `wl_shm`
   - content root `/home/donnoel/.local/cache/pisignage/device-agent`
   - playlist file `playlists/current.json`
8. Confirm `player-status.json` reports:
   - `state: playing`
   - `playlistPath` under device-agent cache
   - current playlist ID/version
   - `currentAssetId`
   - `currentAssetPath`
   - `currentAssetDurationSeconds`
   - no quarantined assets
   - no last error
9. Confirm `heartbeat.json` reports:
   - correct device ID
   - correct hostname/IP
   - `networkOnline: true`
   - `playbackState: playing`
   - `currentAssetId`
10. Confirm Dashboard shows each device online and playing.
11. Confirm local-first behavior:
   - restart the device agent only when safe
   - verify VLC keeps playing cached media
   - verify current-video reporting recovers in heartbeat/status after restart

## Do Not Drift

Do not let C1-C4 differ from this C5 baseline in:

- managed script hashes
- managed user service hashes
- compiled device-agent runtime hash
- VLC field player service behavior
- current-video reporting fields in `player-status.json` and `heartbeat.json`
- cache directory structure
- heartbeat interval
- schedule timer behavior
- local cached playback contract

Only identity, network, and screen-assignment fields should differ.

## Studio Bring-Up Result - 2026-07-03

C1-C4 were reachable at the studio on 2026-07-03 and were refreshed from the C5 golden package:

```text
3118094654769ca8686655126600119d481a0b976ebd33d3ad4e2053669e00fc  beam-c5-golden-20260703.tgz
```

Per-device identity was preserved while the managed Beam scripts, user services, and compiled device-agent runtime were refreshed. The cloud playlist and heartbeat endpoints were updated to the current dashboard:

- `https://8yyptjawdv.us-west-2.awsapprunner.com`

The local API key on each Pi was preserved and was not copied into the repository.

| Host | IP | Device ID | Player | Heartbeat | UI check |
| --- | --- | --- | --- | --- | --- |
| `C1` | `192.168.1.131` | `device-c1-aws-pilot` | playing, current asset reported | playing, current asset reported | working |
| `C2` | `192.168.1.64` | `device-c2-aws-pilot` | playing, current asset reported | playing, current asset reported | working |
| `C3` | `192.168.1.169` | `device-c3-aws-pilot` | playing, current asset reported | playing, current asset reported | working |
| `C4` | `192.168.1.177` | `device-c4-aws-pilot` | playing, current asset reported | playing, current asset reported after call-home | working |

Validated managed hashes on C1-C4:

```text
fedafe95d4405cb2edfce5d28585b593f9b4f3a763f9a3936dd0d0e21ab87d2b  pisignage-vlc-playlist.mjs
d29401576124591b2b834aaae6b6a296412931737bef6aa999e9c8043d070593  pisignage-reset-device.sh
5a028206129f02f1189969f5978b2bf60a192181920dd5b91514dc475dd1caae  device-agent/dist/index.js
726a6456ab2d877ba1b7ece992fba006679598cab550578806684b02e9e33aa1  pisignage-vlc.service
cc2b91728f1fa9eb7b11b1ae62ff3a7a85340c36c5a49ffb76b54940cb90bbb8  pisignage-device-agent.service
```

Validated service state on C1-C4:

| Unit | Expected state |
| --- | --- |
| `pisignage-device-agent.service` | enabled, active |
| `pisignage-vlc.service` | enabled, active |
| `pisignage-schedule.timer` | enabled, active |
| `pisignage-player.service` | disabled, inactive |
| `pisignage-kiosk.service` | disabled, inactive |

C4 required a manual call-home check after the refresh before it appeared correctly in the dashboard. The call-home completed successfully, wrote a heartbeat with `currentAssetId`, and the dashboard then showed all C1-C4 working.
