# Release Hardening Drills

Beam release hardening must prove real local behavior. Automated checks can catch state drift and safe failure handling, but hardware recovery still needs evidence from the Raspberry Pi and display.

## Automated Checks

- `npm run test:release-hardening`
  - Runs workspace type checks.
  - Validates the live local playlist when present.
  - Validates media, screen, device, schedule, settings, activity, and publish-status JSON stores when present.
  - Runs schedule boundary checks.
  - Runs local failure fallback checks for the device agent.
- `npm run test:bad-upload`
  - Requires the dashboard running at `http://localhost:3000` unless `PISIGNAGE_DASHBOARD_URL` is set.
  - Posts an unsupported media file to the Library and playlist upload paths.
  - Confirms the upload is rejected and playlist/media state is unchanged.
- `npm run drill:pi`
  - Requires the dashboard running.
  - Reads local recovery history.
  - Use the selected screen on Screens for remote Pi diagnostics.
  - Checks publish freshness without touching the live Pi player.
  - Use `npm run drill:pi -- --service-restart` only when it is safe to restart VLC on the Pi.
  - Use `npm run drill:pi -- --recover` only when it is safe to run the one-click recovery workflow.

## Evidence To Capture

For each manual drill, record:

- Date and operator.
- Screen and device name.
- Pi host.
- Playlist version and asset count.
- Publish status and timestamp.
- Last heartbeat.
- VLC service state.
- Boot ID.
- Uptime.
- Player status JSON snapshot.
- Result and follow-up action.

## Manual Failure Drills

### Reboot

1. Capture baseline with `npm run drill:pi`.
2. Reboot the Pi using a manual SSH command or local console.
3. Wait for the Pi to return.
4. Run `npm run drill:pi` again.
5. Pass criteria: boot ID changed, VLC service is active, playlist/media sync is fresh, and the display resumed playback without dashboard interaction.

### Service Restart

1. Run `npm run drill:pi -- --service-restart`.
2. Watch the display.
3. Run `npm run drill:pi`.
4. Pass criteria: VLC restarts cleanly, status refreshes, and playback resumes on the assigned playlist.

### Network Loss

1. Capture baseline with `npm run drill:pi`.
2. Disconnect the Pi from the network without stopping power.
3. Confirm cached playback continues on the display.
4. Reconnect the network.
5. Run `npm run drill:pi`.
6. Pass criteria: playback survives the outage, heartbeat returns, and publish/sync status becomes clear after reconnect.

### Power Loss

1. Capture baseline with `npm run drill:pi`.
2. Power-cycle the Pi and display.
3. Wait for unattended boot.
4. Run `npm run drill:pi`.
5. Pass criteria: VLC returns to active playback, boot ID changed, and no dashboard action was needed.

### Stale Publish

1. Create or observe a publish failure with a real configured Pi.
2. Confirm the dashboard shows failed or stale publish status.
3. Run `npm run test:release-state`; it should fail if publish status claims a stale playlist version or asset count.
4. Retry publish from the dashboard.
5. Pass criteria: the stale state is visible, retry succeeds or reports the real failure, and local playlist state remains intact.

### Bad Media Upload

1. Keep the dashboard running.
2. Run `npm run test:bad-upload`.
3. Pass criteria: invalid media receives HTTP 400 and live playlist/media state does not change.

Do not mark reboot, network loss, or power loss as release-passed until they are run against real hardware.
