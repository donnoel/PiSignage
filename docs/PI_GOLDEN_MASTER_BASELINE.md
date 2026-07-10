# PI Golden Master Baseline

Last updated: 2026-07-10 06:17 PDT

## Baseline Rule

The PI Golden Master is the Beam appliance source of truth. C5 is the current
prototype evidence source for this baseline, but the target state is C1-C5 all
matching the Golden Master except documented identity and network fields.

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
- HEAD before this baseline update: `8d11388 Consolidate screen operations navigation`
- Dashboard URL: `https://8yyptjawdv.us-west-2.awsapprunner.com`
- Device heartbeat API URL: `https://yebxh6xyvm2nkgq3i2uw2oixda0izozg.lambda-url.us-west-2.on.aws/`

Recent changes incorporated into this baseline:

- Golden Master remote administration automation:
  - `device/pi/bin/pisignage-install-runtime.sh` installs and enables Tailscale, WayVNC, noVNC, and websockify when remote access is enabled
  - remote access is part of the appliance baseline, not a C5-only manual addition
  - the installer supports noninteractive Tailscale enrollment with an auth key supplied outside git through `PISIGNAGE_TAILSCALE_AUTHKEY`
  - the installer uses a per-device tailnet hostname such as `beam-c1`, `beam-c2`, or `beam-c5`
  - Tailscale is started with `--accept-dns=false` so it does not take over Pi DNS behavior
  - `device/pi/bin/pisignage-reset-device.sh` now preserves and re-enables the remote access services during reset when those packages are present

- Dedicated device heartbeat API:
  - device check-ins use the Lambda Function URL, not the dashboard/App Runner service
  - dashboard heartbeat reads use DynamoDB directly
  - routine heartbeat cadence is `30s` plus up to `5s` jitter
  - devices with Tailscale installed report `tailscaleIpAddress` in the heartbeat so Beam can prefer the tailnet address for remote SSH/noVNC controls while retaining the local LAN IP as fallback evidence
  - legacy App Runner heartbeat route remains only as migration compatibility for older devices until reprovisioned
- Tailscale proof:
  - C5 is joined to the test tailnet as `beam-c5`
  - C5 tailnet IPv4 address at capture: `100.66.60.59`
  - C5 tailnet DNS name at capture: `beam-c5.tail2e97b2.ts.net.`
  - Tailscale was started with `--accept-dns=false` so it does not take over Pi DNS behavior
  - production rollout must replace the temporary test tailnet with the production Beam tailnet, tags, ACLs, and account ownership
- Remote diagnostics command plane
- Remote recovery command plane
- Remote audio mute/unmute command support
- Remote desktop prototype on C5:
  - dashboard opens a browser-based noVNC page served from the Pi on port `6080`
  - C5 runs system WayVNC on port `5900`
  - C5 runs `pisignage-remote-desktop.service`, which serves noVNC with `websockify` and bridges to `127.0.0.1:5900`
  - C5 currently uses `enable_auth=false` in `/etc/wayvnc/config` because noVNC must connect to WayVNC without the Apple Screen Sharing PAM/VeNCrypt path
  - the Beam `Show desktop` button opens the browser desktop view and queues a Pi action to pause managed VLC signage playback and the schedule timer for remote administration
  - `Show desktop` restores the Raspberry Pi desktop shell by ensuring `pcmanfm --desktop` is running, restarting `wf-panel-pi`, and waiting for both processes before reporting success, so noVNC shows the admin panel instead of a blank black desktop
  - if `Show desktop` cannot restore the desktop panel, the device-agent reports the panel log tail and resumes VLC playback automatically rather than leaving the appliance on a black remote desktop
  - the Beam `Resume playback` button queues a Pi action to restart managed VLC signage playback and restore schedule control after remote administration
  - the Beam `Restart playback` recovery action also restores schedule control so remote administration cannot leave the schedule timer paused after playback recovery
  - the browser desktop path works from both macOS and Windows clients on the same trusted network
  - until Tailscale ACLs are in place, this prototype should only be used on trusted local networks or over the test tailnet
  - C1-C5 should all carry the same remote access package and service baseline
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
  - screens with no assigned schedule are actively treated as open: schedule enforcement powers the display on and starts VLC instead of leaving playback unchanged
  - VLC startup explicitly powers and re-enables `HDMI-A-1` before applying the display mode
- Network transport determinism:
  - device-agent heartbeat prefers `wlan0`, then `eth0`, then any other non-internal IPv4 address
  - Wi-Fi setup applies route metric `50` after successful Wi-Fi configuration so Wi-Fi is preferred when Ethernet and Wi-Fi are both active
- Cloud media upload/prep hardening and S3 upload path
- Strict playlist cache parity:
  - the active device-agent media cache is a mirror of the currently published playlist
  - matching cached assets are skipped by size/checksum, so adding one playlist item downloads only that new or changed file
  - after a successful release sync, stale cache files not referenced by the current playlist are pruned
  - routine check-ins still fetch only tiny release/heartbeat metadata and do not return media URLs unless an asset is missing or changed
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
- Remote desktop packages: `novnc` `1:1.6.0-2`, `websockify` `0.12.0+dfsg1-4+b1`
- Remote access package: `tailscale` `1.98.8`
- Schedule/display recovery hardening:
  - schedule open and VLC startup detect the `NOOP-1` headless-output state seen after scheduled close/open recovery
  - when `HDMI-A-1` is reported but disabled while `NOOP-1` is active, the appliance restarts the user display session and retries the configured HDMI output/mode
  - the appliance target remains `HDMI-A-1` at `1920x1080@60.000000`; do not blindly accept a display's preferred mode as healthy playback

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

Fleet display note: C1-C3 and C5 are ONN displays in the current pilot. C4 is a Philips TV that advertises 4K preferred modes and may require explicit return to the configured `1920x1080@60.000000` appliance target after HDMI/display wake events.

## Managed Service State

| Unit | Enabled | Active state | Substate | Notes |
| --- | --- | --- | --- | --- |
| `pisignage-device-agent.service` | enabled | active | running | Cloud command plane and heartbeat runtime |
| `pisignage-vlc.service` | enabled | active | running | VLC playback path |
| `pisignage-schedule.timer` | enabled | active | running | Runs schedule enforcement every minute |
| `pisignage-schedule.service` | static | transient | start | One-shot schedule enforcement |
| `wayvnc.service` | enabled | active | running | System WayVNC remote desktop backend on port `5900`; C5 config uses `enable_auth=false` for noVNC compatibility |
| `pisignage-remote-desktop.service` | enabled | active | running | Browser remote desktop bridge; serves noVNC on port `6080` and proxies to `127.0.0.1:5900` |
| `tailscaled.service` | enabled | active | running | Tailscale tunnel for remote administration across networks; appliance must be enrolled with its own per-device tailnet identity |
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

Controlled Open store validation on 2026-07-06:

- forced after-hours Open store created temporary local state `override-open`
- temporary-open detail reported: `Open store override is active until 2026-07-08T00:00:00.000Z. vcgencmd set HDMI-A-1 on.`
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

Playlist content:

```text
playlist-community-vision@32
29 assets
19831a243ae3a3af78fd1edfa6fa37a31ce7e4d049f385f86258bbf263bcd67f  normalized playlist content fingerprint
```

Raw playlist JSON file hashes can differ across appliances because device-local runtime metadata or serialization order is not a Golden Master contract. The normalized playlist identity, version, ordered asset identity, duration, checksum, and size are the parity surface.

Asset cache directory:

```text
/home/donnoel/.local/cache/pisignage/device-agent/assets
```

Cached asset facts:

- cached files: `29`
- active playlist asset count: `29`
- cache size: `286M`
- active media fingerprint: `4afa76fdf340146f0ae18bb7151e9ea5989b8dbccfa45afe81c7a53b1f7a342d`
- cache parity contract: the asset cache must contain only files referenced by the currently published playlist
- sync behavior: matching cached files are skipped by size/checksum; missing or changed files are downloaded individually; unreferenced files are pruned after successful sync

## Managed File Hashes

Managed Pi scripts:

```text
75104faff5c772e90230edc1a9a560549f131ab63e2bb048309958aa70c30ba1  pisignage-call-home-now.sh
60f2e66f5afc2337cf4743229feabbe41cf3cb0fdfeae2dbdfc13c37431e4564  pisignage-configure-wifi.sh
60450768a4112232cb1f594b49d17d50f1907c2f13057cbed753cf99b48ced31  pisignage-enforce-schedule.mjs
c577963b8233b225a663319fb95c0411015cf85c5a1635dc2e5e76801cd92a08  pisignage-hide-desktop.sh
dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200  pisignage-install-runtime.sh
a5c9bce76ffee95e7924af4dd9f7cb74fde1aaff0090d4fd9a8466cf32c24e9d  pisignage-provision-device.sh
6e5757eebb2f1fc1b61a7570b5a9bb1e9a6fb1c33c352af2040d3031388cb082  pisignage-reset-device.sh
bc01cf6dc91e857da42d753361113c7cf979c6f9486e391ba86e38c64b6e71f0  pisignage-serve-player.mjs
5ad55c8d2fb4a027693113f8c9bd2ebd92e83b1619e54468f8e997030d7a52b0  pisignage-start-display.sh
f251573e687f88f4f956de61b044b2e376368d01424c71a2f5d539495e139d6c  pisignage-vlc-playlist.mjs
```

Managed user services:

```text
2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116  pisignage-device-agent.service
6ff1d651e227fd2a7ffd8e68a21de407da90a75cbce87a8670c5bae879ed784b  pisignage-vlc.service
a79d98fd2a9f3dabf6314b413e9501c620862cf2253452ce198a754b6637a42e  pisignage-schedule.service
596b5adad2708f97b21c2cb38fb6798e54dd4b5e95163bfd10ea38c235b27c74  pisignage-schedule.timer
323beab51690837cc6fde5cc58277dbb5b272d167ae991953beb85e0b1741761  pisignage-player.service
7308c0a0cac88246a8e041d21a1c74e7bf88ef8a6500201237b78ee2efe7491f  pisignage-kiosk.service
efbe213d6bc3b7d38351592ff0312d7f2320f7f3919b491b6221a4b5a6cfab8c  pisignage-remote-desktop.service
```

Compiled device agent:

```text
6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2  device-agent/dist/index.js
```

These hashes supersede the 2026-07-09 13:57 baseline hashes and include the current command-plane behavior deployed to C1-C5, including schedule-aware heartbeat reporting, the remote Open store action, the remote screen snapshot prototype, remote Show desktop and Resume playback actions that pause and restore schedule control, Restart playback recovery that restores schedule control, Show desktop desktop-panel restoration and verification for noVNC administration, automatic playback resume if desktop-panel restoration fails, deterministic Wi-Fi-first heartbeat address selection, Tailscale tailnet address reporting, verified `wlopm` display power control for schedule close/open, no-schedule playback enforcement that actively powers on display and starts VLC, automatic HDMI/headless-output display session recovery, 30-second cloud heartbeat check-ins through the dedicated device heartbeat API, Golden Master-managed remote access installation/enrollment support, and strict device-agent cache parity that prunes stale unreferenced media after successful release sync.

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
systemctl status tailscaled.service --no-pager
tailscale ip -4
wlr-randr
cat ~/.local/state/pisignage/player-status.json
cat ~/.local/state/pisignage/heartbeat.json
cat ~/.local/state/pisignage/schedule-status.json
sha256sum ~/.local/bin/pisignage-*.sh ~/.local/bin/pisignage-*.mjs
sha256sum ~/.config/systemd/user/pisignage-*.service ~/.config/systemd/user/pisignage-*.timer
sha256sum /home/donnoel/PiSignage/device-agent/dist/index.js
```

## C1-Cx Rollout Note

C1-C4 were refreshed from the then-current PI golden master baseline at the studio on 2026-07-08. On 2026-07-09, C1-C4 were updated in place with the Golden Master remote access package and service baseline:

- `tailscale` installed and `tailscaled.service` enabled/active
- `wayvnc` installed and `wayvnc.service` enabled/active
- `novnc` and `websockify` installed for the browser desktop bridge
- `pisignage-remote-desktop.service` enabled/active
- refreshed managed runtime install and reset scripts in both the repo checkout and `~/.local/bin`

Tailnet enrollment for C1-C4 was completed in the temporary test tailnet on 2026-07-09. Production provisioning must use a pre-authorized Tailscale auth key supplied outside git so a Golden Master image can enroll each Pi automatically with its own hostname.

After test-tailnet approval on 2026-07-09, C1-C5 tailnet identities were:

| Pi | Tailnet hostname | Tailnet IPv4 |
| --- | --- | --- |
| C1 | `beam-c1` | `100.108.135.20` |
| C2 | `beam-c2` | `100.95.194.15` |
| C3 | `beam-c3` | `100.86.155.95` |
| C4 | `beam-c4` | `100.85.111.13` |
| C5 | `beam-c5` | `100.66.60.59` |

Rollout payload:

```text
939d944c58a4087528a30832e1b635434098f07fd9624661773dfd37d3a56284  /tmp/beam-pi-golden-20260708-d489690.tgz
```

The rollout preserved each Pi's identity and network fields, then refreshed the Beam-managed scripts, generated user services, first-run playlist/media, and compiled device-agent runtime. The private device-agent env on C1-C4 was also corrected to use the dedicated device heartbeat API URL while preserving each device's API key value. Stale `audio.conf` VLC drop-ins that forced audio off were removed from C2-C4 so the only remaining VLC drop-in on C1-C4 is the expected cloud cache override.

Validated C1-C4 after rollout and remote access package refresh:

| Pi | IP | Device ID | Dedicated heartbeat API | Agent hash | Remote access services | Managed script hashes | Cloud heartbeat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | `192.168.1.131` | `device-c1-aws-pilot` | configured | `6c206f1b457fd0eaa19127d6e2be1451201f05554c9679e8d7ab62bac4355f35` | `tailscaled`, `wayvnc`, `pisignage-remote-desktop` active | install `687ee167727965ae68bfac6e1461fa0d54d3a79e62fb85b9d09e0bf46bab583e`; reset `6e5757eebb2f1fc1b61a7570b5a9bb1e9a6fb1c33c352af2040d3031388cb082` | playing, playlist `playlist-community-vision` v32 |
| C2 | `192.168.1.64` | `device-c2-aws-pilot` | configured | `6c206f1b457fd0eaa19127d6e2be1451201f05554c9679e8d7ab62bac4355f35` | `tailscaled`, `wayvnc`, `pisignage-remote-desktop` active | install `687ee167727965ae68bfac6e1461fa0d54d3a79e62fb85b9d09e0bf46bab583e`; reset `6e5757eebb2f1fc1b61a7570b5a9bb1e9a6fb1c33c352af2040d3031388cb082` | playing, playlist `playlist-community-vision` v32 |
| C3 | `192.168.1.169` | `device-c3-aws-pilot` | configured | `6c206f1b457fd0eaa19127d6e2be1451201f05554c9679e8d7ab62bac4355f35` | `tailscaled`, `wayvnc`, `pisignage-remote-desktop` active | install `687ee167727965ae68bfac6e1461fa0d54d3a79e62fb85b9d09e0bf46bab583e`; reset `6e5757eebb2f1fc1b61a7570b5a9bb1e9a6fb1c33c352af2040d3031388cb082` | playing, playlist `playlist-community-vision` v32 |
| C4 | `192.168.1.177` | `device-c4-aws-pilot` | configured | `6c206f1b457fd0eaa19127d6e2be1451201f05554c9679e8d7ab62bac4355f35` | `tailscaled`, `wayvnc`, `pisignage-remote-desktop` active | install `687ee167727965ae68bfac6e1461fa0d54d3a79e62fb85b9d09e0bf46bab583e`; reset `6e5757eebb2f1fc1b61a7570b5a9bb1e9a6fb1c33c352af2040d3031388cb082` | playing, playlist `playlist-community-vision` v32 |

On all four Pis, `pisignage-device-agent.service`, `pisignage-vlc.service`, `pisignage-schedule.timer`, `pisignage-remote-desktop.service`, `tailscaled.service`, and `wayvnc.service` were active after the remote access package refresh. `pisignage-player.service` and `pisignage-kiosk.service` remain disabled and inactive. Forced call-home completed through the dedicated device heartbeat API on all four devices before this remote access refresh.

2026-07-10 Show desktop stabilization rollout:

| Pi | Tailnet IPv4 | Device-agent hash | Device-agent service hash | Runtime installer hash | Post-rollout service state |
| --- | --- | --- | --- | --- | --- |
| C1 | `100.108.135.20` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC inactive because schedule closed |
| C2 | `100.95.194.15` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC inactive because schedule closed |
| C3 | `100.86.155.95` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC inactive because schedule closed |
| C4 | `100.85.111.13` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC inactive because schedule closed |
| C5 | `100.66.60.59` | `6694b4f3e4bc79db01bc24556d47de9b07596e175fe4ce97dab4b6ccf709cbb2` | `2e8aaa558b8409fd55f9bdfdd0a19550868bed03628316688a5b65037f967116` | `dbc71d0eff8d95880e72c870f2f0db1e766bdde1e0170cc236ecd9a624be1200` | device-agent active; schedule timer active; VLC active after Resume playback |

C5 live validation after the rollout: Show desktop succeeded in the browser noVNC session, then Resume playback returned VLC to `active/running`; local player status and heartbeat both reported `playing` on playlist `playlist-community-vision` v32.

The same rule applies to every future C1-Cx appliance.

For any C1-Cx Beam Pi, always reference this file first. Do not use a previous chat transcript, stale IP address, or old C5 snapshot as the appliance source of truth.

Rollout rule: copy the managed Beam runtime and generated service shape proven on C5, not C5's identity. Preserve or reprovision each Pi's hostname, network configuration, cloud device ID, screen assignment, location label, local API key, and secrets.

Known intentional per-device fields must not be copied blindly:

- hostname
- IP addresses
- cloud device ID
- screen assignment
- location label
- local API key or secrets
