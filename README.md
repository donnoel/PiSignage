# PiSignage

PiSignage is a phased proof of concept for Raspberry Pi based digital signage backed by AWS services later. The first target is intentionally small: one account, one dashboard, one Raspberry Pi, one TV, and reliable fullscreen playback from local content.

The current repository provides a local-only foundation. It does not deploy AWS infrastructure, require AWS credentials, or attempt to clone a full enterprise signage platform.

## What Exists Now

- `dashboard/`: Next.js + TypeScript + Tailwind local dashboard.
- `player/`: TypeScript fullscreen image playback proof of concept.
- `device-agent/`: Node.js + TypeScript local device agent that reads a playlist and writes heartbeat JSON.
- `docs/`: architecture, phases, API contract, AWS design, security notes, and device setup.
- `sample-content/`: local playlist and mock media fixture.
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

Run the mocked dashboard:

```sh
npm run dev:dashboard
```

Run the local player:

```sh
npm run dev:player
```

The player loads `sample-content/playlist.local.json` at runtime. To test another same-origin playlist, pass a path in the browser:

```text
http://localhost:5173/?playlist=/playlist.local.json
```

Generate a local device heartbeat:

```sh
npm run agent:heartbeat
```

The agent reads the local playlist, writes a last-known-good playlist cache, and writes a heartbeat file. Runtime files are intentionally ignored by git:

```text
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

Phase 3 is in progress: API and MQTT contracts are documented before backend or AWS implementation.

See `docs/PHASES.md` for the full phase plan.

## Core Principles

- Reliability over cleverness.
- Offline-first playback.
- Appliance-like Raspberry Pi behavior.
- Simple architecture with clean dashboard/backend/device boundaries.
- Mock cloud integrations before implementing AWS.
- Build incrementally with validation at every phase.

## Credits

Created from a ProjectPilot starter and evolved for the PiSignage proof of concept.
