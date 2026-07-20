# Beam

Beam is a real local-first Raspberry Pi based digital signage operations console. The current working target remains intentionally small: one operations dashboard, real Raspberry Pi screens, reusable media and playlists, and reliable fullscreen playback from local content. The local playback path is the product contract even while the AWS dev alpha comes online. The production direction now includes client workspaces so multiple clients can use the same system without seeing or changing each other's screens, media, playlists, schedules, or settings.

The current repository provides a local-first product foundation plus an opt-in AWS dev alpha scaffold. Running the local dashboard, player, and device agent does not require AWS credentials. AWS work lives behind explicit environment variables and `infra/beam`; it is not production infrastructure and must not be deployed or treated as active unless the operator intentionally runs the AWS commands.

## What Exists Now

- `dashboard/`: Next.js + TypeScript + Tailwind operations dashboard with What's Playing, Library, Playlists, Screens, and Scheduling views. Screens combines inventory, health/status, publishing, diagnostics, recovery, reset, and deployment controls.
- `player/`: TypeScript browser playback fallback/experimental app for same-origin local playlist playback.
- `device-agent/`: Node.js + TypeScript device agent that reads a local playlist or optional cloud playlist endpoint, writes heartbeat JSON with current-video evidence, caches the last known good playlist, and can post an optional dev cloud heartbeat.
- `docs/`: architecture, phase plan, API contract, AWS alpha notes, security notes, and device setup.
- `docs/WORKSPACES_AND_ROLES.md`: planned client workspace and role model for multi-workspace users and server-enforced tenant isolation.
- `sample-content/`: tracked seed playlist and local media fixtures.
- `infra/`: AWS CDK scaffold for the Beam `dev` alpha. It includes App Runner for the dashboard, a dedicated Lambda Function URL for device heartbeat check-ins, DynamoDB, S3, Lambda, and log resources when deliberately deployed. The App Runner dashboard is image-backed, so code deploys must go through the `infra/beam` CDK image deploy path; restarting App Runner alone does not publish new code.

## Local Requirements

- Node.js 20 or newer.
- npm 10 or newer.
- `ffmpeg` for JPEG/PNG uploads, because still images are converted into Pi-safe MP4 clips before playback.

No AWS credentials are required for local operation.

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

Dashboard uploads save to the active local or cloud store. In local mode, ready
media and playlist JSON are copied to a configured Pi with `scp`/`ssh` only when
the operator publishes. If Pi publishing is not configured, the dashboard shows
that the change was saved locally only.

Optional dashboard labels can also live in `dashboard/.env.local`. Leave them
unset if they are not known yet; the dashboard will say they are not configured
instead of inventing values.

```sh
PISIGNAGE_SCREEN_NAME='<real-screen-name>'
PISIGNAGE_LOCATION_NAME='<real-location-name>'
```

The Library Add action opens a playlist chooser for unassigned media. Operators must choose the target playlist explicitly; Beam no longer silently adds those assets to the default playlist.

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
dashboard/local-state/last-known-playback.json
dashboard/local-state/media-folders.local.json
dashboard/local-state/media.local.json
dashboard/local-state/playlist.local.json
dashboard/local-state/playlists.local.json
dashboard/local-state/publish-status.json
dashboard/local-state/recovery.local.json
dashboard/local-state/schedules.local.json
dashboard/local-state/screens.local.json
dashboard/local-state/settings.local.json
dashboard/local-state/thumbnails/
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

The current focus is production-minded sprint hardening: real media uploads, reusable playlists, honest screen/device status, simple screen hours, local recovery evidence, and an AWS `dev` alpha that preserves manual publish and cached Pi playback. The five-Pi pilot is using VLC appliance playback with current-video reporting so What's Playing can show reported playback, snapshots, and Live view without replacing the administrative Show desktop control on Screens.

The current Pi appliance baseline is documented in `docs/PI_GOLDEN_MASTER_BASELINE.md`. The Golden Master is the promoted repo commit, built artifacts, baseline evidence, and fleet validation record, not a one-off manual state on a single Pi. C1-C5 should remain identical to that managed baseline except for intentional identity, network, screen assignment, location, and secret fields.

See `docs/PHASES.md` for the full phase plan.

## Core Principles

- Reliability over cleverness.
- Offline-first playback.
- Appliance-like Raspberry Pi behavior.
- Simple architecture with clean dashboard/backend/device boundaries.
- Keep cloud integrations opt-in, honest, and unable to replace local playback recovery.
- Do not show fake devices, fake health, fake media, or fake cloud success states.
- Build incrementally with validation at every phase.

## Credits

Built with care by Don Noel and Codex collaboration.
