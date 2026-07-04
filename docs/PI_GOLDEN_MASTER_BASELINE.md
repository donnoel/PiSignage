# PI Golden Master Baseline

Last updated: 2026-07-04 08:50 PDT

## Baseline Rule

C5 is the Beam prototype appliance and the source of truth for the current PI golden master baseline.

Every Pi-touching change deployed to C5 must update this document before the work is considered complete. That includes changes to device-agent behavior, managed Pi scripts, systemd services or drop-ins, VLC/display/playback behavior, schedule enforcement, command-plane actions, heartbeat/current-video reporting, recovery, reset, cache, playlist, and published media behavior.

C1-C4 and any future Beam Pi must be built, repaired, or updated from this PI golden master baseline. They should remain identical except intentional identity, network, screen, and location fields:

- hostname
- IP address and network route
- Beam/cloud device ID
- screen ID/name/assignment
- location/group labels
- local API keys and secrets

The previous historical snapshot is `docs/C5_GOLDEN_MODEL_SNAPSHOT_2026-07-03.md`. Use this file, not the historical snapshot, as the current PI golden master baseline.

## Workstation State

- Repo: `/Users/donnoel/Development/PiSignage`
- Branch: `main`
- HEAD at capture: `2059255 Use one audio toggle on screens`
- Dashboard URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`

Recent changes incorporated into this baseline:

- Remote diagnostics command plane
- Remote recovery command plane
- Remote audio mute/unmute command support
- Single audio toggle UI behavior on Screens
- Cloud schedule delivery to Pi agents
- Cloud media upload/prep hardening and S3 upload path
- C5 emergency recovery cleanup after failed HDMI rescue:
  - removed stray `donnoel` line from `/boot/firmware/cmdline.txt`
  - removed temporary firmware HDMI hardening from `/boot/firmware/config.txt`
  - removed temporary HDMI recovery service drop-ins
  - restored working display path to `HDMI-A-1` at `1920x1080@60.000000`

## C5 Identity

- Hostname: `C5`
- Reachable host: `C5.local`
- Wired IP at capture: `192.168.100.34` on `eth0`
- Wi-Fi IP at capture: `192.168.100.26` on `wlan0`
- Default route: `192.168.100.1` via `eth0`, with `wlan0` as secondary route
- SSH user: `donnoel`
- Cloud device ID: `device-c5-aws-pilot`
- Cloud API URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`
- API key: configured locally on C5 and intentionally redacted from this baseline

## Runtime Baseline

- OS: `Debian GNU/Linux 13 (trixie)`, `DEBIAN_VERSION_FULL=13.5`
- Kernel: `Linux C5 6.18.33+rpt-rpi-v8 #1 SMP PREEMPT Debian 1:6.18.33-1+rpt1 (2026-06-01) aarch64`
- Node: `v20.19.2`
- VLC: `VLC version 3.0.23 Vetinari (3.0.23-2-0-g79128878dd)`
- Chromium: `Chromium 148.0.7778.167 built on Debian GNU/Linux 13 (trixie)`

## Boot And Display Baseline

`/boot/firmware/cmdline.txt` must be one single line and must not contain a forced `video=` override:

```text
console=serial0,115200 console=tty1 root=PARTUUID=58e53866-02 rootfstype=ext4 fsck.repair=yes rootwait quiet splash plymouth.ignore-serial-consoles cfg80211.ieee80211_regdom=US ds=nocloud;i=rpi-imager-1779386244658
```

`/boot/firmware/config.txt` must not contain the temporary HDMI recovery hardening block:

```text
# PiSignage HDMI recovery hardening
hdmi_force_hotplug=1
hdmi_group=1
hdmi_mode=16
config_hdmi_boost=7
```

Display state at capture:

- Output: `HDMI-A-1`
- Display: `ONN 100147048`
- Current mode: `1920x1080 px, 60.000000 Hz`
- VLC display output: `HDMI-A-1`
- VLC display mode: `1920x1080@60.000000`
- VLC video output: `wl_shm`
- Wayland display: `wayland-0`

Physical note: during the 2026-07-04 recovery, the monitor only returned to a clean ONN/1080p handshake after the cable was moved back to the Pi port that Linux reports as `HDMI-A-1`. Leave C5 on that port unless deliberately testing display behavior.

## Managed Service State

| Unit | Enabled | Active state | Substate | Notes |
| --- | --- | --- | --- | --- |
| `pisignage-device-agent.service` | enabled | active | running | Cloud command plane and heartbeat runtime |
| `pisignage-vlc.service` | enabled | active | running | VLC playback path |
| `pisignage-schedule.timer` | enabled | active | running | Runs schedule enforcement every minute |
| `pisignage-schedule.service` | static | transient | start | One-shot schedule enforcement |
| `pisignage-player.service` | disabled | inactive | dead | Browser player fallback/experimental |
| `pisignage-kiosk.service` | disabled | inactive | dead | Browser kiosk fallback/experimental |

Allowed VLC service drop-in at capture:

```text
/home/donnoel/.config/systemd/user/pisignage-vlc.service.d/10-cloud-cache.conf
```

No temporary display recovery drop-ins should remain in either:

```text
/home/donnoel/.config/systemd/user/pisignage-vlc.service.d/
/home/donnoel/.config/systemd/user/pisignage-schedule.service.d/
```

## Current Playback Evidence

Player status path:

```text
/home/donnoel/.local/state/pisignage/player-status.json
```

Current player facts at capture:

- mode: `vlc`
- state: `playing`
- playlist path: `/home/donnoel/.local/cache/pisignage/device-agent/playlists/current.json`
- playlist ID: `playlist-community-vision`
- playlist version: `32`
- asset count in active playlist: `29`
- display output: `HDMI-A-1`
- display mode: `1920x1080@60.000000`
- audio mode: `on`
- quarantined assets: none
- last error: none
- current-video reporting fields present:
  - `currentAssetId`
  - `currentAssetPath`
  - `currentAssetDurationSeconds`

At capture time, `player-status.json` reported:

- current asset ID: `asset-2102-still-10s`
- current asset path: `/home/donnoel/.local/cache/pisignage/device-agent/assets/2102.still-10s.mp4`
- current asset duration: `10`

Heartbeat path:

```text
/home/donnoel/.local/state/pisignage/heartbeat.json
```

Heartbeat facts at capture:

- device ID: `device-c5-aws-pilot`
- hostname: `C5`
- local IP: `192.168.100.34`
- app version: `0.1.0`
- current playlist ID: `playlist-community-vision`
- playlist version: `32`
- playback state: `playing`
- network online: `true`
- disk free bytes: `19750252544`
- current-video heartbeat field present:
  - `currentAssetId`

At capture time, `heartbeat.json` reported current asset ID `asset-union-county-fair-2026-signage-1080p`. This may differ briefly from `player-status.json` because the player can advance between reads.

## Schedule Evidence

Schedule status path:

```text
/home/donnoel/.local/state/pisignage/schedule-status.json
```

Current schedule facts at capture:

- screen ID: `screen-primary`
- schedule path: `/home/donnoel/PiSignage/sample-content/schedules.local.json`
- service: `pisignage-vlc.service`
- state: `on`
- action: `start`
- active schedule name: `Customer 5 hours`
- detail: `Schedule window is active. wlr-randr set HDMI-A-1 on.`
- display action: `display-on`
- display control ok: `true`
- display output: `HDMI-A-1`

## Cache And Playlist Baseline

Playlist cache directory:

```text
/home/donnoel/.local/cache/pisignage/device-agent/playlists
```

Playlist hashes:

```text
85516347f03a2f7e7a0628982b39cc13e82ee030c526e0ef1ad176161e7929eb  current.json
85516347f03a2f7e7a0628982b39cc13e82ee030c526e0ef1ad176161e7929eb  playlist-community-vision.json
```

Asset cache directory:

```text
/home/donnoel/.local/cache/pisignage/device-agent/assets
```

Cached asset facts:

- cached files: `29`
- active playlist asset count: `29`
- cache size: `286M`

## Managed File Hashes

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
726a6456ab2d877ba1b7ece992fba006679598cab550578806684b02e9e33aa1  pisignage-vlc.service
46b769fd2b619074811c9a6958f15d654969f1e508059ca95b4fe14ada5b8317  pisignage-schedule.service
596b5adad2708f97b21c2cb38fb6798e54dd4b5e95163bfd10ea38c235b27c74  pisignage-schedule.timer
ae7252d0fc886f5fc134c8e4f7a677b01ee391371cec79583b0077f4465755ec  pisignage-player.service
7308c0a0cac88246a8e041d21a1c74e7bf88ef8a6500201237b78ee2efe7491f  pisignage-kiosk.service
```

Compiled device agent:

```text
5d4512bf6062de8df0369017b5eea50a0582129fca0f55d1b8b7b85f14bf66b4  device-agent/dist/index.js
```

This hash supersedes the 2026-07-03 baseline hash and includes the current command-plane behavior deployed to C5.

## Required Baseline Update Workflow

Use this workflow for every future Pi-touching C5 prototype change:

1. Make and validate the C5 change live.
2. Confirm C5 playback/display/network/service state is healthy.
3. Update this PI golden master baseline with the new evidence and hashes.
4. Note whether C1-C4 still need the change when they are reachable.
5. Do not call the Pi work complete until this file is current.

Minimum live validation before updating this baseline:

```text
hostname
ip -4 addr show scope global
systemctl --user status pisignage-device-agent.service --no-pager
systemctl --user status pisignage-vlc.service --no-pager
systemctl --user status pisignage-schedule.timer --no-pager
wlr-randr
cat ~/.local/state/pisignage/player-status.json
cat ~/.local/state/pisignage/heartbeat.json
cat ~/.local/state/pisignage/schedule-status.json
sha256sum ~/.local/bin/pisignage-*.sh ~/.local/bin/pisignage-*.mjs
sha256sum ~/.config/systemd/user/pisignage-*.service ~/.config/systemd/user/pisignage-*.timer
sha256sum /home/donnoel/PiSignage/device-agent/dist/index.js
```

## C1-C4 And Future Pi Rollout Note

C1-C4 were not reachable from the study at this capture time. They still need to be compared against and, where appropriate, updated to this PI golden master baseline when back at the studio.

For C1-C4 or any new Beam Pi, always reference this file first. Do not use a previous chat transcript, stale IP address, or old C5 snapshot as the appliance source of truth.

Known intentional per-device fields must not be copied blindly:

- hostname
- IP addresses
- cloud device ID
- screen assignment
- location label
- local API key or secrets

