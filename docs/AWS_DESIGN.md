# AWS Design

AWS `dev` alpha work has started. This document records the target design and distinguishes the current scaffold from later production-grade cloud work.

The first cloud alpha still serves the same narrow product: one pilot workspace, one dashboard, one or more Raspberry Pis, assigned playlists, and reliable offline-capable playback. Production multi-client use requires the workspace isolation model in `docs/WORKSPACES_AND_ROLES.md`.

All AWS design must also follow `docs/AWS_COST_GUARDRAILS.md`. Cost control is part of the architecture: Beam should move media only for operator uploads or manual publish sync, keep routine traffic tiny, cache aggressively on devices, and explain transfer through both AWS metrics and the Beam publish/sync ledger.

## Current Dev Alpha

Implemented or scaffolded now:

- `infra/beam` CDK stack for a `dev` environment.
- App Runner dashboard container from `Dockerfile.dashboard`.
- Private S3 buckets for source media, playback media, thumbnails, and logs.
- DynamoDB tables for accounts, devices, screens, playlists, assets, heartbeats, and activity.
- Lambda Function URL device API and Lambda handler for latest-device heartbeat write/read.
- Dashboard cloud mode for Screens, Devices, playlist catalog, media source upload/cataloging, manual playlist publish markers, and heartbeat reads.
- Device-agent cloud release checks, publish-gated manifest sync, cached media verification, and heartbeat post when provisioned with ignored local environment variables.
- Dev device playlist endpoint at `/api/cloud/devices/{deviceId}/playlist`.
- Dev release manifest, per-asset URL, and sync-result endpoints under `/api/cloud/devices/{deviceId}/releases/{releaseId}/...`.
- Cloud reset queue/result endpoints for deployment reset workflows.

Still not production-ready:

- No Cognito dashboard authentication.
- No IoT certificates or MQTT command channel.
- Playlist fetch still uses App Runner dashboard routes and a temporary pilot API key. Production per-device auth remains future work.
- No CloudFront distribution or production signed URL strategy.
- No OTA update system, screenshot capture, analytics, billing, or enterprise-grade custom RBAC.
- No multi-client production use until workspace ownership and access enforcement are implemented.
- Cloud schedules and cloud recovery are still partial; local POC paths remain authoritative there.

## Services

- Device API: Lambda Function URL for lightweight outbound device heartbeat check-ins.
- Lambda: small request handlers for heartbeat now; pairing, playlist, asset, and assignment API handlers remain target design where not already served by the dashboard.
- DynamoDB: account, screen, device, playlist, asset, assignment, and heartbeat metadata.
- S3: private source media and processed media storage.
- CloudFront: future signed asset delivery to devices.
- Cognito: future simple dashboard sign-in boundary.
- AWS IoT Core: future MQTT device command, event, and playlist update messages.

Greengrass may be considered later, but it is not part of the initial alpha.

App Runner can remain a short-term dev alpha dashboard host, but device heartbeat should not depend on the dashboard server. Before expanding hosted compute, compare the expected cost and operational value against a smaller API Gateway HTTP API/Lambda path, Lambda Function URLs, ECS Express Mode, or another lower-cost option.

## S3 Media Bucket And Key Strategy

Use private S3 buckets. Do not make media buckets public.

Initial bucket split:

```text
pisignage-media-{environment}
pisignage-logs-{environment}
```

Initial alpha media keys:

```text
accounts/{accountId}/uploads/original/{assetId}/{fileName}
accounts/{accountId}/assets/image/{assetId}/{renditionName}
accounts/{accountId}/assets/video/{assetId}/{renditionName}
accounts/{accountId}/thumbnails/{assetId}/{thumbnailName}
```

Production workspace media keys should move toward the workspace-prefixed shape
documented in `docs/WORKSPACES_AND_ROLES.md`.

Rules:

- `assetId` is the durable lookup key; file names are display metadata only.
- Original uploads and processed playback assets use separate prefixes.
- The current alpha accepts MP4 source uploads into the cloud media catalog.
- JPEG, PNG, and MOV source uploads can be stored and marked processing until playback-safe MP4 preparation is available.
- Device cache keys should use `assetId` plus checksum/version, not raw file name.
- S3 lifecycle rules can clean failed uploads and obsolete processed renditions later.
- Playback-safe MP4 renditions should live in the playback media bucket when `BEAM_PLAYBACK_MEDIA_BUCKET_NAME` is configured; originals remain in source media.

## Publish-Gated Release Sync

Cloud playlist edits remain drafts until the operator presses manual publish.
Manual publish creates an immutable release manifest for the target devices and
stamps that release ID onto the linked screen/device records.

Device traffic rules:

- Heartbeat/status JSON may continue on its normal interval.
- The normal device playlist check returns only desired release metadata.
- If the release ID and manifest checksum are unchanged, the device downloads nothing.
- A device fetches the release manifest only after a new manual publish.
- Signed S3 URLs are generated one asset at a time only after the device reports a missing or changed cached asset.
- S3 transfer must be explainable from the release manifest and sync ledger; unexpected transfer is a cost incident.
- AWS, monitor, or playlist-check failure must keep the last known good local cache. The first-run fallback playlist is used only when no valid cache exists.

Each sync result records downloaded bytes, skipped cached bytes, failed asset IDs,
release ID, and device ID so Beam can explain daily transfer instead of relying
only on AWS billing rollups.

## CloudFront Signed URL Approach

CloudFront should sit in front of private S3 media. Devices receive short-lived signed URLs in playlist responses, then cache assets locally.

Expected approach:

- Use CloudFront Origin Access Control for private S3 access.
- Generate signed URLs server-side from Lambda/API code.
- Keep signed URLs long enough for intermittent Pi connectivity, but not permanent.
- Generate signed media URLs only from per-asset release sync requests, not from routine playlist checks.
- Do not store signed URLs in DynamoDB.
- Do not log signed URLs in dashboard, Lambda, device-agent, or player logs.
- Device should continue playback after URL expiry if the asset is already cached.

Open design question for Phase 5:

- Choose exact signed URL TTL after testing device download/retry timing on real Wi-Fi.

## DynamoDB Table Design

Start with single-table complexity only if it is clearly useful. For the alpha, simple focused tables are easier to inspect and migrate.

Normal dashboard and device paths should use GetItem, Query, or bounded indexed reads. DynamoDB Scan is acceptable only for clearly bounded admin or migration work, not for hot-path media lists, playlist fetches, release checks, or heartbeat/status reads.

### Accounts

Primary key:

```text
accountId
```

Fields:

- `accountId`
- `displayName`
- `createdAt`
- `updatedAt`

Initial scope has one pilot workspace. Add workspace membership and server-side
workspace filtering before multiple clients share one environment.

### Screens

Primary key:

```text
screenId
```

Fields:

- `screenId`
- `accountId`
- `name`
- `assignedPlaylistId`
- `pairedDeviceId`
- `createdAt`
- `updatedAt`

Index candidates:

- `accountId`

### Devices

Primary key:

```text
deviceId
```

Fields:

- `deviceId`
- `accountId`
- `screenId`
- `label`
- `status`
- `agentVersion`
- `iotThingName`
- `pairedAt`
- `lastSeenAt`
- `createdAt`
- `updatedAt`

Index candidates:

- `accountId`
- `screenId`

### Playlists

Primary key:

```text
playlistId
```

Fields:

- `playlistId`
- `accountId`
- `name`
- `version`
- `assets`
- `createdAt`
- `updatedAt`

Rules:

- Each playlist update increments `version`.
- Assets remain ordered in the playlist response.
- The first alpha supports one assigned playlist per screen.

### Assets

Primary key:

```text
assetId
```

Fields:

- `assetId`
- `accountId`
- `type`
- `fileName`
- `contentType`
- `sizeBytes`
- `sourceS3Key`
- `playbackS3Key`
- `checksumSha256`
- `processingStatus`
- `createdAt`
- `updatedAt`

### Heartbeats

Primary key:

```text
deviceId
```

Fields:

- `deviceId`
- `timestamp`
- `appVersion`
- `currentPlaylistId`
- `currentAssetId`
- `diskFreeBytes`
- `networkOnline`
- `receivedAt`

Start with latest heartbeat only. Time-series heartbeat history can be added later if there is a concrete operational need.

## Cognito User/Auth Boundary

Initial Cognito scope:

- One user pool for dashboard sign-in.
- One app client for the dashboard.
- Dashboard users can belong to one or more workspaces.
- Each user/workspace membership carries a role.
- The dashboard session carries a trusted user ID, allowed workspace memberships, and one active workspace.
- Start with the role model in `docs/WORKSPACES_AND_ROLES.md`; defer enterprise-grade custom roles until a real workflow requires them.

Rules:

- Browser code never receives AWS access keys.
- Dashboard calls API Gateway with Cognito-authenticated requests.
- API handlers derive workspace access from the authenticated user and server-side membership, not from client-supplied workspace/account IDs alone.
- All workspace-owned records include `workspaceId`, and cross-record operations verify every target belongs to the same active workspace.
- Billing, SSO, and cross-workspace asset sharing are deferred.

## Device Identity Model

Device identity is separate from dashboard user identity.

Initial model:

- A dashboard user creates a pairing code for one screen.
- The Pi agent submits the pairing code.
- Backend creates or links a `deviceId` and `screenId`.
- Future IoT credentials are scoped to that device only.

Device credential direction:

- AWS IoT Thing per device.
- X.509 certificate per device.
- IoT policy limited to topics for that device and assigned screen.
- Certificate provisioning and rotation require a dedicated Phase 5 design before implementation.

Do not store device private keys in git, docs, logs, or dashboard-visible payloads.

## AWS IoT Core Topic Layout

Topics:

```text
pisignage/devices/{deviceId}/commands
pisignage/devices/{deviceId}/events
pisignage/devices/{deviceId}/heartbeat
pisignage/screens/{screenId}/playlist-updated
```

Device policy should allow:

- Subscribe to `pisignage/devices/{deviceId}/commands`.
- Subscribe to `pisignage/screens/{screenId}/playlist-updated`.
- Publish to `pisignage/devices/{deviceId}/events`.
- Publish to `pisignage/devices/{deviceId}/heartbeat`.

Rules:

- MQTT messages stay small.
- Playlist update messages contain identifiers and version only.
- The device fetches the full playlist over HTTPS.
- Commands must be idempotent where practical.

## IAM Least-Privilege Principles

- Lambda functions get separate roles by responsibility.
- Pairing Lambda can read/write devices and screens, but not media objects.
- Heartbeat Lambda can update heartbeat/device status only.
- Playlist Lambda can read screens, playlists, assets, and generate signed asset URLs.
- Asset upload Lambda can create upload records and signed upload URLs only.
- No broad `s3:*`, `dynamodb:*`, or `iot:*` policies in production.
- Device IoT policy is scoped to a single device and assigned screen.
- Dashboard users never receive direct S3 write permissions.

## API-To-AWS Mapping

| Contract | AWS services | Notes |
| --- | --- | --- |
| `POST /v1/devices/pair` | Future API Gateway HTTP API or Lambda Function URL, Lambda, DynamoDB, future IoT provisioning | Pair one Pi to one screen. Credential provisioning needs separate approval. |
| `POST /v1/devices/{deviceId}/heartbeat` | Lambda Function URL, Lambda, DynamoDB | Store latest heartbeat from outbound device HTTPS; failure must not stop playback. |
| `GET /v1/devices/{deviceId}/playlist` | App Runner dashboard route today; future API Gateway HTTP API or Lambda Function URL, Lambda, DynamoDB, CloudFront signing | Return publish-gated assignment/release metadata and signed asset URLs only when needed. |
| `POST /v1/assets/upload-url` | App Runner dashboard route today; future API Gateway HTTP API or Lambda Function URL, Lambda, DynamoDB, S3 | Return signed upload URL, never log it. |
| `PUT /v1/screens/{screenId}/assignment` | Future API Gateway HTTP API or Lambda Function URL, Lambda, DynamoDB, IoT publish | Update assignment and publish lightweight playlist update. |

## Local Mock-To-AWS Migration Path

Current local file mapping:

| Local file | AWS-backed future |
| --- | --- |
| `sample-content/playlist.local.json` | Playlist fetch response from DynamoDB plus signed CloudFront URLs |
| `device-agent/local-cache/playlists/current.json` | Device last-known-good cache after HTTPS playlist fetch |
| `device-agent/local-state/heartbeat.json` | Heartbeat request body sent to API Gateway or IoT |
| `device-agent/config.example.json` | Provisioned device config after pairing |

Migration steps:

1. Keep local file mode as the default development path.
2. Add API clients behind explicit config flags.
3. Mock API responses with the same shapes as `docs/API_CONTRACT.md`.
4. Keep AWS implementation limited to the approved `dev` alpha until contracts and local failure behavior are stable.
5. Keep the device cache fallback path identical for local and cloud playlists.

## Phase 5 Readiness Checklist

Before expanding AWS alpha:

- Confirm Phase 1 local playback survives missing playlist and missing asset tests.
- Confirm Phase 2 dashboard renders heartbeat and playlist state clearly.
- Confirm Phase 3 contracts are accepted as the source of truth.
- Choose environment names such as `dev` and `alpha`.
- Decide IaC tool, but do not introduce it until implementation is approved.
- Define secret storage and rotation approach.
- Define IoT certificate provisioning flow.
- Define CloudFront signing key ownership.
- Define rollback behavior for playlist assignment changes.
- Define minimal hosted CI checks for cloud code.
- Confirm AWS account and billing guardrails with the human.

## Deferred

- Real IaC.
- AWS account/environment setup.
- Media processing pipeline.
- Greengrass.
- Advanced fleet management.
- Screenshot capture.
- Remote reboot as a default recovery response.
- OTA update service.
- Billing and analytics.
