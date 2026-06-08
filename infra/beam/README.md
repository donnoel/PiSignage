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

## Deploy Later

Deploy only after reviewing the synthesized template:

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
App Runner runs the Next.js server and reads the heartbeat table through its
instance IAM role using `BEAM_HEARTBEATS_TABLE_NAME`; it does not need the dev
API key for cloud heartbeat reads.

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
