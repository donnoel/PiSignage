# Security Notes

Beam is local-first with an opt-in AWS dev alpha. The repo must not contain real credentials.

## Secrets

Do not commit:

- AWS access keys.
- Cognito secrets.
- IoT certificates or private keys.
- Signed URLs from real environments.
- `.env` files with real values.
- Private account IDs or customer data.

Use ignored environment files or shell/systemd environment for local secrets.

## Local Development

- Local dashboard operations should not make unexpected internet calls.
- Cloud-mode dashboard operations are explicit and require AWS environment configuration.
- Runtime state should be ignored by git unless it is an intentional fixture.
- Sample playlists must use tracked fixtures or ignored local media, never private customer assets committed to git.

## Device Identity

Production pairing must create a clear device identity and credential lifecycle. The current dev alpha uses provisioned device IDs and an API key for heartbeat smoke, which is not a production identity model.

Open questions for later phases:

- How pairing codes are generated and expired.
- How IoT certificates are provisioned.
- How credentials are rotated.
- How compromised devices are revoked.

## Media Access

Cloud media should be private by default.

Expected direction:

- Store assets in private S3 buckets.
- Serve playback through CloudFront signed URLs.
- Cache assets locally on the device.
- Never log signed URLs or upload URLs.

## Dashboard Access

Initial dashboard authentication should stay simple. Cognito or an equivalent authenticated boundary is still required before production cloud use. The first implementation can protect one pilot workspace, but the production direction requires users who can belong to multiple workspaces with server-enforced workspace isolation.

The initial workspace role model is documented in `docs/WORKSPACES_AND_ROLES.md`. Enterprise-grade custom RBAC is deferred.

## Deferred Sensitive Features

The following are intentionally deferred because they expand the security surface:

- Screenshot capture.
- Remote reboot as a default response.
- OTA updates.
- Fleet command execution.
- Analytics.
- Billing.
- Cross-workspace asset sharing.
- Enterprise organization administration beyond workspace membership.
