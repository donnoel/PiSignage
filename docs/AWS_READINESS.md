# AWS Readiness

Beam is approved to run a cloud alpha in Don's existing AWS account, in parallel with product hardening. This document captures the operating assumptions for the current `dev` environment and any future AWS changes.

## Decision

- Start with a `dev` Beam environment in `us-west-2`.
- Keep the local dashboard and Pi playback path working while AWS comes online.
- Build and update AWS resources from infrastructure-as-code in this repository.
- Do not create long-lived resources by hand in the AWS console except for account-level setup that cannot reasonably be represented in this repo.

## Accepted Local Proof

The local proof-of-concept is considered sufficient to begin the AWS alpha based on operator validation. The cloud work must preserve these proven contracts:

- Raspberry Pi playback starts from local media and playlist files.
- JPEG and PNG uploads are supported by creating playback-safe MP4 still clips before VLC sees them.
- Playlist publish remains an explicit operator action.
- A network outage must not stop already-cached playback.
- Device status must stay honest when prerequisites are unavailable or stale.

## AWS Alpha Scope

The first AWS target is not production. The first target is:

- One account.
- One `dev` environment.
- One dashboard running from AWS instead of the laptop.
- One or more Raspberry Pi devices that connect outbound to AWS.
- Real media storage, playlist assignment, and heartbeat status.

Currently implemented or scaffolded:

- `infra/beam` CDK stack for foundation resources and App Runner dashboard hosting.
- DynamoDB-backed cloud Screens, Devices, playlist catalog, media catalog records, heartbeat, and activity tables.
- Private S3 source/playback/thumbnail/log buckets.
- API Gateway/Lambda latest-heartbeat write/read.
- Dashboard cloud mode with manual playlist publish markers.
- Device-agent cloud playlist fetch and cloud heartbeat post, with local cache fallback.

Still outside alpha or partial:

- Production authentication and device identity.
- IoT/MQTT command channel.
- Cloud schedules and recovery parity with local mode.
- Playback-safe cloud processing for JPEG, PNG, and MOV beyond stored/processing status.

## Guardrails

- No fake cloud success states.
- No remote reboot, OTA update, screenshot capture, analytics, billing, or advanced RBAC in the alpha.
- No real secrets, AWS account IDs, device private keys, signed URLs, or customer media in git.
- Device cloud behavior must fail safe: keep playing the last known good local cache if AWS is unreachable.
- Cloud media delivered to the Pi must be playback-safe MP4, even when the operator uploaded JPEG or PNG.

## Next Proof Point

The first proof point is a repeatable infrastructure deploy:

```sh
cd infra/beam
npm install
npm run synth
```

Before each deploy, review the synthesized template and confirm the intended scope. The `dev` stack includes private S3 buckets, DynamoDB tables, CloudWatch log groups, API Gateway/Lambda heartbeat routes, and App Runner dashboard hosting.
