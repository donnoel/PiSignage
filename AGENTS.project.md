# AGENTS.project.md

# PiSignage Project Guide for Agents

## Product Intent

PiSignage is a phased proof of concept for replacing a Yodeck-style digital signage workflow with a simpler Raspberry Pi + AWS architecture.

The initial product target is deliberately small:

- One account.
- One dashboard.
- One Raspberry Pi device.
- One TV.
- One playlist.
- Reliable fullscreen playback.

This is not a full enterprise clone. The project should evolve incrementally from a local proof of concept into a cloud-backed alpha only after the local playback, device status, and contracts are clear.

## Current Product Phase

The repository is in Phase 4: AWS architecture and Raspberry Pi setup are being prepared without deploying cloud resources or requiring hardware access.

Current goals:

- Keep the dashboard focused on one account, one screen, and one playlist.
- Keep dashboard, player, and device-agent boundaries clear.
- Document AWS and device setup plans before adding live services.
- Prepare Pi-free local failure checks for tomorrow’s hardware setup.
- Avoid real AWS resources, credentials, and deployment requirements.

## Non-Goals For The Initial POC

Do not build these until explicitly approved:

- Multi-tenant organizations.
- Billing.
- Advanced RBAC.
- Analytics.
- Screenshot capture.
- Remote reboot.
- OTA deployment/update system.
- Advanced fleet management.
- Complex scheduling.
- Production video pipeline.
- Greengrass deployment.

Monitoring starts with heartbeat only.

## Architecture Snapshot

Target architecture:

- `dashboard/`: Next.js, TypeScript, Tailwind dashboard hosted locally now and on Amplify Hosting later.
- `player/`: fullscreen playback app that can run from local playlist/cache data.
- `device-agent/`: Node.js + TypeScript Raspberry Pi agent for playlist reads, local heartbeat writes, cache management, and future MQTT.
- `docs/`: architecture, phases, setup, API, AWS design, and security documentation.
- `infra/`: AWS architecture notes and future IaC placeholders only.
- `sample-content/`: local playlist and mock media fixtures.

Future AWS services are expected to include API Gateway, Lambda, DynamoDB, S3, CloudFront, Cognito, and AWS IoT Core MQTT. Greengrass is a later consideration, not a current requirement.

## Behavior Invariants

Do not regress these contracts:

- Device playback must work from local playlist/cache data.
- Device startup should recover to playback without dashboard interaction.
- A missing network connection must not stop already-cached playback.
- Heartbeat state must be inspectable as local JSON in the POC.
- Cloud integrations must remain mockable until real AWS implementation is approved.
- Device playback and reboot recovery are first-class behavior contracts.

## Phase Priorities

Keep the phase plan in `docs/PHASES.md` current. Every phase needs acceptance criteria and validation steps.

Near-term priority order:

1. Phase 0: docs, structure, local runnable foundation.
2. Phase 1: local fullscreen image playback and heartbeat file.
3. Phase 2: mocked dashboard for one screen and one playlist.
4. Phase 3: API contract definition before implementation.
5. Phase 4: AWS design documentation before deployment.

## Dashboard Rules

- Keep the dashboard operational and focused, not marketing-heavy.
- Show one mocked screen and one mocked playlist first.
- Use accessible status text for online/offline state.
- Keep cloud data mocked until backend contracts exist.
- Avoid advanced account, org, RBAC, billing, or analytics UI.

## Player Rules

- Fullscreen image playback is the first playback target.
- The player must load from a local playlist JSON path or bundled local fixture.
- Avoid advanced scheduling until basic playback is reliable.
- Use clear fallback/error states when playlist or assets cannot load.
- The player should be usable in Chromium kiosk mode later.

## Device-Agent Rules

- Prefer Node.js + TypeScript unless there is a strong reason to change.
- Read local playlist JSON in the POC.
- Write local heartbeat JSON atomically.
- Log basic structured status.
- Do not make network calls unless a future task explicitly introduces mocked or real cloud communication.
- Future MQTT topics must follow documented contract names.

Heartbeat model starts with:

- `deviceId`
- `timestamp`
- `appVersion`
- `currentPlaylistId`
- `currentAssetId`
- `diskFreeBytes`
- `networkOnline`

## AWS Rules

- Do not create real AWS infrastructure yet.
- Do not require AWS credentials yet.
- Mock or document cloud integrations first.
- Keep future AWS design least-privilege and easy to reason about.
- Use signed CloudFront/S3 access patterns for private media in future docs.
- Keep Cognito boundaries simple: one account first.

## Security Rules

- No real secrets in git.
- No checked-in device certificates.
- No hardcoded private URLs or account IDs.
- No unexpected telemetry, analytics, screenshots, or remote-control behavior.
- Treat device identity and pairing as explicit future contracts.

## Accessibility Requirements

For dashboard and player UI:

- Use semantic HTML and meaningful labels.
- Preserve keyboard access for interactive controls.
- Communicate online/offline and playback status in text, not color alone.
- Provide useful alt text or accessible names for media.
- Keep contrast and text sizing legible on TV and desktop displays.
- Avoid motion unless it has a clear purpose and respects reduced-motion expectations.

Accessibility claims must be backed by implementation evidence.

## Build And Validation Notes

Expected local validation as the repo evolves:

- `npm install` or `npm ci`
- `npm run typecheck`
- `npm run build`
- `npm run lint` when linting is configured
- Device-agent heartbeat command once available
- Manual player smoke test in a browser once available
- Manual dashboard smoke test in a browser once available

If validation cannot run, state the exact missing prerequisite or failure.

## Output Expectations Per Patch

Provide:

- Summary of change.
- Files created or modified.
- AGENTS guidance impact when guidance changes.
- What works now.
- What remains mocked.
- What is intentionally deferred.
- Validation performed.
- Accessibility notes for user-facing work.
- Commit message suggestion.
