# Device Setup

This document prepares for Raspberry Pi + TV testing without assuming the hardware is available today. It is a plan and checklist, not a production installer.

## Target Device

- Raspberry Pi running Raspberry Pi OS.
- TV connected over HDMI.
- Chromium running in kiosk mode.
- Device agent managed by `systemd`.
- Local playlist and asset cache on disk.

## Recommended Raspberry Pi OS Path

Use Raspberry Pi OS with desktop support for the first TV test because Chromium kiosk mode is the fastest path to visible playback.

Recommended tomorrow:

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
- The player should use `http://localhost:5173` or a local static preview service.
- AWS is not required for tomorrow’s test.
- If Wi-Fi is unreliable, keep validating local playback and reboot recovery.

## Local POC Flow

For development on a workstation or Pi:

```sh
npm install
npm run dev:player
npm run agent:heartbeat
```

The player uses the local sample playlist served from `sample-content/`. The device agent writes a last-known-good playlist cache and heartbeat files:

```text
device-agent/local-cache/playlists/current.json
device-agent/local-state/heartbeat.json
```

## Device Configuration

Use `device-agent/config.example.json` as the local config shape. The current agent still reads environment variables; the config file documents the intended values for tomorrow’s setup.

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
/opt/pisignage/state/heartbeat.json
/opt/pisignage/logs/agent.log
```

When running under `systemd`, prefer `journalctl` first:

```sh
journalctl -u pisignage-agent.service -n 100 --no-pager
journalctl -u pisignage-player.service -n 100 --no-pager
journalctl -u pisignage-kiosk.service -n 100 --no-pager
```

## Chromium Kiosk Mode Plan

Manual first test:

```sh
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:5173
```

If the Pi image uses a different Chromium binary, check:

```sh
which chromium-browser
which chromium
```

Kiosk expectations:

- Browser opens directly to the player.
- Player fills the visible TV area.
- Fullscreen playback survives page refresh.
- No dashboard interaction is needed for playback.

## systemd Device-Agent Service Draft

Draft only. Do not install until manual playback works.

```ini
[Unit]
Description=PiSignage Device Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/pisignage/app
Environment=PISIGNAGE_DEVICE_ID=device-local-demo
Environment=PISIGNAGE_PLAYLIST_PATH=/opt/pisignage/app/sample-content/playlist.local.json
Environment=PISIGNAGE_CACHE_DIR=/opt/pisignage/cache
Environment=PISIGNAGE_HEARTBEAT_PATH=/opt/pisignage/state/heartbeat.json
Environment=PISIGNAGE_NETWORK_ONLINE=false
ExecStart=/usr/bin/npm run agent:heartbeat
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

The current `agent:heartbeat` command runs once and exits. A recurring agent loop is a future implementation task; for tomorrow, use manual runs or a timer if needed.

## systemd Player Service Draft

Draft only.

```ini
[Unit]
Description=PiSignage Player Dev Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pisignage/app
ExecStart=/usr/bin/npm run dev:player
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

For a later appliance build, replace the dev server with a static preview/server command.

## systemd Kiosk Service Draft

Draft only. The display environment can vary by Raspberry Pi OS version.

```ini
[Unit]
Description=PiSignage Chromium Kiosk
After=graphical.target pisignage-player.service
Wants=pisignage-player.service

[Service]
Type=simple
Environment=DISPLAY=:0
ExecStart=/usr/bin/chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:5173
Restart=on-failure
RestartSec=10

[Install]
WantedBy=graphical.target
```

Validate the exact Chromium path and display environment on the Pi before enabling.

## Reboot Recovery Plan

Manual recovery expectations for tomorrow:

1. Start player and open kiosk manually.
2. Confirm playlist is visible on TV.
3. Run `npm run agent:heartbeat`.
4. Reboot the Pi.
5. Confirm services start only if installed.
6. Confirm kiosk returns to playback.
7. Disconnect network after local assets are available.
8. Confirm playback continues from local files/cache.

Do not treat recovery as supported until it passes on real hardware.

## Manual Validation Checklist For TV Testing

Use this tomorrow once the Pi and TV are available:

- TV receives HDMI signal after boot.
- Desktop resolution fits the screen.
- Browser can open `http://localhost:5173`.
- Player image is visible and not cropped unexpectedly.
- Fullscreen/kiosk mode hides browser chrome.
- `npm run agent:heartbeat` writes heartbeat JSON.
- Dashboard shows updated heartbeat when viewed locally.
- Missing network does not stop already-visible playback.
- Browser refresh returns to the playlist.
- Pi reboot returns to playback after services are configured.
- Logs show actionable status without secrets.

## Not Implemented Yet

- Production installer.
- Long-running device-agent loop.
- Device certificates.
- AWS IoT pairing.
- OTA updates.
- Remote reboot.
- Fleet management.
