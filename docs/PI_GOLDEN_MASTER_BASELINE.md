# PI Golden Master Baseline

Last updated: 2026-07-08 11:54 PDT

## Baseline Rule

C5 is the Beam prototype appliance and the source of truth for the current PI golden master baseline.

Every Pi-touching change deployed to C5 must update this document before the work is considered complete. That includes changes to device-agent behavior, managed Pi scripts, systemd services or drop-ins, VLC/display/playback behavior, schedule enforcement, command-plane actions, heartbeat/current-video reporting, recovery, reset, cache, playlist, and published media behavior.

Every C1-Cx Beam Pi must be built, repaired, or updated from this PI golden master baseline. They should remain identical except intentional identity, network, screen, and location fields:

- hostname
- IP address and network route
- Beam/cloud device ID
- screen ID/name/assignment
- location/group labels
- local API keys and secrets

The previous historical snapshot is `docs/C5_GOLDEN_MODEL_SNAPSHOT_2026-07-03.md`. Use this file, not the historical snapshot, as the current PI golden master baseline.

## Reset For Deployment Contract

Reset for deployment must rebuild the managed Beam appliance surface from this PI golden master source, not from stale local Pi drift.

The reset script defaults to:

```text
--source golden-master --golden-ref main
```

In that mode, `device/pi/bin/pisignage-reset-device.sh` fetches the configured Git remote before restoring tracked managed scripts, systemd units, the first-run playlist, and first-run media assets. The cloud device-agent reset command uses this same `golden-master` source mode.

Reset intentionally preserves per-device identity and field access:

- hostname
- IP address and network settings
- SSH access and OS users
- Beam/cloud device ID
- local API keys and secrets
- screen assignment and location metadata

Reset intentionally clears runtime/publish state:

- playlist publish state
- stale first-run media files
- schedules
- player status
- heartbeat
- device-agent cache

Important packaging note: `device-agent/dist/index.js` is an ignored build artifact, so a git fetch alone does not replace that compiled runtime. When device-agent source changes, build and deploy the compiled device-agent runtime to C5 before updating this baseline, and roll that runtime to every affected C1-Cx appliance when it is reachable.

## Workstation State

- Repo: `/Users/donnoel/Development/PiSignage`
- Branch: `main`
- HEAD before this baseline update: `cb06f41 Move heartbeat check-ins to dedicated device API`
- Dashboard URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`
- Device heartbeat API URL: `https://yebxh6xyvm2nkgq3i2uw2oixda0izozg.lambda-url.us-west-2.on.aws/`

Recent changes incorporated into this baseline:

- Dedicated device heartbeat API:
  - device check-ins use the Lambda Function URL, not the dashboard/App Runner service
  - dashboard heartbeat reads use DynamoDB directly
  - routine heartbeat cadence is `30s` plus up to `5s` jitter
  - legacy App Runner heartbeat route remains only as migration compatibility for older devices until reprovisioned
- Remote diagnostics command plane
- Remote recovery command plane
- Remote audio mute/unmute command support
- Remote screen snapshot command prototype:
  - captures the Pi display output with `grim`
  - compresses a small JPEG preview with `ffmpeg`
  - returns the result through the Beam command plane for operator-requested evidence
- Single audio toggle UI behavior on Screens
- Cloud schedule delivery to Pi agents
- Schedule-aware cloud heartbeat fields:
  - `scheduleState`
  - `scheduleDetail`
  - `scheduleDisplayAction`
  - `scheduleDisplayControlOk`
  - `scheduleOverrideExpiresAt`
- Remote `Open store` command support:
  - creates a local schedule override on the Pi
  - opens display/playback outside scheduled hours
  - returns to normal schedule control after the next scheduled close
- Schedule display recovery hardening:
  - after-hours schedule enforcement prefers verified `wlopm` output power control so closed screens go dark without disabling `HDMI-A-1` in the Wayland session
  - `vcgencmd display_power` is treated as a fallback and verified instead of trusted on exit status alone
  - open-hours schedule enforcement verifies `HDMI-A-1` is powered and enabled before reporting display-on success
  - VLC startup explicitly powers and re-enables `HDMI-A-1` before applying the display mode
- Network transport determinism:
  - device-agent heartbeat prefers `wlan0`, then `eth0`, then any other non-internal IPv4 address
  - Wi-Fi setup applies route metric `50` after successful Wi-Fi configuration so Wi-Fi is preferred when Ethernet and Wi-Fi are both active
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
- Wi-Fi IP at capture: `192.168.100.27` on `wlan0`
- Default route: `192.168.100.1` via `wlan0`, source `192.168.100.27`
- Saved Wi-Fi route preference: `Chicane` has `ipv4.route-metric=50` and `ipv6.route-metric=50` so Wi-Fi is preferred when both transports are active
- SSH user: `donnoel`
- Cloud device ID: `device-c5-aws-pilot`
- Cloud dashboard/playlist URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`
- Cloud heartbeat API URL: `https://yebxh6xyvm2nkgq3i2uw2oixda0izozg.lambda-url.us-west-2.on.aws/`
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
- Display: field TV on `HDMI-A-1`; `wlr-randr` reported make/model as `(null)` at this capture
- Current mode: `1920x1080 px, 60.000000 Hz`
- VLC display output: `HDMI-A-1`
- VLC display mode: `1920x1080@60.000000`
- VLC video output: `wl_shm`
- Wayland display: `wayland-0`

Physical note: during the 2026-07-04 recovery, the monitor only returned to a clean ONN/1080p handshake after the cable was moved back to the Pi port that Linux reports as `HDMI-A-1`. Leave C5 on that port unless deliberately testing display behavior. The appliance display target remains fullscreen `1920x1080@60.000000`; do not accept a lower display mode as healthy playback. If 1080p is missing after a display event, recover the HDMI/compositor mode before considering the Pi healthy.

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

- state: `playing`
- current asset ID: `asset-2025-08-25-apple-eye-care-30-second-ad-signage-1080p`
- current asset path and duration fields present; exact current asset rotates during normal playback

Heartbeat path:

```text
/home/donnoel/.local/state/pisignage/heartbeat.json
```

Heartbeat facts at capture:

- device ID: `device-c5-aws-pilot`
- hostname: `C5`
- local IP: `192.168.100.27`
- app version: `0.1.0`
- current playlist ID: `playlist-community-vision`
- playlist version: `32`
- playback state: `playing`
- network online: `true`
- heartbeat interval: `30s`
- heartbeat jitter: `5s`
- current-video heartbeat field present:
  - `currentAssetId`
- schedule heartbeat fields present:
  - `scheduleState`
  - `scheduleDetail`
  - `scheduleDisplayAction`
  - `scheduleDisplayControlOk`
  - `scheduleOverrideExpiresAt`

At capture time, `heartbeat.json` reported current asset ID `asset-2025-08-25-apple-eye-care-30-second-ad-signage-1080p`, `scheduleState` `on`, and `scheduleDetail` `Schedule window is active. wlopm set HDMI-A-1 on.` This may differ briefly from `player-status.json` because the player can advance between reads.

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
- detail: `Schedule window is active. wlopm set HDMI-A-1 on.`
- display action: `display-on`
- display control ok: `true`
- display output: `HDMI-A-1`

Controlled schedule cycle validation on 2026-07-06:

- forced after-hours evaluation stopped `pisignage-vlc.service`
- after-hours display action used `vcgencmd display_power 0`
- `HDMI-A-1` stayed attached and enabled in `wlr-randr`
- forced open-hours evaluation used `vcgencmd display_power 1`
- `HDMI-A-1` returned at `1920x1080@60.000000`
- `pisignage-vlc.service`, `pisignage-schedule.timer`, and `pisignage-device-agent.service` were active after the cycle
- player status returned to `playing`

Controlled schedule cycle validation on 2026-07-07:

- forced after-hours evaluation stopped `pisignage-vlc.service`
- after-hours display action used `wlopm --off HDMI-A-1`
- `wlopm` reported `HDMI-A-1 off`
- `vcgencmd display_power 0` remained unreliable on this C5 and read back `display_power=1`; it is fallback-only evidence, not the close guarantee
- forced open-hours evaluation used `wlopm --on HDMI-A-1`
- `HDMI-A-1` returned at `1920x1080@60.000000`
- compositor snapshot after reopen showed fullscreen VLC playback with no desktop panel and no Wi-Fi authentication dialog visible
- follow-up heartbeat reported `playbackState: playing`, `scheduleState: on`, and `scheduleDisplayControlOk: true`
- `pisignage-vlc.service`, `pisignage-schedule.timer`, and `pisignage-device-agent.service` were active after the cycle

Natural schedule validation on 2026-07-08:

- operator observed C5 close at the scheduled close and reopen at the scheduled open
- follow-up live check at `2026-07-08T07:47:20-07:00` reported `scheduleState: on`, `playbackState: playing`, and `scheduleDetail: Schedule window is active. wlopm set HDMI-A-1 on.`
- `wlopm` reported `HDMI-A-1 on`
- `pisignage-vlc.service`, `pisignage-schedule.timer`, and `pisignage-device-agent.service` were active after the natural open

Controlled open-store override validation on 2026-07-06:

- forced after-hours open override created local state `override-open`
- override detail reported: `Open store override is active until 2026-07-08T00:00:00.000Z. vcgencmd set HDMI-A-1 on.`
- display action remained `display-on`
- display control ok remained `true`
- override was cleared immediately after validation
- current schedule status returned to `state: on`
- follow-up heartbeat reported `scheduleState: on` and `scheduleOverrideExpiresAt: null`
- `pisignage-vlc.service`, `pisignage-device-agent.service`, and `pisignage-schedule.timer` stayed active

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
60f2e66f5afc2337cf4743229feabbe41cf3cb0fdfeae2dbdfc13c37431e4564  pisignage-configure-wifi.sh
eda895b17ca672f1d9842fb67c6d23b25a52663da3d9636672051cc01627e8e0  pisignage-enforce-schedule.mjs
c577963b8233b225a663319fb95c0411015cf85c5a1635dc2e5e76801cd92a08  pisignage-hide-desktop.sh
051ea589233efa1c66782b5dc7928aa153827bd3e75fd9776736c6518f93bb99  pisignage-install-runtime.sh
a5c9bce76ffee95e7924af4dd9f7cb74fde1aaff0090d4fd9a8466cf32c24e9d  pisignage-provision-device.sh
e9173990a980d64690f542d4c9d5bfab8e7b376f32cc6ee667569cd4d4254784  pisignage-reset-device.sh
bc01cf6dc91e857da42d753361113c7cf979c6f9486e391ba86e38c64b6e71f0  pisignage-serve-player.mjs
5ad55c8d2fb4a027693113f8c9bd2ebd92e83b1619e54468f8e997030d7a52b0  pisignage-start-display.sh
ef486f92112e6919e59c523f1f8fa939ca6baa3ac6b29def775e0b30b983100d  pisignage-vlc-playlist.mjs
```

Managed user services:

```text
c09e0edfa8c32d348bd477aac9610ded953413faa00c607a17f03a30a6d74dd7  pisignage-device-agent.service
6ff1d651e227fd2a7ffd8e68a21de407da90a75cbce87a8670c5bae879ed784b  pisignage-vlc.service
a79d98fd2a9f3dabf6314b413e9501c620862cf2253452ce198a754b6637a42e  pisignage-schedule.service
596b5adad2708f97b21c2cb38fb6798e54dd4b5e95163bfd10ea38c235b27c74  pisignage-schedule.timer
323beab51690837cc6fde5cc58277dbb5b272d167ae991953beb85e0b1741761  pisignage-player.service
7308c0a0cac88246a8e041d21a1c74e7bf88ef8a6500201237b78ee2efe7491f  pisignage-kiosk.service
```

Compiled device agent:

```text
6c206f1b457fd0eaa19127d6e2be1451201f05554c9679e8d7ab62bac4355f35  device-agent/dist/index.js
```

This hash supersedes the 2026-07-07 baseline hash and includes the current command-plane behavior deployed to C5, including schedule-aware heartbeat reporting, the remote Open store action, the remote screen snapshot prototype, deterministic Wi-Fi-first heartbeat address selection, verified `wlopm` display power control for schedule close/open, and 30-second cloud heartbeat check-ins through the dedicated device heartbeat API.

## Required Baseline Update Workflow

Use this workflow for every future Pi-touching C5 prototype change:

1. Make and validate the C5 change live.
2. Confirm C5 playback/display/network/service state is healthy.
3. Update this PI golden master baseline with the new evidence and hashes.
4. Note which C1-Cx appliances still need the change when they are reachable.
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

## C1-Cx Rollout Note

C1-C4 were not reachable from the study at this capture time. They still need to be compared against and, where appropriate, updated to this PI golden master baseline when back at the studio. The same rule applies to every future C1-Cx appliance. In particular, C1-C4 need the 2026-07-07 `wlopm` schedule display power hardening, deterministic Wi-Fi-first heartbeat address selection, Wi-Fi route metric helper behavior, schedule-aware heartbeat runtime, Open store command support, the dedicated device heartbeat API configuration, and the 30-second heartbeat service/runtime before schedule-off/schedule-on and cloud status behavior can be considered fleet-consistent.

For any C1-Cx Beam Pi, always reference this file first. Do not use a previous chat transcript, stale IP address, or old C5 snapshot as the appliance source of truth.

Rollout rule: copy the managed Beam runtime and generated service shape proven on C5, not C5's identity. Preserve or reprovision each Pi's hostname, network configuration, cloud device ID, screen assignment, location label, local API key, and secrets.

Known intentional per-device fields must not be copied blindly:

- hostname
- IP addresses
- cloud device ID
- screen assignment
- location label
- local API key or secrets
