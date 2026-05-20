# Phases

Each phase should stay small enough to validate locally or with clearly documented manual steps. Do not deploy real AWS resources before an explicit approval task.

## Phase 0: Architecture Skeleton And Docs

Goal: make the repository understandable and ready for incremental work.

Acceptance:

- Repo structure exists for `dashboard/`, `device-agent/`, `player/`, `infra/`, `docs/`, and `sample-content/`.
- Required docs exist.
- Local-only runnable foundation exists.
- No AWS credentials are required.

Validation:

- `npm install`
- `npm run typecheck`
- `npm run build`

## Phase 1: Local Playback Proof Of Concept

Goal: prove local fullscreen image playback and local device status.

Implementation status: local Phase 1 behavior exists. The player fetches the local playlist at runtime, and the device agent writes both heartbeat state and a last-known-good playlist cache.

Acceptance:

- Fullscreen image playback works locally.
- Local playlist JSON works.
- Device agent can read the playlist.
- Device agent writes local heartbeat JSON.

Validation:

- `npm run dev:player`
- `npm run agent:heartbeat`
- Confirm `device-agent/local-state/heartbeat.json` exists.
- Confirm `device-agent/local-cache/playlists/current.json` exists.

## Phase 2: Mock Dashboard

Goal: show the basic operator view without backend services.

Implementation status: local Phase 2 behavior exists. The dashboard reads the sample playlist and optional local heartbeat file at request time.

Acceptance:

- Dashboard displays one mocked screen.
- Dashboard displays one mocked playlist.
- Dashboard displays mocked online/offline state.

Validation:

- `npm run dev:dashboard`
- Manual browser smoke test.
- Run `npm run agent:heartbeat`, refresh the dashboard, and confirm the heartbeat fields update.

## Phase 3: API Contract Definition

Goal: document contracts before implementation.

Implementation status: initial API and MQTT contracts are documented. They are not implemented or deployed.

Document but do not deploy:

- Device pairing.
- Heartbeat.
- Playlist fetch.
- Asset upload.
- Screen assignment.

Validation:

- Review `docs/API_CONTRACT.md` for request/response examples and versioning notes.
- Confirm the local playlist and heartbeat files map cleanly to the future playlist and heartbeat contracts.

## Phase 4: AWS Design Documentation

Goal: define AWS architecture before infrastructure exists.

Implementation status: AWS design documentation is prepared. No infrastructure has been created.

Document:

- S3 strategy.
- DynamoDB tables.
- CloudFront signed URLs.
- Cognito boundaries.
- IoT topics.
- IAM principles.

Do not deploy.

Validation:

- Review `docs/AWS_DESIGN.md` for least-privilege boundaries and mockability.
- Confirm no AWS credentials, deploy commands, or IaC resources are required.

## Phase 5: Future AWS Alpha Implementation

Goal: implement a minimal approved cloud alpha later.

Document only for now:

- IaC approach.
- Environment naming.
- Secret handling.
- Deployment workflow.
- Rollback strategy.

Validation:

- Not applicable until implementation is approved.

## Phase 6: Raspberry Pi Appliance Mode

Goal: make the Pi behave like a resilient signage appliance.

Document and implement later:

- Chromium kiosk mode.
- `systemd` services.
- Auto-recovery.
- Watchdog strategy.
- Local cache layout.

Validation:

- Reboot test.
- Network-offline playback test.
- Service restart test.

## Phase 7: Monitoring

Goal: start with heartbeat-only monitoring.

Heartbeat fields:

- `deviceId`
- `timestamp`
- `appVersion`
- `currentPlaylistId`
- `currentAssetId`
- `diskFreeBytes`
- `networkOnline`

Validation:

- Device writes heartbeat locally.
- Future API accepts heartbeat payload.
- Dashboard renders heartbeat age and online/offline status.

## Phase 8: Future Ideas Only

These are explicitly deferred:

- Scheduling.
- Video playback.
- Screenshots.
- Remote reboot.
- Organizations.
- OTA updates.
- Analytics.
- Billing.
