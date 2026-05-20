# Device Setup

This document describes the intended Raspberry Pi appliance direction. The current repo does not yet provide a production installer.

## Target Device

- Raspberry Pi running Raspberry Pi OS.
- TV connected over HDMI.
- Chromium running in kiosk mode.
- Device agent managed by `systemd`.
- Local playlist and asset cache on disk.

## Local POC Flow

For development on a workstation:

```sh
npm install
npm run build
npm run dev:player
npm run agent:heartbeat
```

The player uses the local sample playlist. The device agent writes a heartbeat file to `device-agent/local-state/heartbeat.json`.

## Future Pi Directory Layout

```text
/opt/pisignage/
├── agent/
├── player/
├── cache/
│   ├── playlists/
│   └── assets/
└── state/
    └── heartbeat.json
```

## Kiosk Mode Direction

Future kiosk launch should:

- Start Chromium after the network stack is available, but not depend on the network being online.
- Open the local player URL or bundled local player entrypoint.
- Hide desktop chrome and keep the TV in fullscreen playback.
- Restart Chromium if it exits.

Example direction only:

```text
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:4173
```

## systemd Direction

Future services:

- `pisignage-agent.service`: starts the device agent.
- `pisignage-player.service`: starts the local player server or static host.
- `pisignage-kiosk.service`: starts Chromium kiosk mode.

Services should restart on failure and log to journald.

## Recovery Expectations

- Reboot should return to playback automatically.
- Last known good playlist should survive restart.
- Missing network should not block local playback.
- Heartbeat failures should be logged but should not stop playback.
- Cache cleanup should never delete the currently active asset set.

## Not Implemented Yet

- Production installer.
- Device certificates.
- AWS IoT pairing.
- OTA updates.
- Remote reboot.
- Fleet management.
