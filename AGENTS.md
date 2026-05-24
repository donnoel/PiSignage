# AGENTS.md

This repository is a Raspberry Pi + AWS digital signage proof of concept. Agents work here to build a small, reliable foundation for one dashboard, one Raspberry Pi, one TV, and offline-capable fullscreen playback.

The project is intentionally not an enterprise signage platform yet. Prefer production-quality guidance, clear contracts, and local validation over broad rewrites or premature cloud complexity.

## Hard Requirements

- **Small, focused diffs.** Solve the specific task first, then generalize only when the code proves the need.
- **Clean builds.** Keep builds, type checks, and configured linters passing with zero warnings.
- **No secrets.** Never commit credentials, tokens, private keys, `.env` files with real values, device certificates, or AWS account identifiers that should remain private.
- **No unapproved AWS deployment.** Do not create, modify, or deploy real AWS infrastructure unless the human explicitly asks for it.
- **No unnecessary dependencies.** Use platform and framework capabilities first. Add dependencies only when they clearly reduce risk or complexity.
- **Offline-first playback.** Device playback must continue from local cached state when network or cloud services are unavailable.
- **Reliability over cleverness.** Device behavior should be appliance-like: deterministic startup, clear status, safe persistence, and recoverable failures.
- **Preserve behavior contracts.** Do not regress playback, local playlist loading, heartbeat writing, reboot recovery, or documented API contracts without calling it out.
- **Accessibility is first-class.** Dashboard and player UI must use semantic controls, readable text, keyboard-friendly flows where applicable, and meaningful labels for visual media.

## Workflow

1. Read existing code, docs, and `AGENTS.project.md` before editing.
2. Propose a minimal plan in 2-5 bullets before making changes.
3. Implement the smallest viable patch.
4. Update docs when behavior, architecture, setup, contracts, or phase scope changes.
5. Run reasonable local validation for touched areas:
   - `npm install` or `npm ci` when dependencies change
   - `npm run build` when buildable code changes
   - `npm run typecheck` when TypeScript changes
   - `npm run lint` when linting is configured
6. If validation cannot run, explain exactly why and what remains unverified.
7. For user-facing UI work, perform an accessibility pass before considering the task done.

## Architecture Boundaries

Keep boundaries explicit:

- `dashboard/` owns the web dashboard user experience and mocked admin views.
- `device-agent/` owns Raspberry Pi local status, playlist reads, heartbeat writes, cache management, and future MQTT communication.
- `player/` owns fullscreen playback behavior and should remain able to run from local playlist/cache data.
- `docs/` owns architecture, phases, setup, API contracts, AWS design, and security notes.
- `infra/` is a placeholder for future infrastructure-as-code. Do not add deployable real cloud resources without approval.
- `sample-content/` contains local playlists and mock media used for development and validation.

Do not blur dashboard, backend, and device responsibilities. Cloud integrations must stay mockable until real AWS implementation is approved.

## Device Reliability Rules

- Playback must have a local fallback path.
- Playlist and heartbeat writes must be atomic where practical.
- Startup and reboot behavior must be documented before being treated as supported.
- Watchdog/recovery behavior should prefer simple, observable retries over hidden failure loops.
- Do not make the device depend on dashboard availability for playback.
- Device logs should be structured enough to diagnose startup, playlist, cache, heartbeat, and playback failures.

## API Contract Discipline

- Document API and MQTT contracts before implementing clients.
- Version contracts when shape or semantics change.
- Mock contract responses locally before wiring real cloud services.
- Keep request/response examples free of real secrets and private account data.
- Treat device pairing, heartbeat, playlist fetch, asset upload, and screen assignment as explicit contracts.

## Persistence and Files

- Use atomic writes for heartbeat, playlist cache, and device state files where practical.
- Keep generated runtime files out of git unless they are intentional sample fixtures.
- Prefer plain JSON for local POC state so behavior is inspectable and easy to reset.
- Document file locations used by the Raspberry Pi agent and player.

## Security and Privacy

- Never log secrets or signed URL tokens.
- Use least-privilege IAM principles in docs and future infra.
- Device identity material must be generated, stored, and rotated intentionally once real AWS IoT pairing exists.
- Screenshot capture, analytics, remote reboot, OTA updates, and fleet management are deferred until explicitly approved.
- Avoid unexpected network calls in local development.

## Accessibility Baseline

For dashboard and player UI, evaluate and implement relevant support:

- Clear page structure, headings, and landmarks.
- Semantic buttons, links, form controls, and status text.
- Keyboard navigation for interactive dashboard controls.
- Sufficient color contrast and legible typography.
- Meaningful alt text or accessible names for displayed media.
- Status communication for online/offline state, heartbeat age, playback state, errors, and loading.
- Reduced-motion handling if animations or transitions are introduced.

Do not claim accessibility support exists unless there is concrete code evidence.

## Code Style

- Keep modules small and feature-local.
- Use TypeScript types for playlist, heartbeat, screen, and API contract shapes.
- Prefer explicit data ownership over shared mutable globals.
- Keep side effects behind narrow functions or services.
- Avoid background loops without bounded intervals, logging, and shutdown behavior.
- Keep command wrappers deterministic and easy to retry.
- Document non-obvious invariants and operational assumptions.

## Deliverables For Each Change

- Summary of what changed.
- Files modified and why.
- User-visible behavior changes.
- What is mocked and what is real.
- Validation performed.
- Accessibility impact for user-facing work.
- Short commit message suggestion.

## What Not To Do

- Do not build the full production platform in one pass.
- Do not add billing, advanced RBAC, analytics, screenshots, remote reboot, OTA updates, or fleet management unless explicitly requested.
- Do not require AWS credentials for local development.
- Do not deploy real infrastructure from this repo without approval.
- Do not hide failures; surface actionable status and retry paths.
- Do not replace simple setup guidance with unnecessary jargon.

If something is ambiguous, pause and ask when guessing would create project risk. Otherwise choose the simplest solution that preserves reliability and forward progress.

## Quota Discipline / Quota-Smart Codex Mode

Use the smallest amount of work necessary to complete the task correctly.

### Before editing

- Read only the files needed for the requested change.
- Do not scan the whole repository unless the task truly requires it.
- Do not run broad audits unless explicitly asked.
- Prefer targeted searches by filename, symbol name, failing test output, or known feature area.
- Ask for clarification only if the requested change is unsafe or ambiguous enough to risk breaking behavior.
- If the likely fix is unclear, use an investigate-first pass and do not edit files until the smallest safe change is identified.

### While editing

- Make the smallest safe diff.
- Avoid opportunistic refactors.
- Do not rewrite working code to improve style.
- Do not touch unrelated files.
- Do not expand the scope beyond the requested task.
- Stop after the requested change is complete.

### Validation

Use the narrowest useful validation first.

Preferred validation ladder:

1. Syntax or build check for the touched target.
2. Targeted unit test if logic changed.
3. Targeted UI test if navigation or user flow changed.
4. Full test suite only for shared architecture, persistence, app startup, CI, release behavior, or broad refactors.

Do not run broad validation when a targeted check is enough.

### Output

Keep responses short and concrete.

Report only:

- what changed
- files touched
- validation performed
- anything skipped and why

Do not produce long explanations, broad recommendations, or extra cleanup unless explicitly requested.
