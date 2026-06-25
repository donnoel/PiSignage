# Device Setup

This document covers Raspberry Pi + TV setup for the current local-first Beam appliance path. It is still not a production installer.

## Target Device

- Raspberry Pi running Raspberry Pi OS.
- TV connected over HDMI.
- VLC running fullscreen for field playback, with Chromium kiosk retained as a fallback/experimental path.
- Device agent managed by `systemd`.
- Local playlist and asset cache on disk.

## Recommended Raspberry Pi OS Path

Use Raspberry Pi OS with desktop support for the first TV test because Chromium kiosk mode is the fastest path to visible playback.

Recommended baseline:

- Raspberry Pi OS 64-bit with desktop.
- Enable SSH during imaging if remote terminal access is useful.
- Configure Wi-Fi during imaging if Ethernet is not available.
- Use a named local user with sudo privileges.
- Avoid installing extra packages until the base display and browser path are confirmed.

## First Boot Checklist

1. Connect Pi to TV over HDMI.
2. Boot with keyboard/mouse available for first setup.
3. Confirm TV resolution and overscan look acceptable.
4. Confirm network connection.
5. Open Chromium manually.
6. Confirm local terminal access.
7. Confirm Node.js and npm install path, or install them intentionally.
8. Clone or copy the repo only after display/network basics are proven.
9. Run the local player manually before enabling `systemd`.

## Network Setup Assumptions

- The first device test can run fully local after dependencies are installed.
- Internet is useful for install/update, but playback should not depend on internet.
- The player should use `http://localhost:5173` from the local static player service on the Pi.
- AWS is not required for local playback or recovery testing.
- If Wi-Fi is unreliable, keep validating local playback and reboot recovery.

## C5 Ethernet And Wi-Fi Validation

For study-network testing, use C5 as the only hardware target and prefer
`C5.local` instead of a numeric IP address. That keeps the dashboard target stable
when C5 moves between Ethernet and Wi-Fi.

Initial Wi-Fi credential entry is a local device setup step. Do not commit Wi-Fi
secrets, paste them into docs, or add them to dashboard state. Run the helper on
C5 and let NetworkManager prompt for the Wi-Fi password:

```sh
device/pi/bin/pisignage-configure-wifi.sh
```

The helper accepts an optional `--ssid` value, but it deliberately has no
password flag. NetworkManager owns the credential prompt and stores the resulting
network profile on the Pi.

Use this validation sequence for C5:

1. With Ethernet connected, confirm dashboard Troubleshooting can reach
   `C5.local`, the Network diagnostic reports the active transport, and
   `pisignage-vlc.service`, `pisignage-device-agent.service`, and
   `pisignage-schedule.timer` are active.
2. Publish the assigned playlist to C5 and confirm the TV keeps playing through
   the VLC field path.
3. Configure Wi-Fi on C5, then unplug Ethernet after the Wi-Fi connection is
   ready.
4. Wait for `C5.local`/SSH to recover over Wi-Fi, refresh Troubleshooting, and
   confirm the Network diagnostic reports Wi-Fi activity without exposing SSID
   or credential details.
5. Force one call-home check-in, then confirm the hosted dashboard row shows the
   current call-home address and last check-in evidence:

   ```sh
   device/pi/bin/pisignage-call-home-now.sh
   ```

6. Repeat publish, heartbeat, restart-VLC, and visible-TV playback checks while
   Ethernet is unplugged.
7. Reboot C5 with Ethernet unplugged and confirm unattended fullscreen playback
   returns.
8. Interrupt the network only after cached playback is visible; playback should
   continue locally. Reconnect Wi-Fi and confirm heartbeat/status recover.
9. Reconnect Ethernet and run a light publish/status check to confirm Beam still
   works on the physical cable path.

Reset validation for this workflow should use:

```sh
device/pi/bin/pisignage-reset-device.sh --dry-run
```

Do not run reset with `--apply` unless the operator explicitly approves clearing
playlist/media/status/cache state.

## Local POC Flow

For development on a workstation:

```sh
npm install
npm run dev:player
npm run agent:heartbeat
```

For unattended Pi playback, build the player and run the local static server:

```sh
npm --workspace player run build
npm run serve:player
```

The player uses the local sample playlist served from `sample-content/`. The
static server serves the built player shell from `player/dist`, but keeps
`/playlist.local.json` and `/assets/*` backed by live `sample-content` files so
local dashboard publishes do not require rebuilding. The device agent writes a
last-known-good playlist cache and heartbeat files:

```text
device-agent/local-cache/playlists/current.json
device-agent/local-state/heartbeat.json
```

## Device Configuration

Use `device-agent/config.example.json` as the local config shape. The current agent reads environment variables; the config file documents the intended stable values for Pi provisioning.

Current environment variable mapping:

```text
PISIGNAGE_DEVICE_ID=device-local-demo
PISIGNAGE_PLAYLIST_PATH=/opt/pisignage/sample-content/playlist.local.json
PISIGNAGE_CACHE_DIR=/opt/pisignage/cache
PISIGNAGE_HEARTBEAT_PATH=/opt/pisignage/state/heartbeat.json
PISIGNAGE_NETWORK_ONLINE=false
```

## Future Pi Directory Layout

```text
/opt/pisignage/
├── app/
│   ├── dashboard/
│   ├── device-agent/
│   ├── player/
│   └── sample-content/
├── cache/
│   ├── playlists/
│   └── assets/
├── config/
│   └── device.json
├── logs/
└── state/
    └── heartbeat.json
```

## Local Cache Directory Plan

- `cache/playlists/current.json`: last-known-good playlist.
- `cache/playlists/{playlistId}.json`: playlist cache by ID.
- `cache/assets/{assetId}/`: future downloaded asset cache.
- Cache cleanup must never delete the currently active asset set.
- Cache writes should be atomic where practical.

## Logs And Status Files

Expected status paths:

```text
~/.local/state/pisignage/heartbeat.json
```

When running under `systemd`, prefer `journalctl` first:

```sh
journalctl --user -u pisignage-device-agent.service -n 100 --no-pager
journalctl --user -u pisignage-player.service -n 100 --no-pager
journalctl --user -u pisignage-kiosk.service -n 100 --no-pager
```

## Chromium Display Modes

During hands-on testing, launch Chromium in operator mode so normal window controls
remain available after exiting the player's fullscreen button:

```sh
/usr/bin/chromium --start-maximized --no-first-run --autoplay-policy=no-user-gesture-required http://localhost:5173/
```

Use kiosk mode only when the TV should behave as an unattended display:

```sh
/usr/bin/chromium --kiosk --start-fullscreen --no-first-run --autoplay-policy=no-user-gesture-required http://localhost:5173/
```

The player's `Fullscreen` button controls webpage fullscreen only. It cannot
restore minimize/window controls when Chromium itself was launched with `--kiosk`.

If the Pi image uses a different Chromium binary, check:

```sh
which chromium-browser
which chromium
```

Display expectations:

- Browser opens directly to the player.
- Operator mode permits leaving fullscreen and minimizing Chromium while testing.
- Kiosk mode fills the visible TV area without window controls.
- Fullscreen playback survives page refresh.
- No dashboard interaction is needed for playback.

## systemd Device-Agent Service

The source-controlled user service is:

```text
device/pi/systemd/user/pisignage-device-agent.service
```

It runs the long-lived compiled device-agent heartbeat loop with local
cache/state paths under the Pi user's home directory. Device identity and
optional cloud heartbeat settings live in an ignored local env file so API keys
are never committed.

Build the agent, then provision the Pi identity before enabling the service:

```sh
npm --workspace device-agent run build

device/pi/bin/pisignage-provision-device.sh \
  --device-id device-c5-aws-pilot \
  --dashboard-url https://your-dashboard.awsapprunner.com \
  --api-url https://your-api-id.execute-api.us-west-2.amazonaws.com/dev \
  --api-key 'replace-with-dev-api-key' \
  --environment dev \
  --install-service \
  --enable-service
```

The script writes:

```text
~/.config/pisignage/device-agent.env
~/.config/pisignage/device.json
```

`device-agent.env` is mode `600` and may contain the dev API key. `device.json`
is a non-secret identity summary for troubleshooting. For fully local operation,
run the same script with only `--device-id`. In that mode the agent still reads
the local playlist, writes local heartbeat JSON, and logs that cloud work was
skipped.

For cloud mode, the provisioned `--device-id` must match the saved device record
in Beam inventory. The cloud playlist route and heartbeat route both use that
same ID, so migrate the dashboard inventory and Pi env together when renaming a
device away from `device-local-demo`.

Inspect the installed user service:

```sh
systemctl --user status pisignage-device-agent.service --no-pager
```

Inspect the local heartbeat and service logs:

```sh
cat ~/.local/state/pisignage/heartbeat.json
journalctl --user -u pisignage-device-agent.service -n 100 --no-pager
```

## systemd Player Service

The source-controlled user service is:

```text
device/pi/systemd/user/pisignage-player.service
```

The service builds the player bundle before startup, then serves it with the
local static server instead of Vite dev mode. This keeps reboot recovery local
and avoids a development server in field-style playback.

## systemd Display Browser Service

The tracked display launcher waits for the player server and selects either
operator or kiosk mode:

```text
device/pi/bin/pisignage-start-display.sh
device/pi/systemd/user/pisignage-kiosk.service
```

The checked-in service defaults to field/appliance mode:

```ini
Environment=PISIGNAGE_DISPLAY_MODE=kiosk
```

Install or update the tracked services and launcher for the current user:

```sh
install -Dm755 device/pi/bin/pisignage-start-display.sh ~/.local/bin/pisignage-start-display.sh
install -Dm644 device/pi/systemd/user/pisignage-player.service ~/.config/systemd/user/pisignage-player.service
install -Dm644 device/pi/systemd/user/pisignage-kiosk.service ~/.config/systemd/user/pisignage-kiosk.service
install -Dm644 device/pi/systemd/user/pisignage-device-agent.service ~/.config/systemd/user/pisignage-device-agent.service
systemctl --user daemon-reload
systemctl --user enable --now pisignage-player.service pisignage-kiosk.service pisignage-device-agent.service
```

In kiosk mode, Chromium uses an isolated PiSignage profile and avoids desktop
keyring prompts with `--password-store=basic`. It also opens the player with
`display=signage`, which hides the player overlay. To temporarily switch back to
operator mode for testing, change `PISIGNAGE_DISPLAY_MODE` to `operator`, reload
the user service, and restart it:

```sh
systemctl --user daemon-reload
systemctl --user restart pisignage-kiosk.service
```

Validate the Chromium path and display environment on the Pi before enabling on a
new device.

The launcher also forces the primary HDMI output to `1920x1080@60.000000` with
`wlr-randr` when available. This avoids unstable post-power-loss negotiation with
4K TV modes. Override `PISIGNAGE_DISPLAY_OUTPUT` or
`PISIGNAGE_DISPLAY_RESOLUTION` only when a specific screen requires it.

## Native VLC Video Player

The Chromium kiosk path remains useful for the web player, operator views, and
browser-based diagnostics. For video playback durability testing, the repo also
includes a native VLC playlist runner:

```text
device/pi/bin/pisignage-vlc-playlist.mjs
device/pi/systemd/user/pisignage-vlc.service
```

The runner reads `sample-content/playlist.local.json`, resolves local video
assets from `sample-content/assets/`, and plays the playlist with one continuous
`cvlc` process in fullscreen mode. It keeps the display at
`1920x1080@60.000000`, waits briefly for the display session during boot, writes
local playback status JSON, and restarts VLC when the playlist file changes.
The field service forces VLC to use the Wayland shared-memory video output so a
successful player process also creates a visible fullscreen surface in the Pi
desktop session.

Validate the playlist without taking over the TV:

```sh
node device/pi/bin/pisignage-vlc-playlist.mjs --dry-run
```

Install the tracked VLC service for the current user:

```sh
install -Dm755 device/pi/bin/pisignage-vlc-playlist.mjs ~/.local/bin/pisignage-vlc-playlist.mjs
install -Dm644 device/pi/systemd/user/pisignage-vlc.service ~/.config/systemd/user/pisignage-vlc.service
systemctl --user daemon-reload
```

Only one TV player should own the display during a field test. To compare VLC
against Chromium, stop the kiosk service before starting VLC:

```sh
systemctl --user stop pisignage-kiosk.service
systemctl --user start pisignage-vlc.service
```

If VLC becomes the preferred field player, enable it and disable the Chromium
kiosk service:

```sh
systemctl --user disable --now pisignage-kiosk.service
systemctl --user enable --now pisignage-vlc.service
```

Inspect the local playback status file:

```sh
cat ~/.local/state/pisignage/player-status.json
```

## Schedule Enforcement

The dashboard publishes simple business-hours schedules to
`sample-content/schedules.local.json` on the Pi. The Pi can enforce that cached
file without network access by running a one-shot schedule script on a timer:

```text
device/pi/bin/pisignage-enforce-schedule.mjs
device/pi/systemd/user/pisignage-schedule.service
device/pi/systemd/user/pisignage-schedule.timer
```

The script reads the cached schedule file, checks `PISIGNAGE_SCREEN_ID`, and
starts or stops `pisignage-vlc.service` when the assigned screen is inside or
outside its active window. Inside an active window it wakes the HDMI output
before starting playback. Outside the active window it stops playback and turns
the HDMI output off so business-closed hours are visibly dark. If no schedule is
assigned to the screen, playback and display power are left alone.

Validate schedule evaluation without changing VLC:

```sh
node device/pi/bin/pisignage-enforce-schedule.mjs --dry-run
```

Install the tracked schedule timer for the current user:

```sh
install -Dm755 device/pi/bin/pisignage-enforce-schedule.mjs ~/.local/bin/pisignage-enforce-schedule.mjs
install -Dm644 device/pi/systemd/user/pisignage-schedule.service ~/.config/systemd/user/pisignage-schedule.service
install -Dm644 device/pi/systemd/user/pisignage-schedule.timer ~/.config/systemd/user/pisignage-schedule.timer
systemctl --user daemon-reload
systemctl --user enable --now pisignage-schedule.timer
```

Inspect the local schedule status file:

```sh
cat ~/.local/state/pisignage/schedule-status.json
```

## Reboot Recovery Plan

Manual recovery expectations:

1. Start player and open kiosk manually.
2. Confirm playlist is visible on TV.
3. Run `npm run agent:heartbeat`, then enable `pisignage-device-agent.service`.
4. Reboot the Pi.
5. Confirm services start only if installed.
6. Confirm kiosk returns to playback.
7. Disconnect network after local assets are available.
8. Confirm playback continues from local files/cache.

Do not treat recovery as supported until it passes on real hardware.

## Manual Validation Checklist For TV Testing

Use this once the Pi and TV are available:

- TV receives HDMI signal after boot.
- Desktop resolution fits the screen.
- Browser can open `http://localhost:5173`.
- Player image is visible and not cropped unexpectedly.
- Operator mode can exit fullscreen and minimize Chromium.
- Kiosk mode hides browser chrome when deliberately enabled.
- `npm run agent:heartbeat` writes heartbeat JSON.
- `pisignage-device-agent.service` keeps heartbeat JSON fresh after reboot.
- Dashboard shows updated heartbeat when viewed locally.
- Missing network does not stop already-visible playback.
- Browser refresh returns to the playlist.
- Pi reboot returns to playback after services are configured.
- Logs show actionable status without secrets.

## Not Implemented Yet

- Production installer.
- Device certificates.
- AWS IoT pairing.
- OTA updates.
- Remote reboot as a default recovery response.
- Fleet management.
