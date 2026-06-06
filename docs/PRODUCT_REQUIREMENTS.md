# Product Requirements

Beam is a local-first digital signage operations console for Raspberry Pi screens. The product goal is simple: make media playback on TVs reliable enough to run unattended, while giving an operator clear local controls for content, screens, devices, status, and recovery.

Playback performance and recovery are the core product. Every feature should either support reliable playback, make operations clearer, or reduce the time needed to recover a screen.

## Real Product Rule

This is being built and tested for real. Do not add placeholder implementation, fake devices, fake screens, fake health, fake media, fake activity, or fake success states. Seed data can exist only as tracked examples; screen and device inventory must come from real operator-created local state. The application must operate on real local state, real uploaded media, real configured devices, and honest unavailable/error states when prerequisites are missing.

## Product Direction

- Start local-first with one account and a small number of Raspberry Pi devices.
- Prepare for a team demo by Wednesday, June 3, 2026 with real local behavior and honest validation evidence.
- After the demo, add five real Raspberry Pi signage systems and soak playback, control, monitoring, recovery, and outage behavior.
- Build the AWS portion only after the local demo and five-device soak prove the operating model.
- Treat VLC as the default field playback path for appliance mode.
- Keep each Pi able to continue playback from cached local media and playlist state during network outages.
- Keep dashboard operations from dirtying tracked source files.
- Prefer clear operational screens over decorative or map-heavy UI.

## Delivery Milestones

### Team Demo: June 3, 2026

The demo must show real behavior, not mock flows.

Requirements:

- Dashboard shows real status from configured local state and any reachable Pi.
- Media upload uses real files and produces playback-safe assets.
- Playlist reorder/remove/publish uses live local state.
- Screens and Devices show honest configured/unconfigured/reachable/unreachable states.
- Troubleshooting shows real SSH/player/service evidence when configured.
- Recovery actions either run against the real Pi or clearly report the missing prerequisite.
- Map UI is absent from the primary demo path.

Acceptance:

- The team can see how one real screen is controlled end to end.
- Any unimplemented area is named plainly in the UI or demo notes.
- No placeholder data is presented as product behavior.

### Five-System Pilot

The five-system pilot is the proving ground before AWS buildout and production.

Requirements:

- Control five individual Raspberry Pi signage systems from the interface.
- Add each system as a real Device and Screen.
- Assign playlists and schedules per screen.
- Monitor online/offline/stale/playback/sync status per system.
- Exercise recovery on individual systems without disrupting healthy systems.
- Validate network outage, power outage, service restart, and publish failure behavior.

Acceptance:

- All five systems can be operated from the interface.
- Each system can keep playing cached content through a network outage.
- Recovery evidence is captured per system.
- Production work does not begin until pilot findings are resolved or explicitly accepted.

### AWS Buildout

AWS comes after the local demo and five-device soak, and must preserve the same real-product rule.

Requirements:

- Implement real backend services only after explicit approval for AWS resource creation.
- Keep least-privilege IAM, private media storage, and clear device identity boundaries.
- Avoid fake cloud success states; if a cloud operation is not wired, show it as unavailable.
- Preserve local cached playback during cloud/network outages.

## Locked App Sections

The dashboard information architecture should use these sections:

- Dashboard
- Media Store
- Playlists
- Screens
- Devices
- Activity
- Troubleshooting
- Settings

The previous map view is removed from the near-term product. Map/location UI is deferred until core operations and reliability are stronger.

## Users And Login

Near-term requirements:

- Support a simple single-admin login for the local operations console.
- Keep credentials and secrets out of git.
- Record authenticated user actions in the activity log once login exists.

Deferred:

- Multi-tenant organizations.
- Billing.
- Advanced RBAC.
- SSO.

## Dashboard

The Dashboard is the first screen operators use to answer whether signage is healthy.

Requirements:

- Show screen status counts: online, offline, stale, and needs attention.
- Show current playback status for each known screen: playing, stale, stopped, unknown, or unreachable.
- Show playlist sync state: current, behind, unknown, or mismatch.
- Show recent publish result and last successful update.
- Show top recovery or troubleshooting actions when a screen needs attention.
- Avoid map dependencies and internet-only UI.

Acceptance:

- A user can tell whether playback is healthy without opening a detail page.
- Status text does not rely on color alone.
- The dashboard remains useful when the internet is unavailable.

## Media Store

The Media Store is the source of reusable media and metadata.

Requirements:

- Upload media from the local dashboard.
- Support MP4 video directly when it passes validation.
- Support MOV by transcoding or converting to a Pi-safe MP4 before playback.
- Support JPEG and PNG by converting them into Pi-safe MP4 still clips before playback.
- Treat MP3 as a separate product decision before implementing audio-only signage behavior.
- Store verbose media details: title, description, tags, notes, original file name, generated playback file, duration, file size, MIME type, validation status, created time, updated time, and readiness for playback.
- Allow tags on videos and still clips.
- Prevent unsupported or unsafe media from entering active playback.

Acceptance:

- The Pi playlist receives only playback-safe media.
- Operators can search or filter by title, tag, type, and readiness.
- Media detail text can be long enough for real campaign notes and operational context.

## Playlists

Playlists define ordered playback for screens.

Requirements:

- Add media from the Media Store.
- Rearrange playlist items.
- Remove playlist items while preserving at least one playable item for assigned screens.
- Show item details: media title, tags, duration, file path, validation status, and Pi sync/reporting state.
- Save playlist changes locally without automatically publishing to assigned devices.
- Keep manual publish as the intentional operator-controlled step before sending saved playlist changes to screens.
- Support transitions later without compromising playback reliability.

Acceptance:

- Reorder, remove, upload, and publish operations update ignored local state.
- A failed publish leaves the local playlist intact and clearly reports the failure.
- Network loss does not stop already-cached playback.

## Layouts And Overlays

Layouts let an operator compose reusable signage frames from media, text, and simple graphic layers while preserving the Pi-safe playback path.

Requirements:

- Keep VLC appliance playback as the field default.
- Store layout templates in ignored local state until a backend exists.
- Start with a 1920x1080 canvas and simple layers: media, text, and rectangle shapes.
- Support common first layouts: fullscreen media with text overlay, inset video with a border and call-to-action, and side-by-side regions.
- Treat saved layout changes like playlist changes: save locally first and do not automatically publish.
- For field-ready playback, render a layout to a playback-safe MP4 before it enters a Pi playlist.
- Adding a rendered layout to a playlist must save locally and require the normal manual publish action before any screen changes.
- Do not make live browser layout playback the default field path until it passes recovery and soak validation.

Acceptance:

- A saved layout template can be validated locally without touching the Pi.
- A layout is not publishable until it has a ready rendered MP4 asset.
- The Pi playlist continues to receive video assets, preserving cached playback and reboot recovery.
- Rendered layout playlist additions use the same Pi-safe MP4 checks as ordinary Media Store items.

## Screens

Screens represent TVs or display endpoints that operators care about.

Requirements:

- Add and remove screens.
- Give each screen a name, location label, notes, assigned playlist, and assigned device.
- Show online/offline/stale status.
- Show playback state, last heartbeat, last publish, playlist sync, and current media when known.
- Organize screens in a dense operations table, not a map.

Acceptance:

- A user can find a screen quickly and see whether it is healthy.
- Removing a screen does not delete media or device history without explicit confirmation.

## Devices

Devices represent Raspberry Pi hardware.

Requirements:

- Add multiple devices.
- Store local connection details, such as host, SSH user, root path, player type, and notes, without committing secrets.
- Track device status: reachable, last seen, boot ID, uptime, display mode, service state, temperature, throttle state, disk free, current playlist, and current asset when available.
- Assign one device to one screen initially.
- Keep the UI organized for multiple devices even while the first real install uses one Pi.

Acceptance:

- The operator can see which Pi powers which screen.
- Status probes do not block local playback.
- Device data can be represented in local JSON and migrated later to a backend.

## Activity

Activity is the local audit trail for operations and recovery.

Requirements:

- Record uploads, metadata edits, playlist changes, publishes, screen changes, device changes, recovery actions, and important probe failures.
- Include timestamp, actor when known, entity type, entity ID, action, result, and message.
- Keep the activity log local-first and append-friendly.
- Avoid storing secrets or signed URLs.

Acceptance:

- A user can answer what changed recently and whether it succeeded.
- Recovery attempts leave enough evidence to understand what happened.

## Troubleshooting

Troubleshooting should reduce recovery time without hiding risk.

Requirements:

- Provide one-click recovery for a screen/device.
- Use a safe recovery sequence: probe status, restart VLC, reload playlist, restart the player service, and only reboot after explicit approval.
- Provide SSH connection guidance and a copyable SSH command.
- Provide a link or command to open the Pi player/UI when available.
- Show recent service state, player status, publish status, display mode, temperature, throttle state, uptime, boot ID, and last errors.

Acceptance:

- The first recovery action is narrow and safe.
- Reboot is not treated as the default first response.
- Every recovery action is logged.

## Settings

Settings hold local operational configuration.

Requirements:

- Configure local Pi connection defaults.
- Configure dashboard labels, media conversion options, upload limits, and playback defaults.
- Configure schedule defaults and timezone.
- Keep secrets in environment variables or ignored local state.
- Make export/import of local configuration and metadata a later requirement.

Acceptance:

- The app can be moved between local machines without committing runtime state or secrets.
- Missing configuration is reported clearly.

## Scheduling

Scheduling controls when screens should play.

Requirements:

- Support business-hours schedules such as on at 7:00 AM and off at 5:00 PM.
- Store timezone explicitly.
- Assign schedules per screen.
- Cache schedules locally on the Pi so network loss does not break expected behavior.
- Start with simple daily windows before exceptions or holidays.

Acceptance:

- A screen can follow a simple local schedule without dashboard interaction.
- Schedule state is visible on the screen detail and dashboard.

## Playback Options

Requirements:

- Keep VLC appliance playback as the field default.
- Keep browser playback available as a fallback or experimental path when useful.
- Add transitions only after media validation, playlist sync, scheduling, and recovery are stable.
- Any playback option must preserve reboot recovery and network-loss tolerance.

## Reliability Requirements

Playback performance and reliability are paramount.

Required failure scenarios:

- Pi reboot returns to fullscreen playback without dashboard interaction.
- Player service restart returns to playback.
- Network outage does not stop cached/local playback.
- Power outage followed by boot returns to playback.
- Bad uploads are rejected or converted before reaching the Pi playlist.
- Failed publishes are visible and recoverable.
- Local JSON writes are atomic where practical.

## Deferred

- Map/location UI.
- Remote reboot as a default recovery action.
- OTA updates.
- Screenshot capture.
- Fleet-management workflows beyond the five-system pilot.
- Advanced scheduling exceptions and holidays.
- Analytics.
- Billing.
- Advanced RBAC and organizations.
