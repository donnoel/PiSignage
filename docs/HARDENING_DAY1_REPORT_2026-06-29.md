# Beam Day 1 Hardening Report - 2026-06-29

This report captures the starting evidence for client-confidence hardening. It is a snapshot, not a signoff. AWS was rechecked after the in-progress deploy completed, but each client-stress session should still capture fresh evidence before making a release claim.

## Scope

- Repo: `/Users/donnoel/Development/PiSignage`
- Branch at start: `main...github/main`
- Local commit at start: `e9066a4 Align Node runtime and patch Vite`
- Local live-device scope today: C5 only, because the team is in the study.
- C1-C4 scope today: AWS heartbeat/status evidence only; live SSH, display, and parity checks are deferred until those Pis are reachable.
- AWS region: `us-west-2`
- AWS environment: Beam dev alpha

## Evidence Captured

- Local release-hardening gate passed on 2026-06-29:
  - `npm run typecheck`
  - `npm run test:cloud-inventory`
  - `npm run test:release-state`
  - `npm run test:schedule`
  - `npm run simulate:failures`
- Dashboard-facing smoke checks passed with the local dashboard running:
  - `npm run test:bad-upload`
  - `npm run test:dashboard-css`
- AWS read-only evidence captured before the in-progress deploy:
  - CloudFormation `BeamDevFoundationStack`: `UPDATE_COMPLETE`
  - App Runner `beam-dev-dashboard`: `RUNNING`
  - Dashboard URL matched the documented App Runner URL.
  - DynamoDB counts: 5 devices, 5 screens, 4 playlists, 15 assets, 23 release/sync records, 5 heartbeat records.
  - Latest cloud heartbeats showed C1-C5 reporting `playlist-donnoel` v3 as `playing` with `networkOnline: true`.
  - Daily budgets existed at `$1/day` with 80% and 100% actual-spend notifications.
  - S3 lifecycle rules, bucket tags, request metrics, and 30-day log retention were present for the checked Beam buckets/logs.
- AWS read-only evidence refreshed after the deploy completed:
  - CloudFormation `BeamDevFoundationStack`: `UPDATE_COMPLETE`
  - Stack `LastUpdatedTime`: `2026-06-29T18:47:25.048000+00:00`
  - App Runner `beam-dev-dashboard`: `RUNNING`
  - Device, screen, and heartbeat table counts remained 5 each.
  - C1-C5 cloud heartbeats were current around `2026-06-29T18:52Z` to `2026-06-29T18:53Z`, reporting `playlist-donnoel` v3, `playing`, and `networkOnline: true`.
- C5 read-only local drill passed from the study network:
  - Dashboard: `http://localhost:3000`
  - SSH target: `C5.local`
  - SSH reachable as the configured Pi user.
  - VLC service diagnostic returned OK with `NRestarts=0`.
  - Network diagnostic reported Wi-Fi path through `wlan0`.
  - Display diagnostic saw `HDMI-A-1` connected.
  - Health diagnostic reported uptime of about 1 week and 1 day.
  - Publish freshness was fresh: playlist v10, publish v10, 9/9 assets.

## Known Risks

- AWS evidence is fresh for the post-deploy snapshot above, but must still be refreshed during each client-stress session.
- The cloud device inventory had screen assignments for all five screens, but several device records had stale or null `playlistId` values. The code now keeps linked screen/device playlist fields aligned on future cloud assignment and publish flows.
- Source media storage was about 1.0 GB, while playback and thumbnail buckets were empty. Confirm whether that is expected for the current alpha processing path.
- Recent cost history had large S3 spikes on June 15-17 and manual Cost Explorer spend on June 19-21. Idle cost after that looked closer to the App Runner baseline, roughly `$0.42/day`, but billing must be rechecked after deploy.
- AWS activity table was empty during the snapshot. Client-confidence hardening needs real cloud activity evidence for upload, edit, publish, reset/recovery, and failure paths.
- C5 TV playback still needs human visual confirmation during the client-stress session; the read-only drill confirms service/status evidence, not what the operator sees on the display.
- C1-C4 cannot receive local parity signoff today. Do not call C1-C5 appliance parity complete until all five are reachable or explicitly accepted as partially verified.

## Day 1 Actions

1. Treat this document as the Day 1 baseline snapshot.
2. Before each stress session, rerun the AWS post-deploy verification in `docs/CLIENT_STRESS_RUNBOOK_2026-06-29.md`.
3. Run C5 local evidence checks from the study network.
4. Record C1-C4 as cloud heartbeat only until they are locally reachable.
5. Convert failed checklist items into small patches, starting with dashboard truthfulness and test coverage.

## Acceptance For Moving Past Day 1

- Post-deploy AWS state is refreshed and documented.
- C5 has live Pi evidence plus human TV playback confirmation.
- C1-C4 have either live evidence or an explicit deferred status.
- Dashboard publish and assignment views show one coherent playlist source of truth.
- Any cost, storage, activity, or UI gaps are tracked as concrete follow-up tasks.
