# AWS Design

No AWS resources are deployed in the current phase. This document records the intended direction so implementation can stay incremental and mockable.

## Services

- API Gateway: HTTPS API for dashboard and device contract endpoints.
- Lambda: small request handlers for pairing, heartbeat, playlist, asset, and assignment flows.
- DynamoDB: device, screen, playlist, asset, and heartbeat metadata.
- S3: original and processed media storage.
- CloudFront: signed asset delivery to devices.
- Cognito: simple account authentication for the dashboard.
- AWS IoT Core: MQTT device command, event, and heartbeat messaging.

Greengrass may be considered later, but it is not part of the initial alpha.

## S3 Strategy

Use separate prefixes for original uploads, processed assets, and future thumbnails:

```text
s3://pisignage-assets/{accountId}/originals/
s3://pisignage-assets/{accountId}/processed/
s3://pisignage-assets/{accountId}/thumbnails/
```

For the first POC, keep media private and serve device-readable URLs through signed CloudFront URLs when cloud playback begins.

## DynamoDB Tables

Initial table candidates:

- `Accounts`: one account initially.
- `Screens`: screen metadata and assigned playlist.
- `Devices`: paired device metadata and status.
- `Playlists`: playlist metadata and ordered asset references.
- `Assets`: media metadata, storage keys, and processing status.
- `Heartbeats`: latest heartbeat per device, with optional time-series expansion later.

Avoid multi-tenant complexity beyond a simple account boundary until the one-screen flow is proven.

## CloudFront

Use CloudFront signed URLs or signed cookies for private asset delivery. Signed URLs should be short-lived enough to limit exposure but long-lived enough for intermittent device connectivity.

The device should cache assets locally and continue playback after URL expiry.

## Cognito Boundaries

Start with one account and one dashboard user. Avoid advanced RBAC in the initial POC.

Future roles can be added after core playback and publishing are proven.

## IoT Topics

Planned topics:

```text
pisignage/devices/{deviceId}/commands
pisignage/devices/{deviceId}/events
pisignage/devices/{deviceId}/heartbeat
pisignage/screens/{screenId}/playlist-updated
```

Device policies should restrict each device certificate to its own device topics.

## IAM Principles

- Least privilege for every Lambda.
- Separate read/write permissions for assets and metadata.
- No broad wildcard access in production policies.
- Device credentials scoped to a single device.
- Dashboard users should not receive direct AWS credentials in browser code.

## Deferred

- Real IaC.
- AWS account/environment setup.
- Media processing pipeline.
- Greengrass.
- Advanced fleet management.
- Screenshot capture.
- OTA update service.
