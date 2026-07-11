# AWS Rollout Plan

Goal: run Beam in AWS instead of relying on the laptop-hosted dashboard, while preserving local-first playback and recovery.

Every phase must follow `docs/AWS_COST_GUARDRAILS.md`. AWS rollout is not ready when it merely works; it must be cheap at idle, publish-gated for media transfer, observable, and explainable from both AWS metrics and Beam's own ledger.

## Current Snapshot

Beam now has a real `dev` alpha scaffold and partial cloud workflows. Foundation resources, App Runner dashboard hosting, DynamoDB-backed dashboard stores, cloud source-media cataloging, a dedicated Lambda Function URL device heartbeat API, device-agent cloud heartbeat, device-agent playlist fetch, manual publish markers, and a cloud reset queue are present in code. Production auth, IoT/MQTT, complete media processing, cloud schedule parity, and production device identity remain future work.

## Phase 1: Foundation

Create a repeatable Beam `dev` stack beside the existing app showcase resources.

Status: implemented/scaffolded in `infra/beam`; deploys still require intentional operator approval.

Deliverables:

- `infra/beam` CDK app.
- Private S3 buckets for source media, playback media, thumbnails, and logs.
- DynamoDB tables for accounts, devices, screens, playlists, assets, heartbeats, and activity.
- CloudWatch log groups for future API, device, media, and dashboard services.
- Documentation for the first deploy and destroy flow.

Validation:

- `npm run synth` from `infra/beam`.
- Human review of the generated CloudFormation template before deploy.
- AWS cost guardrail review covering always-on services, paid APIs, S3 transfer, DynamoDB Scan usage, log retention, lifecycle cleanup, metrics, tags, and expected daily/monthly cost.
- No AWS credentials or account IDs committed.

## Phase 2: Minimal Backend API

Create real backend endpoints before moving dashboard behavior.

Status: partially implemented. Device heartbeat check-ins use the dedicated Lambda Function URL -> Lambda -> DynamoDB path. Several dashboard workflows use DynamoDB/S3 directly from the server-side dashboard in cloud mode. Pairing and production API boundaries remain future work.

Deliverables:

- DynamoDB-backed dashboard Screens and Devices inventory.
- DynamoDB-backed dashboard playlist catalog, starting with the dev main playlist record.
- Cloud media source upload and asset cataloging for MP4, JPEG, PNG, and MOV.
- Device-agent cloud playlist fetch with local media cache fallback.
- `POST /v1/devices/pair` remains future work.
- `POST /v1/devices/{deviceId}/heartbeat`
- `GET /v1/devices/{deviceId}/playlist`
- Structured API errors with request IDs.
- Least-privilege Lambda roles.
- Future cleanup: remove the legacy App Runner heartbeat compatibility route after every reachable C1-Cx appliance has been confirmed on the Pi Golden Master device heartbeat API path.

Validation:

- Local unit tests for request validation.
- API smoke against the deployed `dev` environment.
- Heartbeat writes the latest device status without affecting playback.
- Adding a screen from the AWS-hosted dashboard persists in DynamoDB and survives App Runner restarts.
- The AWS-hosted dashboard resolves the C5 screen's assigned playlist from DynamoDB instead of local JSON.
- Uploading an MP4 from the AWS-hosted dashboard creates a private S3 source object and DynamoDB asset record.
- Adding a cloud MP4 to `Default Playlist` lets the device-agent fetch the assigned playlist and cache the media locally.

## Phase 3: Device Agent Cloud Mode

Make the Pi phone home to AWS while keeping local mode as the default.

Status: partially implemented. The device agent can check a cloud release marker,
fetch a release manifest only after manual publish, download only missing or
changed assets, cache the verified release locally, send cloud heartbeat, write
local heartbeat, and fall back to the last known good cache before any first-run
fallback.

Deliverables:

- Long-running agent loop.
- Explicit `local` and `cloud` modes.
- Pairing configuration stored outside git.
- Heartbeat interval with retry/backoff.
- Playlist polling with version checks.
- Release checks with no media URLs when unchanged.
- Per-asset downloads only after manual publish and only when local cache verification misses.
- Local status JSON continues to be written atomically.

Validation:

- Agent runs locally without AWS in `local` mode.
- Agent sends heartbeat to AWS in `cloud` mode.
- Unchanged release checks download no media and return no signed asset URLs.
- AWS outage does not delete or corrupt the last known good local cache.
- Turning off AWS or cloud monitors does not revert a device with a valid cache to the first-run fallback asset.

## Phase 4: Media Storage And Processing

Move media storage out of the laptop runtime.

Status: partially implemented. Cloud mode stores source media in S3 and metadata in DynamoDB. MP4 uploads can become catalog records; playback preparation for JPEG, PNG, and MOV is still incomplete unless the preparation worker is available and succeeds.

Deliverables:

- Signed upload URL endpoint.
- S3 original upload path.
- Async processing job that creates playback-safe MP4 renditions for JPEG and PNG uploads.
- Asset readiness state in DynamoDB.
- CloudFront signed playback URLs.

Validation:

- Upload PNG or JPEG.
- Confirm MP4 playback rendition exists.
- Confirm playlist fetch only returns ready playback renditions.
- Confirm S3 transfer is caused only by operator upload or manual publish sync.
- Confirm signed URLs are not stored in DynamoDB or logged.

## Phase 5: Cloud Dashboard Mode

Move the operator dashboard to AWS-backed data.

Status: partially implemented. The App Runner dashboard and cloud-mode stores exist for selected workflows. Cognito sign-in and full API-backed dashboard boundaries remain future work.

Deliverables:

- Simple Cognito sign-in.
- Workspace membership and active workspace claims shaped for users who can belong to multiple workspaces.
- Cloud dashboard data client.
- Screens, devices, media, playlists, and heartbeat status backed by API data.
- Local-only SSH recovery controls hidden or marked unavailable in cloud mode.

Validation:

- Dashboard can run without `dashboard/local-state`.
- Dashboard shows stale/offline status honestly.
- Dashboard does not expose signed URLs, secrets, or raw device credentials.
- Cross-workspace reads, writes, signed URLs, publishes, device fetches, and recovery/reset actions are rejected before multiple clients share one environment.

## Phase 6: One Real Pi End-To-End

Prove the full cloud loop with one screen.

Deliverables:

- Pair one Pi to the `dev` environment.
- Upload image media.
- Assign playlist to the Pi's screen.
- Pi downloads and verifies playback media.
- Pi swaps local cache atomically.
- TV continues playback through network loss.

Validation:

- Upload to AWS -> process -> assign -> device fetch -> TV playback.
- Pull network after sync; TV keeps playing.
- Expire signed URL; cached playback continues.
- Bad media does not replace the last known good playlist.

## Phase 7: Expand To Five Pis

Move from one-device proof to the real pilot shape.

Deliverables:

- Pair all five Pis.
- Verify per-device heartbeat and playlist version.
- Verify media cache parity for assigned content.
- Document accepted pilot gaps before production planning.

Validation:

- Five-device cloud smoke.
- Per-screen playlist assignment smoke.
- Network outage and recovery drills.
- No unexplained appliance drift across C1-C5.
