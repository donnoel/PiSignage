# Beam Client Stress Runbook - 2026-06-29

Use this runbook while the client stresses Beam. One operator should watch the TV output, and one operator should record dashboard, AWS, and Pi evidence. Do not treat a dashboard success message as playback proof without Pi/display evidence.

## Current Local Scope

- Today the team is in the study, so only C5 is locally reachable.
- Run all local SSH/display/service checks against C5 only.
- For C1-C4, record cloud heartbeat and release state only. Mark live Pi parity, display checks, and SSH checks as deferred until those devices are reachable.

## Post-Deploy AWS Gate

Run after the current deploy completes:

```sh
AWS_PROFILE=beam-dev-admin aws sts get-caller-identity --output json
AWS_PROFILE=beam-dev-admin aws cloudformation describe-stacks --region us-west-2 --stack-name BeamDevFoundationStack --query 'Stacks[0].{StackStatus:StackStatus,LastUpdatedTime:LastUpdatedTime,Outputs:Outputs[*].{Key:OutputKey,Value:OutputValue}}' --output json
AWS_PROFILE=beam-dev-admin aws apprunner list-services --region us-west-2 --query 'ServiceSummaryList[?ServiceName==`beam-dev-dashboard`].{Name:ServiceName,Status:Status,UpdatedAt:UpdatedAt,Url:ServiceUrl}' --output json
```

Pass criteria:

- Stack is `CREATE_COMPLETE` or `UPDATE_COMPLETE`.
- App Runner is `RUNNING`.
- Dashboard URL is the expected Beam dev dashboard URL.
- No unexpected stack rollback, failed resource, or service pause is present.

## Local Automated Gate

Run before handing the dashboard to the client:

```sh
npm run test:release-hardening
```

Run with dashboard running when upload/rejection behavior is in scope:

```sh
npm run dev:dashboard
npm run test:bad-upload
```

Pass criteria:

- Typecheck is clean.
- Release-state, schedule, and local failure fallback smokes pass.
- Bad upload receives a clear rejection and does not mutate playlist/media state.

## C5 Live Evidence Gate

Use the dashboard URL that is under test:

```sh
PISIGNAGE_DASHBOARD_URL=http://localhost:3000 npm run drill:pi
```

Capture:

- Date, operator, and dashboard URL.
- C5 host and SSH reachability.
- Playlist ID/version and asset count.
- `player-status.json` state.
- `heartbeat.json` or cloud heartbeat timestamp.
- VLC service state.
- Display mode.
- Boot ID and uptime.
- Publish status and timestamp.
- Any warnings or failed diagnostics.

Pass criteria:

- C5 reports current heartbeat/status.
- VLC is active or the dashboard reports a real unavailable state.
- Playback is confirmed on the TV by a human.
- Publish status is understandable and not stale without being labeled stale.

## Client Stress Scenarios

Record each scenario as pass, fail, or deferred.

1. Dashboard loads after deploy.
2. What's Playing identifies healthy, stale, offline, and needs-attention states in text.
3. Library lists real media and does not show fake success states.
4. Upload a valid MP4 and confirm it becomes ready or clearly processing.
5. Upload invalid media and confirm it is rejected without changing playlist state.
6. Create or edit a playlist.
7. Reorder playlist items.
8. Remove a playlist item while preserving at least one playable item for assigned screens.
9. Assign playlist to C5.
10. Publish playlist to C5.
11. Confirm C5 cloud/device record, screen record, heartbeat, and dashboard row agree on assigned playlist after publish.
12. Confirm C5 TV playback after publish.
13. Refresh the dashboard repeatedly and confirm no duplicate publish, upload, or recovery action occurs.
14. Open dashboard in a second tab and repeat status refresh/publish visibility checks.
15. Review the Screens view for the C5 state.
16. Run Remote diagnostics from the selected C5 row on Screens.
17. Run recovery only after explicit operator approval.
18. Confirm Activity shows meaningful evidence for any action that should be auditable.
19. Confirm AWS transfer ledger is explainable for any manual publish media movement.
20. Confirm cost view does not call Cost Explorer on dashboard refresh.

## Failure Drills

Only run mutating drills when an operator approves the exact action.

- Service restart: `npm run drill:pi -- --service-restart`
- Recovery workflow: `npm run drill:pi -- --recover`
- Manual reboot: capture baseline, reboot C5, confirm boot ID changed and playback resumed without dashboard interaction.
- Network loss: disconnect C5 network after cached playback is visible, confirm TV playback continues, reconnect, then confirm heartbeat/status recovers.
- Power loss: power-cycle C5 and display, then confirm unattended playback recovery.

## Evidence Template

```text
Scenario:
Operator:
Time:
Dashboard URL:
Device/screen:
Expected:
Observed:
TV/display evidence:
Dashboard evidence:
AWS evidence:
Pi evidence:
Result: pass | fail | deferred
Follow-up:
```

## Stop Rules

- Stop if C5 cached playback is interrupted by cloud/dashboard failure.
- Stop if routine polling returns signed media URLs or triggers media downloads without manual publish.
- Stop if dashboard refresh creates paid Cost Explorer calls.
- Stop if an AWS deploy rolls back or App Runner stops.
- Stop if a recovery/reset/reboot action would affect a device without explicit approval.
