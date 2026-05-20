# Security Notes

The current POC is local-only and must not contain real credentials.

## Secrets

Do not commit:

- AWS access keys.
- Cognito secrets.
- IoT certificates or private keys.
- Signed URLs from real environments.
- `.env` files with real values.
- Private account IDs or customer data.

Use `.env.example` files later if configuration becomes necessary.

## Local Development

- Local mocks should not make unexpected network calls.
- Runtime state should be ignored by git unless it is an intentional fixture.
- Sample playlists must use mock media or local fixtures.

## Device Identity

Future pairing must create a clear device identity and credential lifecycle.

Open questions for later phases:

- How pairing codes are generated and expired.
- How IoT certificates are provisioned.
- How credentials are rotated.
- How compromised devices are revoked.

## Media Access

Future cloud media should be private by default.

Expected direction:

- Store assets in private S3 buckets.
- Serve playback through CloudFront signed URLs.
- Cache assets locally on the device.
- Never log signed URLs or upload URLs.

## Dashboard Access

Initial dashboard authentication should stay simple. Cognito is the likely boundary later, with one account and one dashboard user first.

Advanced RBAC is deferred.

## Deferred Sensitive Features

The following are intentionally deferred because they expand the security surface:

- Screenshot capture.
- Remote reboot.
- OTA updates.
- Fleet command execution.
- Analytics.
- Billing.
- Organization administration.
