# Beam AWS Infrastructure

This folder contains the first Beam AWS infrastructure scaffold. It is intentionally separate from the local dashboard, player, and device-agent workspaces.

The first stack is a `dev` foundation and minimal heartbeat API. It does not create device certificates, send commands to Pis, or replace local playback.

## Prerequisites

- Node.js 20 or newer.
- npm 10 or newer.
- AWS CLI credentials for Don's AWS account when deploying.
- AWS region `us-west-2` unless explicitly changed.

## Install And Synthesize

```sh
cd infra/beam
npm install
npm run synth
```

`npm run synth` creates a CloudFormation template under `cdk.out/`. Generated output is ignored by git.

## Deploy

Deploy only after reviewing the synthesized template and confirming the intended AWS change for the current task:

```sh
cd infra/beam
npm run deploy
```

The stack is named `BeamDevFoundationStack` by default.

## What This Creates

- Private S3 buckets for source media, playback media, thumbnails, and logs.
- DynamoDB tables for accounts, devices, screens, playlists, assets, heartbeats, and activity.
- DynamoDB release ledger for manual publish manifests and per-device sync results.
- CloudWatch log groups reserved for future API, device, media, and dashboard services.
- S3 request metrics and a Beam daily cost guardrail budget for cost visibility.
- Lambda function `beam-dev-heartbeat`.
- Lambda Function URL device API for `POST /v1/devices/{deviceId}/heartbeat` and `GET /v1/devices/{deviceId}/heartbeat`.
- A generated pilot device API key in Secrets Manager.
- App Runner service `beam-dev-dashboard` for the Next.js dashboard container.

## What This Does Not Create

- No Cognito users.
- No IoT certificates.
- No remote reboot or command execution.
- No secrets committed to git. The pilot device API key is generated in AWS Secrets Manager.

## Dashboard Hosting

The dashboard container is defined by `Dockerfile.dashboard` at the repo root.
App Runner runs the Next.js server. It reads the heartbeat table through its
instance IAM role using `BEAM_HEARTBEATS_TABLE_NAME`, and it reads/writes the
cloud Screens and Devices tables through `BEAM_SCREENS_TABLE_NAME` and
`BEAM_DEVICES_TABLE_NAME`. It also reads the cloud playlist catalog through
`BEAM_PLAYLISTS_TABLE_NAME` and seeds the dev `Default Playlist` record when that
catalog is empty. Media uploads in cloud mode write source objects to
`BEAM_SOURCE_MEDIA_BUCKET_NAME`, playback-ready renditions to
`BEAM_PLAYBACK_MEDIA_BUCKET_NAME`, and catalog records to
`BEAM_ASSETS_TABLE_NAME`. Manual publish writes release manifests and sync
ledger entries to `BEAM_RELEASES_TABLE_NAME`.
It does not need the device API key for cloud heartbeat reads or dashboard
inventory writes.

The dashboard exposes a dev device playlist endpoint at
`/api/cloud/devices/{deviceId}/playlist`. It now returns only the device's
desired release ID/checksum and manifest URL. The device fetches the release
manifest only after manual publish and requests one short-lived signed S3 URL
per missing asset. Saved playlist edits remain AWS-backed drafts until an
operator publishes them to assigned screens. This is the first pilot bridge; it
is not a production device-auth boundary yet.

Screens, Devices, the playlist catalog, manual playlist publish markers, and
source media cataloging are the first cloud-backed dashboard workflows. MP4
uploads are accepted into the cloud media catalog. JPEG, PNG, and MOV uploads are
stored as source media and marked processing until the playback-safe MP4
processing job exists. Schedules and recovery still use the local POC paths until
their cloud contracts are implemented.

Deploying the dashboard image requires Docker to be running locally because CDK
builds and publishes the image asset during deployment.

## Heartbeat Smoke

The dedicated device API is separate from App Runner. Devices post heartbeat via
outbound HTTPS to the Lambda Function URL, then the dashboard reads the latest
heartbeat directly from DynamoDB. The heartbeat route requires the generated
pilot device key; fetch it only when provisioning a Pi or smoke-testing the
endpoint, and do not commit it.

```sh
DEVICE_API_URL="$(AWS_PROFILE=beam-dev-admin aws cloudformation describe-stacks \
  --region us-west-2 \
  --stack-name BeamDevFoundationStack \
  --query "Stacks[0].Outputs[?OutputKey=='BeamDeviceApiUrl'].OutputValue | [0]" \
  --output text)"

SECRET_ARN="$(AWS_PROFILE=beam-dev-admin aws cloudformation describe-stacks \
  --region us-west-2 \
  --stack-name BeamDevFoundationStack \
  --query "Stacks[0].Outputs[?OutputKey=='BeamDeviceApiSecretArn'].OutputValue | [0]" \
  --output text)"

DEVICE_API_KEY="$(AWS_PROFILE=beam-dev-admin aws secretsmanager get-secret-value \
  --region us-west-2 \
  --secret-id "$SECRET_ARN" \
  --query SecretString \
  --output text)"
```

Then POST a heartbeat with header `x-api-key`. Use the same header with GET to
read the latest stored heartbeat. Heartbeat failures must not stop local
playback.
