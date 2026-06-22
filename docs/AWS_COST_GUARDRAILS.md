# AWS Cost Guardrails

Beam AWS work must be local-first, publish-gated, cache-aware, observable, and cheap by default. These guardrails apply to any change that touches AWS infrastructure, cloud traffic, uploads, media delivery, polling, monitoring, billing, or deployed dashboard behavior.

No AWS resource creation, update, destroy, or deploy may happen without explicit approval for the current task.

## Cost Policy

- Treat cost as a product requirement, not cleanup after the fact.
- Prefer the smallest cloud surface that preserves reliable local playback and clear operations.
- Keep media bytes out of routine polling. Large data movement must happen only for an operator upload or a manual publish sync.
- Every AWS change must identify expected daily and monthly cost, new paid APIs, always-on compute, storage growth, data transfer, request volume, metrics, log retention, lifecycle behavior, and rollback cost.
- Pause AWS feature work when budget, transfer, or app-ledger evidence shows unexplained spend.

## Beam Traffic Contract

Allowed anytime:

- Tiny heartbeat/status JSON.
- Tiny release metadata checks, such as desired release ID and manifest checksum.
- Dashboard reads that are cached or scoped enough to avoid noisy paid API calls.

Allowed only on operator action:

- Browser media upload to AWS.
- Manual publish creating immutable release records and manifests.
- Device manifest fetch after a new desired release.
- Per-asset download URL generation only for a missing or changed cached asset.

Never allowed:

- Routine polling that returns signed media URLs.
- Repeated full playlist or media downloads when release ID and checksum are unchanged.
- Automatic device media movement from draft playlist edits.
- Treating a cloud failure as permission to replace valid local cache with first-run fallback media.

## Required AWS Cost Review

Before implementing or deploying any AWS-facing change, document the answer to each item:

- What new AWS services, always-on processes, or provisioned capacity are introduced?
- What paid APIs are called, and how often? Cost Explorer reads must be cached or persisted.
- What S3 transfer can occur, in which direction, and from which operator or device action?
- Does any hot path use DynamoDB Scan? If yes, replace it with GetItem, Query, or a clearly bounded one-off admin task.
- What log groups, metrics, dashboards, alarms, and request metrics are created, and what is their retention/cost?
- What lifecycle rules clean temporary uploads, failed processing output, noncurrent versions, and obsolete renditions?
- What cost allocation tags identify Beam resources?
- What daily/monthly pilot cost is expected after the change?
- What evidence proves routine idle operation sends only tiny status/release traffic?

## Architecture Guardrails

- Large uploads should use direct browser-to-S3 signed upload URLs instead of passing media through always-on app runtime whenever practical.
- Playback assets must be immutable by checksum or version so devices and CDNs can cache safely.
- Devices must validate local cache by asset ID, checksum, and size before downloading.
- Signed playback URLs must be generated server-side only for specific missing assets during release sync.
- Do not store signed URLs in DynamoDB or logs.
- Do not use DynamoDB Scan in normal dashboard, device, heartbeat, release-check, or media-list hot paths.
- Cost Explorer API reads must be cached, persisted, or manually triggered; never call Cost Explorer on every dashboard render.
- CloudWatch and application log groups should use short retention by default for dev and pilot environments.
- All Beam AWS resources should carry cost allocation tags.
- App Runner is acceptable short-term for the current dev alpha, but it is not the final hosting assumption. Future architecture work must compare a smaller API Gateway/Lambda path, ECS Express Mode, or other cheaper options before expanding hosted compute.

## Monitoring Guardrails

- Keep the pilot AWS Budget warning threshold at `$1/day` until a different cap is approved.
- Use AWS Budgets for threshold warnings.
- Use AWS Cost Anomaly Detection for unexpected account/service spikes.
- Use S3 and CloudFront metrics to watch bytes, requests, and cache behavior.
- Keep Beam's publish/sync ledger as the application source of truth for plannedBytes, downloadedBytes, skippedBytes, releaseId, assetCount, and deviceCount.
- Compare AWS transfer bytes against Beam-recorded publish bytes plus a small tolerance. Treat unexplained deltas as cost incidents.
- Dashboard cost views must say when billing data can lag and must not create their own high-frequency Cost Explorer bill.

## Stop Rules

Stop and ask before continuing if:

- A proposed change can move media outside manual publish or operator upload.
- A device would download media during ordinary polling.
- The implementation needs a new always-on AWS service.
- A dashboard page or agent loop would call paid AWS APIs repeatedly.
- A cost alarm, budget warning, or transfer mismatch is unexplained.
- A cloud outage could interrupt valid cached local playback.

## References

- AWS Budgets: https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html
- S3 CloudWatch metrics: https://docs.aws.amazon.com/AmazonS3/latest/userguide/cloudwatch-monitoring.html
- Cost Explorer API best practices: https://docs.aws.amazon.com/cost-management/latest/userguide/ce-api-best-practices.html
- Cost Anomaly Detection: https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html
- App Runner availability change: https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html
