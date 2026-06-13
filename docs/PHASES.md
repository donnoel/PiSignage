# Phases

Each phase should stay small enough to validate locally or with clearly documented manual steps. Do not deploy real AWS resources before an explicit approval task. Playback reliability, local recovery, and source-control cleanliness are blocking concerns in every phase.

The current product baseline lives in `docs/PRODUCT_REQUIREMENTS.md`.

## Current Direction

Beam is now a local-first operations console moving through production-minded hardening with these target dashboard sections:

- What's Playing
- Library
- Playlists
- Screens
- Screen Health / Devices
- Activity
- Troubleshooting
- Settings

Map/location UI is deferred. Near-term screen organization should use clear tables, detail panels, and status summaries instead of a map. The current UI still has overlapping Screen Health and Screens surfaces; collapsing them is the next cleanup opportunity.

## Delivery Track

- Current sprint: harden real local operations, screen health, playlists, media, recovery, and cloud alpha truthfulness.
- Five-system pilot and soak: operate five real Raspberry Pi signage systems from the interface and validate playback, control, monitoring, recovery, and outage behavior.
- AWS dev alpha: approved and partially implemented, but every deploy or infrastructure mutation still requires explicit approval.
- Production: only after local pilot and cloud reliability, recovery, and control findings are resolved or explicitly accepted.

## Phase 0: Existing Local Foundation

Goal: preserve the working local proof while the product shape changes.

Implementation status: existing local foundation is present.

Acceptance:

- Repo structure exists for `dashboard/`, `device-agent/`, `player/`, `device/pi/`, `docs/`, `infra/`, and `sample-content/`.
- Dashboard, player, device agent, and Pi scripts remain separated.
- No AWS credentials are required.
- Uploaded media, local state, credentials, generated output, and caches remain out of source control.

Validation:

- `npm install` or `npm ci`
- `npm run typecheck`
- `npm run build`

## Real Implementation Rule

All phases must build real local product behavior. Do not use placeholder code, mock data, fake devices, fake health, fake activity, or fake success states to complete a phase. Seed data is acceptable only as tracked examples; screen and device inventory must come from real operator-created local state. Missing hardware or configuration must produce honest unavailable/error states, and validation reports must say exactly what was tested for real.

## Phase 1: Requirements And Information Architecture

Goal: re-baseline product requirements and align the dashboard structure before deeper implementation.

Acceptance:

- `docs/PRODUCT_REQUIREMENTS.md` defines the product direction.
- `docs/PHASES.md` reflects the new roadmap.
- Dashboard sections are locked in direction as: What's Playing, Library, Playlists, Screens, Devices/Screen Health, Activity, Troubleshooting, Settings.
- Map/location UI is marked removed/deferred.
- Current sprint, five-system soak, AWS buildout, and production gates are explicit.

Validation:

- Review `docs/PRODUCT_REQUIREMENTS.md`.
- Review `docs/PHASES.md`.
- Confirm no runtime behavior changed.

## Phase 2: Local Operations Readiness

Goal: keep the core local operations paths honest and useful while the product hardens.

Acceptance:

- What's Playing, Playlists, Screens, Devices, and Troubleshooting paths show real local behavior.
- Media upload uses real files and produces playback-safe assets.
- Playlist edits use live local state.
- Publish/recovery paths either run against a real configured Pi or clearly report missing prerequisites.
- The map is absent from the primary operations path.
- No placeholder data is presented as product behavior.

Validation:

- `npm --workspace dashboard run typecheck`
- Manual dashboard smoke of core operations paths.
- Real upload/edit/publish smoke when Pi is configured.
- Honest unconfigured-state smoke when Pi is not configured.
- Record exactly what was proven on hardware.

## Phase 3: What's Playing And Screens Rework

Goal: make the What's Playing overview and Screens section useful for operations without relying on a map.

Acceptance:

- What's Playing shows online, offline, stale, and needs-attention counts.
- What's Playing shows playback state, playlist sync, last publish, last heartbeat, and top recovery prompts.
- Screens view is an operations table with screen name, location label, assigned device, assigned playlist, status, last seen, playback state, and sync state.
- Existing map UI is removed from the active navigation and screen workflow.
- Status is communicated in text, not color alone.

Validation:

- `npm --workspace dashboard run typecheck`
- Manual dashboard smoke of the What's Playing and Screens sections.
- Responsive check for affected views.

## Phase 4: Local Data Stores

Goal: establish local-first state files for the new app sections before adding complex workflows.

Acceptance:

- Local JSON stores exist for media, screens, devices, activity, settings, and schedules.
- Writes are atomic where practical.
- Runtime state lives under ignored local-state paths.
- Tracked seed/baseline data remains separate from live editable state.
- Empty screen and device stores remain empty until an operator creates real inventory.
- Existing playlist behavior continues to use `dashboard/local-state/playlist.local.json` as the live editable source.

Validation:

- `npm --workspace dashboard run typecheck`
- Focused local-state read/write tests or script smoke where available.
- Confirm `git status` does not show runtime JSON generated by normal dashboard operations.

## Phase 5: Library

Goal: turn uploads into a reusable media library with verbose metadata and playback readiness.

Acceptance:

- Library lists uploaded media.
- Operators can upload MP4, MOV, JPEG, and PNG.
- JPEG and PNG uploads become Pi-safe MP4 still clips before playback.
- MOV is converted or rejected with a clear readiness message until conversion is implemented.
- MP3 remains deferred until audio-only behavior is explicitly designed.
- Media details support long title/description/notes plus tags, original filename, generated playback file, duration, file size, MIME type, validation status, and readiness.
- Unsafe or unsupported files cannot enter active playback.

Validation:

- `npm --workspace dashboard run typecheck`
- Upload smoke for MP4 and JPEG/PNG conversion.
- Conversion failure smoke when `ffmpeg` is missing or invalid input is supplied.
- Confirm playlist/Pi publish still receives playback-safe MP4 assets.

## Phase 6: Playlists

Goal: make playlists consume Library assets and remain safe to publish.

Acceptance:

- Playlist items can be added from the Library.
- Playlist items can be rearranged and removed.
- Playlist item details show media metadata, duration, tags, readiness, local path, and Pi reporting/sync state.
- Playlist edits update live local state and mark changes as pending manual publish.
- Manual publish remains the intentional operator-controlled step before sending saved playlist changes to screens.
- At least one playable item remains for an assigned playlist unless the user explicitly unassigns it.

Validation:

- `npm --workspace dashboard run typecheck`
- Reorder/remove/add smoke.
- Publish failure smoke that proves local state remains intact and the failure is visible.

## Phase 6A: Layouts And Overlays

Goal: let operators create overlay and multi-region signage layouts while keeping the field playlist video-only until rendered output is proven.

Five-step implementation plan:

1. Define the local layout template contract and validation helpers while keeping Pi playlists video-only.
2. Add a local layouts store/API so the dashboard can create, read, update, and delete saved templates without publishing.
3. Build a compact dashboard layout editor/preview with MVP presets: fullscreen with overlay, inset video with text, and side-by-side regions.
4. Add an `ffmpeg` render pipeline that turns a saved layout into a playback-safe MP4 Library item.
5. Wire rendered layout assets into playlist editing and manual publish, then validate on the Pi path, including five-device parity checks when hardware is reachable.

Acceptance:

- Layout templates live in ignored local state and do not dirty tracked source files.
- A layout can contain media, text, and rectangle layers on a 1920x1080 canvas.
- Saved layout edits do not automatically publish.
- A layout is not playlist-playable until it has a ready rendered MP4 asset.
- Adding a rendered layout to a playlist saves locally and leaves screen publish manual.
- VLC remains the field playback default; browser layout playback stays fallback/experimental until explicitly approved.

Validation:

- `npm --workspace dashboard run typecheck`
- Local layouts API smoke once routes exist.
- Dashboard editor responsive smoke once UI exists.
- Render smoke with a short layout MP4 once `ffmpeg` rendering exists.
- Rendered layout add-to-playlist smoke once playlist wiring exists.
- Pi publish/playback/recovery smoke before calling rendered layouts field-ready.

## Phase 7: Devices

Goal: support multiple local Raspberry Pi devices in a clear inventory.

Acceptance:

- Devices can be added and removed.
- Device records include name, host, SSH user, root path, player type, notes, assigned screen, and status fields.
- Secrets remain in environment variables or ignored local state.
- Device status shows reachable, last seen, boot ID, uptime, display mode, service state, temperature, throttle state, disk free, current playlist, and current asset when available.
- One device can be assigned to one screen initially.

Validation:

- `npm --workspace dashboard run typecheck`
- Local device CRUD smoke.
- SSH probe smoke when Pi config is available.
- Confirm failed probes do not block playback.

## Phase 8: Activity

Goal: create a local audit trail for operations and recovery.

Acceptance:

- Activity log records uploads, metadata edits, playlist changes, publishes, screen changes, device changes, recovery actions, and important probe failures.
- Each entry includes timestamp, actor when known, entity type, entity ID, action, result, and safe message.
- Activity never stores secrets, passwords, signed URLs, or raw credentials.
- Activity is readable from the dashboard.

Validation:

- `npm --workspace dashboard run typecheck`
- Focused smoke that performs one upload/edit/publish/recovery action and confirms an activity entry.

## Phase 9: Troubleshooting And Recovery

Goal: give operators one clear place to diagnose and recover a screen.

Acceptance:

- Troubleshooting view shows player status, service state, display mode, publish status, temperature, throttle state, uptime, boot ID, and last errors.
- One-click recovery runs a safe sequence: probe status, restart VLC, reload playlist, restart player service.
- Reboot requires explicit approval and is not the default first action.
- SSH guidance and a copyable SSH command are available.
- Pi player/UI link or command is available when configured.
- Every recovery action writes activity.

Validation:

- `npm --workspace dashboard run typecheck`
- Recovery action smoke against configured Pi or dry-run command path.
- `node scripts/local-failure-smoke.mjs`
- `device/pi/bin/pisignage-vlc-playlist.mjs --dry-run` when applicable.

## Phase 10: Scheduling

Goal: support simple business-hours playback schedules.

Acceptance:

- Schedules have a name, timezone, on time, off time, active days, and assigned screens.
- A screen can show its current schedule state.
- The Pi can cache schedule state locally.
- Network loss does not break already-cached schedule behavior.
- Start with simple daily windows before exceptions or holidays.

Implemented foundation:

- Dashboard Scheduling view manages simple daily windows and per-screen assignment.
- Schedule changes are stored in local JSON and published to the Pi as cached schedule state when configured.
- Pi-side `pisignage-enforce-schedule.mjs` plus a user timer can enforce cached schedules offline by waking the HDMI output and starting VLC during active windows, then stopping VLC and turning HDMI off outside active windows.

Validation:

- `npm --workspace dashboard run typecheck`
- Schedule CRUD smoke.
- Local schedule evaluation tests around timezone and boundary times.
- Pi/offline schedule smoke when device support exists.

## Jump-Ahead Track: Validation And Release Hardening

Goal: make the local product and five-system pilot safer by validating state contracts and running repeatable failure drills before adding more settings/login work.

Acceptance:

- Focused checks validate playlist, media, screen, device, schedule, settings, activity, and publish-status local JSON contracts.
- Bad media uploads are rejected by the real dashboard and do not mutate playlist or media state.
- Pi drill tooling separates safe read-only diagnostics from explicit service restart/recovery actions.
- Reboot, service restart, network loss, power loss, stale publish, and bad media upload have a concrete evidence checklist.
- Hardware-only drills are not claimed as passed until run against the real Pi/display.

Validation:

- `npm run test:release-hardening`
- `npm run test:bad-upload` with the dashboard running.
- `npm run drill:pi`
- `npm run drill:pi -- --service-restart` when touching the live VLC service is acceptable.
- Manual reboot, network-loss, and power-loss drills using `docs/RELEASE_HARDENING.md`.

## Phase 11: Settings And Local Admin Login

Goal: centralize local configuration and add a simple operator login.

Acceptance:

- Settings view manages local labels, defaults, upload limits, conversion settings, schedule timezone, and safe non-secret configuration.
- Secrets stay in environment variables or ignored local state.
- Single-admin login protects dashboard operations.
- Activity entries include actor once login exists.
- Advanced RBAC remains deferred.

Validation:

- `npm --workspace dashboard run typecheck`
- Settings save/load smoke.
- Login/logout smoke.
- Confirm secrets are not written to tracked files.

## Phase 12: Five-System Pilot

Goal: operate five real Raspberry Pi signage systems from the interface before AWS buildout and production.

Acceptance:

- Five real Devices and Screens are configured.
- Each system can be assigned media, playlist, and schedule from the interface.
- Dashboard shows online/offline/stale/playback/sync status for each system.
- Recovery can be run for one system without disrupting healthy systems.
- Pilot findings are tracked and resolved or explicitly accepted before AWS buildout.

Validation:

- Five-device setup smoke.
- Per-screen playlist publish smoke.
- Network outage, power outage, service restart, and failed publish drills.
- Recovery evidence review per system.

## Phase 13: AWS Buildout

Goal: expand the real cloud portion from the current `dev` alpha into a production-safe cloud path, with explicit approval before creating or mutating resources.

Acceptance:

- AWS resources are created, updated, or destroyed only after approval.
- Device identity, dashboard auth, media storage, playlist assignment, heartbeat/status, and publish/sync contracts are real.
- Private media uses least-privilege storage and delivery.
- Cloud outage does not stop cached local playback.
- Cloud status never reports success for operations that are not actually wired.

Validation:

- Infrastructure plan review before creation.
- Least-privilege IAM review.
- Real upload, publish, heartbeat, and playlist fetch smoke against the AWS environment.
- Network-outage playback validation against a previously synced device.

## Phase 14: Playback Options And Transitions

Goal: add playback polish only after operational safety is strong.

Acceptance:

- Playback options are represented explicitly and safely.
- VLC remains the field default.
- Browser playback remains available as fallback/experimental behavior.
- Transitions are optional and do not regress Pi recovery, cached playback, or playlist reload behavior.
- Reduced-motion and TV readability concerns are considered for dashboard/player UI.

Validation:

- `npm run typecheck`
- Player build or focused player smoke.
- Reboot, network-offline, and service-restart checks before calling transitions field-ready.

## Phase 15: Production Readiness

Goal: prepare for production only after the five-system pilot and approved cloud work prove the operational model.

Acceptance:

- Pilot reliability findings are resolved or explicitly accepted.
- Backup/restore expectations are documented.
- Operational runbooks exist for setup, media upload, publish, outage recovery, and support.
- Security review covers secrets, device identity, media access, and dashboard auth.
- Production monitoring requirements are defined.

Validation:

- Production-readiness review.
- End-to-end rehearsal with real devices and real media.
- Recovery drill signoff.
