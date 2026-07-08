# AGENTS.project.md

# Beam Project Guide for Agents

## Product Intent

Beam is a real local-first Raspberry Pi signage operations console. AWS dev alpha work has started, but the local playback, manual publish, and recovery contracts remain the product baseline.

The near-term product target is deliberately small:

- One local-first pilot account, evolving toward client workspaces for production cloud use.
- One local operations dashboard.
- A small local inventory of Raspberry Pi devices and screens.
- Reusable media and playlists.
- Reliable fullscreen playback and recovery.

This is not a full enterprise clone. The project should evolve incrementally from a real local product into a production-ready local-plus-cloud service only as playback, device status, workspace isolation, and contracts stay clear.

Delivery path:

- Current sprint: production-minded hardening for real local operations, screen health, playlists, media, recovery, and cloud alpha truthfulness.
- Five real Raspberry Pi signage systems controlled from the interface as the pilot surface, with a soak period for playback, control, monitoring, recovery, and outage behavior.
- Real AWS buildout happens only through explicit approval. The current `dev` alpha scaffold is intentionally narrow and must preserve local playback and manual publish.
- AWS buildout must also follow `docs/AWS_COST_GUARDRAILS.md`: avoid unnecessary data transfer, paid polling, unbounded scans, and always-on services unless the cost is understood and approved.
- Production only after the five-system pilot and later cloud work prove playback, control, monitoring, and recovery.

## Current Product Phase

The repository is in a local product re-baseline phase. Product requirements now live in `docs/PRODUCT_REQUIREMENTS.md`, and implementation sequencing lives in `docs/PHASES.md`.

Current implementation snapshot:

- The dashboard currently exposes What's Playing, Library, Playlists, Screens, Diagnostics, Layouts, and Scheduling views.
- Device inventory and activity evidence exist in local JSON and are surfaced through the current What's Playing, Screens, Diagnostics, Scheduling, and recovery workflows.
- Screens carries inventory, status, publishing, diagnostics, recovery, reset, and deployment controls. Diagnostics carries deeper Pi evidence, logs, recovery history, and troubleshooting activity.

Current goals:

- Keep the dashboard focused on operations: What's Playing, Library, Playlists, Screens, Diagnostics, Activity, Scheduling, and Settings.
- Keep dashboard, player, and device-agent boundaries clear.
- Preserve the proven local playback and Pi recovery path while adding inventory, media, activity, scheduling, and recovery workflows.
- Do not create or mutate AWS resources unless the user explicitly asks for that deploy/change in the current task.
- Remove/defer map UI until the operations foundation is stronger.

## Non-Goals For The Initial Product

Do not build these until explicitly approved:

- Billing.
- Advanced enterprise RBAC beyond the documented workspace roles.
- Cross-workspace asset sharing.
- Analytics.
- Screenshot capture.
- Remote reboot as a default recovery response.
- OTA deployment/update system.
- Advanced fleet management beyond the five-system pilot.
- Complex scheduling beyond simple business-hours windows.
- Production video pipeline.
- Greengrass deployment.

Monitoring starts with heartbeat only.

## Architecture Snapshot

Target architecture:

- `dashboard/`: Next.js, TypeScript, Tailwind local operations dashboard.
- `player/`: browser playback fallback/experimental app that can run from local playlist/cache data.
- `device-agent/`: Node.js + TypeScript Raspberry Pi agent for playlist reads, local heartbeat writes, cache management, and future MQTT.
- `docs/`: architecture, phases, setup, API, AWS design, and security documentation.
- `infra/`: AWS architecture notes and the `infra/beam` CDK scaffold for the opt-in `dev` alpha.
- `sample-content/`: tracked seed playlist and local media examples.

The current AWS dev alpha scaffold includes API Gateway, Lambda, DynamoDB, S3, CloudWatch log groups, and App Runner for the dashboard. CloudFront, Cognito, workspace membership enforcement, and AWS IoT Core MQTT remain future production-oriented work. Greengrass is a later consideration, not a current requirement.

## Behavior Invariants

Do not regress these contracts:

- C1-Cx must remain Golden Master Beam appliances except for intentional identity/network fields such as hostname, IP address, screen name, screen assignment, and location. Any drift in Beam-managed scripts, services, package/runtime baselines, playlist files, published media sets, or service state from the Pi Golden Master is a production defect.
- The current managed Pi appliance baseline lives in `docs/PI_GOLDEN_MASTER_BASELINE.md`; use it for all C1-Cx parity checks. C5 is the prototype appliance, and every Pi-touching change deployed to C5 must update that PI golden master baseline before the work is considered complete.
- Device playback must work from local playlist/cache data.
- Device startup should recover to playback without dashboard interaction.
- A missing network connection must not stop already-cached playback.
- Heartbeat state must be inspectable as local JSON.
- Current-video evidence must remain inspectable in local player status and heartbeat JSON whenever VLC playback can identify the active asset.
- Cloud integrations must remain clearly documented, opt-in, and honest about what is wired. They must not weaken local cached playback or manual publish.
- Future multi-client cloud workflows must enforce workspace isolation server-side. UI hiding is not enough for screens, devices, media, playlists, schedules, settings, activity, publish markers, recovery, or signed media access.
- Device playback and reboot recovery are first-class behavior contracts.

## Real Implementation Rules

- Build and test real behavior, not placeholder flows.
- Do not add fake status, fake devices, fake screens, fake media, or fake success states to make UI look complete.
- Seed data is allowed only as tracked example data; app behavior must operate on real local state and real uploaded media.
- Missing Pi, SSH, player, or media prerequisites must be shown as honest unavailable/error states.
- Validation should prove the real contract being changed. If hardware is required and unavailable, state exactly what remains unverified.

## Phase Priorities

Keep the phase plan in `docs/PHASES.md` current. Every phase needs acceptance criteria and validation steps. Keep product requirements in `docs/PRODUCT_REQUIREMENTS.md` current when scope changes.

Near-term priority order:

1. Preserve the existing local playback, publishing, and Pi recovery foundation.
2. Keep the current product honest and real while hardening toward production.
3. Rework dashboard and Screens around operational status, not maps.
4. Add local data stores for media, screens, devices, activity, settings, and schedules.
5. Build Library and playlist workflows around playback-safe assets.
6. Add device inventory, troubleshooting, activity, scheduling, settings, and simple local login.
7. Run a five-device soak and expand AWS only through explicit approval while preserving the proven local playback/recovery contracts.

## Dashboard Rules

- Keep the dashboard operational and focused, not marketing-heavy.
- Use these main sections: What's Playing, Library, Playlists, Screens, Diagnostics, Activity, Scheduling, Layouts, and Settings when those views are implemented.
- Use accessible status text for online/offline state.
- Prefer dense tables and detail panels for screen inventory; map UI is deferred.
- Keep cloud data behind explicit cloud-mode contracts and honest unavailable states when a workflow is not wired.
- Avoid advanced billing, analytics, enterprise RBAC, or cross-workspace sharing UI until explicitly approved.

## Player Rules

- Reliable fullscreen playback is the first playback target.
- Playback and publish changes must preserve Golden Master parity. When reachable, verify every affected C1-Cx Pi shares the Golden Master managed VLC/player script hashes, systemd service hashes, Node/VLC package baselines, playlist hash, published asset set, and active service state after changes.
- VLC is the preferred field playback path for appliance mode unless the user explicitly asks to revisit another player.
- The player must load from a real local playlist JSON path.
- JPEG and PNG dashboard uploads should become Pi-safe MP4 still clips before VLC sees them.
- MOV support should convert to playback-safe MP4 or be rejected clearly until conversion is implemented.
- MP3 remains deferred until audio-only signage behavior is explicitly designed.
- Avoid transitions and advanced scheduling until basic playback, publishing, and recovery are reliable.
- Use clear fallback/error states when playlist or assets cannot load.
- The player should be usable in Chromium kiosk mode later.

## Device-Agent Rules

- Prefer Node.js + TypeScript unless there is a strong reason to change.
- Read real local playlist JSON.
- Write local heartbeat JSON atomically.
- Log basic structured status.
- Do not make network calls except through explicit local device operations or approved cloud contracts such as cloud playlist reads, manual-publish-gated media sync, and tiny heartbeat/status posts.
- Future MQTT topics must follow documented contract names.

Heartbeat model starts with:

- `deviceId`
- `timestamp`
- `appVersion`
- `currentPlaylistId`
- `currentAssetId`
- `playbackState`
- `diskFreeBytes`
- `networkOnline`

## AWS Rules

- Do not create, update, destroy, or deploy real AWS infrastructure unless the user explicitly approves that action in the current task.
- Do not require AWS credentials for local operations.
- Read `docs/AWS_COST_GUARDRAILS.md` before changing AWS infrastructure, cloud traffic, uploads, media delivery, polling, monitoring, billing, or deployed dashboard behavior.
- Every AWS change must preserve the traffic contract: tiny heartbeat/status is allowed, uploads are operator-initiated, media sync is manual-publish-gated, and unchanged devices download nothing.
- Every AWS change must include a cost review for always-on services, paid APIs, S3 transfer, DynamoDB Scan usage, log retention, lifecycle cleanup, metrics, tags, and expected daily/monthly cost.
- When AWS starts, build real resource-backed behavior rather than placeholder cloud flows.
- Keep future AWS design least-privilege and easy to reason about.
- Use signed CloudFront/S3 access patterns for private media in future docs.
- Keep Cognito boundaries simple first, while preserving the future session shape for user memberships and one active workspace.

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
- What remains unimplemented or unverified.
- What is intentionally deferred.
- Validation performed.
- Accessibility notes for user-facing work.
- Commit message suggestion.
