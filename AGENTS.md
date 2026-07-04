This repo is a local-first Raspberry Pi digital signage proof of concept. You are an engineering agent collaborating with the human. Make small, correct, testable changes that strengthen reliable playback, local control, and dashboard clarity.

## Hard Requirements

- Read `AGENTS.md` first. Read `AGENTS.project.md` when touching product behavior, architecture, persistence, device setup, playback, publishing, recovery, or project constraints.
- Keep changes small and focused. No broad rewrites unless explicitly requested.
- Preserve the local-first contract. Do not introduce AWS/cloud work unless the user explicitly asks for it.
- For AWS/cloud work, read `docs/AWS_COST_GUARDRAILS.md` and treat cost control as a hard requirement: no unnecessary data movement, no surprise paid polling, and no AWS mutation without explicit approval.
- Keep playback and recovery first-class. Do not regress fullscreen playback, reboot recovery, power-loss recovery, network-loss tolerance, or local playlist behavior.
- Keep the five Pi appliances identical at all times except intentional identity/network fields such as hostname, IP address, screen name, screen assignment, and location. Beam-managed scripts, services, package/runtime baselines, playlist files, and published media sets must not drift between C1-C5.
- Keep dashboard, player, device-agent, and Pi/device scripts clearly separated.
- No real secrets in git. Keep `.env.local`, local state, credentials, generated output, and uploaded media out of source control.
- Use atomic writes for local JSON state where practical.
- Treat accessibility as part of dashboard quality: semantic controls, useful labels, readable contrast, keyboard access, and text status that does not rely on color alone.
- Keep validation clean. Treat TypeScript/build errors as blocking.

## Product Priorities

1. Rock-solid local playback on the Pi/TV.
2. Recovery without user interaction after service restart, software reboot, network loss, and power loss.
3. Clear local dashboard controls for one Pi, one TV, one playlist.
4. Useful local health/status evidence: playback state, playlist sync, service state, display mode, temperature, throttle, uptime, and publish results.
5. UI polish that makes the local operations console feel trustworthy and demo-ready.
6. AWS/cloud only after the local end-to-end foundation is proven.

## Repository Shape

- `dashboard/`: Next.js + TypeScript local operations dashboard.
- `player/`: browser playback app retained for local/player experiments.
- `device-agent/`: Pi heartbeat, current-video evidence, playlist cache, and future Pi agent work.
- `device/pi/`: Pi scripts and systemd units for static serving, kiosk, and VLC playback.
- `sample-content/`: tracked seed playlist and fixture metadata. Uploaded MP4s are intentionally ignored.
- `dashboard/local-state/`: ignored runtime dashboard state, including the live editable playlist and publish status.
- `docs/`: architecture, setup, device, security, and phase notes.

## Local State And Playlist Rules

- Treat `sample-content/playlist.local.json` as the tracked seed/baseline playlist.
- Treat `dashboard/local-state/playlist.local.json` as the live dashboard-editable playlist.
- Normal dashboard operations must not dirty tracked source files.
- Playlist edits, uploads, removes, and reorders should update live local state without automatically publishing to the Pi.
- The manual publish button is the intentional operator-controlled step for sending saved playlist changes to the screen.
- Preserve local playback when the network is unavailable. A missing network must not stop cached/local playback.
- Cloud playlist/media behavior must stay publish-gated and cache-aware: normal polling must not return or trigger full media downloads.

## Pi And Playback Rules

- C1-C5 must remain identical Beam appliances except for identity/network metadata. Treat drift between Pis as a production defect: before and after Pi changes, verify managed script/service hashes, Node/VLC package baselines, playlist hash, published asset count/hash set, current-video reporting, and active service state across all five when the hardware is reachable.
- Use `docs/PI_GOLDEN_MASTER_BASELINE.md` as the current managed Pi appliance baseline. C5 is the prototype appliance; every Pi-touching change deployed to C5 must update that PI golden master baseline before the work is considered complete.
- VLC is the preferred field playback path for appliance mode unless the user explicitly asks to test another player.
- Keep Chromium/browser playback available as a fallback/experimental path when already present.
- Pi changes should be reproducible through repo scripts, docs, or systemd units rather than only manual shell history.
- Prefer practical, production-safe fixes: display readiness checks, clear status JSON, playlist reload behavior, encoding guidance, and narrow service improvements.
- Avoid remote reboot, OTA update systems, screenshot capture, fleet management, analytics, or multi-tenant behavior until explicitly approved.

## Dashboard Rules

- Build the actual usable operations experience, not a marketing page.
- Keep the main dashboard focused on the most important state; put deeper controls in focused views.
- Use clear status text for online/offline, playing/stale, sync/behind, publish success/failure, and recovery evidence.
- Keep UI dense enough for operations but polished enough for demos.
- Do not add decorative complexity that hides the local proof signals.
- For user-facing UI changes, check responsive layout so text does not overlap or get clipped.

## Engineering Guidance

- Prefer existing Node/Next/TypeScript patterns in this repo.
- Use structured JSON reads/writes instead of ad hoc text manipulation for playlist/status data.
- Keep side effects behind narrow route handlers or helpers.
- Avoid duplicated SSH/SCP/process helpers; centralize local Pi command behavior.
- Sanitize file names and paths crossing upload, playlist, or remote shell boundaries.
- Add abstractions only when they remove real duplication or clarify ownership.
- Do not introduce third-party dependencies without approval.

## Workflow

1. Inspect the relevant files before editing.
2. Make a brief plan for non-trivial work.
3. Implement the smallest safe patch.
4. Run the narrowest useful validation.
5. Report files changed, validation performed, and anything intentionally deferred.
6. Commit and push when the user asks.

## Validation

Use the smallest validation that proves the changed contract:

- Dashboard/type changes: `npm --workspace dashboard run typecheck`
- Cross-workspace type changes: `npm run typecheck`
- Build-sensitive changes: `npm run build`
- Player changes: `npm --workspace player run build` or a focused browser/player smoke
- Device-agent changes: `npm --workspace device-agent run typecheck`
- Pi service/script changes: dry-run where available, then deploy/test on the Pi when appropriate
- Dashboard UI changes: browser/manual smoke of the affected view

If validation cannot run, state the exact reason.

## Do Not

- Do not create AWS resources or require AWS credentials unless explicitly requested.
- Do not commit `.env.local`, local state, uploaded media, build output, or generated caches.
- Do not rewrite working systems for style.
- Do not hide failures or call manual-only behavior fully automated.
- Do not make dashboard operations depend on internet access.
- Do not regress playback recovery while polishing the UI.

When something is ambiguous, choose the simplest local-first path that preserves playback, recovery, and source-control cleanliness.
