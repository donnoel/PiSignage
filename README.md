# Beam

Beam is a real local-first Raspberry Pi based digital signage operations console, with AWS services planned after the local demo foundation is proven. The first target is intentionally small: one account, one dashboard, real Raspberry Pi screens, reusable media and playlists, and reliable fullscreen playback from local content.

The current repository provides a local-only foundation. It does not deploy AWS infrastructure, require AWS credentials, or attempt to clone a full enterprise signage platform.

## What Exists Now

- `dashboard/`: Next.js + TypeScript + Tailwind local dashboard.
- `player/`: TypeScript fullscreen image playback proof of concept.
- `device-agent/`: Node.js + TypeScript local device agent that reads a playlist and writes heartbeat JSON.
- `docs/`: architecture, phases, API contract, AWS design, security notes, and device setup.
- `sample-content/`: tracked seed playlist and local media fixtures.
- `infra/`: future AWS IaC placeholder only.

The original Apple/Xcode starter scaffold is still present as legacy starter material. The active signage POC foundation is the Node/TypeScript workspace described above.

## Local Requirements

- Node.js 20 or newer.
- npm 10 or newer.

No AWS credentials are required for the current local POC.

## Getting Started

```sh
npm install
npm run typecheck
npm run build
```

Run the local operations dashboard:

```sh
npm run dev:dashboard
```

If the dashboard is running on a Mac and the player is running on a Raspberry Pi,
configure local Pi publishing before starting the dashboard. Prefer SSH keys; for
password-only local testing, keep the password in your shell environment and do
not commit it. Password mode requires the local `expect` command.

```sh
PISIGNAGE_PI_HOST=192.168.1.172 \
PISIGNAGE_PI_USER=donnoel \
PISIGNAGE_PI_ROOT=/home/donnoel/PiSignage \
PISIGNAGE_PI_PASSWORD='<local-pi-password>' \
npm run dev:dashboard
```

Dashboard uploads still save to the local checkout first, then copy the uploaded
MP4 and playlist JSON to the Pi with `scp`/`ssh`. If Pi publishing is not
configured, the dashboard will show that the upload was saved locally only.

Optional dashboard labels can also live in `dashboard/.env.local`. Leave them
unset if they are not known yet; the dashboard will say they are not configured
instead of inventing values.

```sh
PISIGNAGE_SCREEN_NAME='<real-screen-name>'
PISIGNAGE_LOCATION_NAME='<real-location-name>'
```

Run the local player:

```sh
npm run dev:player
```

The player loads `sample-content/playlist.local.json` at runtime. To test another same-origin playlist, pass a path in the browser:

```text
http://localhost:5173/?playlist=/playlist.local.json
```

The Raspberry Pi display launcher is tracked under `device/pi/`. It defaults to
operator mode during hands-on testing so Chromium can be minimized after leaving
webpage fullscreen. Kiosk mode remains available for unattended TV playback; see
`docs/DEVICE_SETUP.md`.

Generate a local device heartbeat:

```sh
npm run agent:heartbeat
```

The agent reads the local playlist, writes a last-known-good playlist cache, and writes a heartbeat file. Runtime files are intentionally ignored by git:

```text
dashboard/local-state/activity.local.json
dashboard/local-state/devices.local.json
dashboard/local-state/media.local.json
dashboard/local-state/playlist.local.json
dashboard/local-state/publish-status.json
dashboard/local-state/schedules.local.json
dashboard/local-state/screens.local.json
dashboard/local-state/settings.local.json
device-agent/local-cache/playlists/current.json
device-agent/local-state/heartbeat.json
```

## Project Structure

```text
PiSignage/
├── dashboard/
├── device-agent/
├── docs/
├── infra/
├── player/
├── sample-content/
├── AGENTS.md
├── AGENTS.project.md
└── README.md
```

## Current Phase

Phase 4 is in progress: AWS architecture and Raspberry Pi setup are documented before cloud deployment or hardware-specific implementation.

See `docs/PHASES.md` for the full phase plan.

## Core Principles

- Reliability over cleverness.
- Offline-first playback.
- Appliance-like Raspberry Pi behavior.
- Simple architecture with clean dashboard/backend/device boundaries.
- Mock cloud integrations before implementing AWS.
- Build incrementally with validation at every phase.

## Credits

Built with care by **Don Noel** and AI collaboration.
