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
- CloudWatch log groups reserved for future API, device, media, and dashboard services.
- API Gateway routes `POST /v1/devices/{deviceId}/heartbeat` and `GET /v1/devices/{deviceId}/heartbeat`.
- Lambda function `beam-dev-heartbeat`.
- A generated dev API key attached to an API Gateway usage plan.
- App Runner service `beam-dev-dashboard` for the Next.js dashboard container.

## What This Does Not Create

- No Cognito users.
- No IoT certificates.
- No remote reboot or command execution.
- No production secrets.

## Dashboard Hosting

The dashboard container is defined by `Dockerfile.dashboard` at the repo root.
App Runner runs the Next.js server. It reads the heartbeat table through its
instance IAM role using `BEAM_HEARTBEATS_TABLE_NAME`, and it reads/writes the
cloud Screens and Devices tables through `BEAM_SCREENS_TABLE_NAME` and
`BEAM_DEVICES_TABLE_NAME`. It also reads the cloud playlist catalog through
`BEAM_PLAYLISTS_TABLE_NAME` and seeds the dev `Main Playlist` record when that
catalog is empty. Media uploads in cloud mode write source objects to
`BEAM_SOURCE_MEDIA_BUCKET_NAME` and catalog records to `BEAM_ASSETS_TABLE_NAME`.
It does not need the dev API key for cloud heartbeat reads or dashboard
inventory writes.

The dashboard also exposes a dev device playlist endpoint at
`/api/cloud/devices/{deviceId}/playlist`. It reads the device's manually
published playlist/version marker, returns that cloud playlist, and includes
short-lived signed S3 download URLs for cloud media objects. Saved playlist edits
remain AWS-backed drafts until an operator publishes them to assigned screens.
This is the first one-screen pilot bridge; it is not a production device-auth
boundary yet.

Screens, Devices, the playlist catalog, manual playlist publish markers, and
source media cataloging are the first cloud-backed dashboard workflows. MP4
uploads are accepted into the cloud media catalog. JPEG, PNG, and MOV uploads are
stored as source media and marked processing until the playback-safe MP4
processing job exists. Schedules and recovery still use the local POC paths until
their cloud contracts are implemented.

Deploying the dashboard image requires Docker to be running locally because CDK
builds and publishes the image asset during deployment.

## Heartbeat Smoke

The heartbeat route requires an API key. Fetch the generated key value from AWS only when you need to smoke-test the endpoint; do not commit it.

```sh
AWS_PROFILE=beam-dev-admin aws apigateway get-api-keys \
  --region us-west-2 \
  --name-query beam-dev-device-dev \
  --include-values
```

Then POST a heartbeat with header `x-api-key`. Use the same header with GET to read the latest stored heartbeat. Heartbeat failures must not stop local playback.

For dashboard smoke tests, configure the dashboard server with:

```sh
BEAM_CLOUD_API_URL=https://example.execute-api.us-west-2.amazonaws.com/dev
BEAM_CLOUD_API_KEY='<dev-api-key>'
BEAM_CLOUD_DEVICE_ID=device-local-demo
```

Keep the API key in ignored local environment only.
