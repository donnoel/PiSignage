# AGENTS.md

This repo is an Apple-platform app codebase. You are an engineering agent (Codex) collaborating with the human. Your job is to make small, correct, testable changes with a clean build at every step.

## Hard requirements (do not violate)
- **No build warnings.** Treat warnings as errors in practice.
- **No large rewrites.** Prefer small, surgical diffs.
- **Apple-native only.** No third-party libraries unless explicitly requested.
- **SwiftUI + MVVM.** Keep UI declarative; isolate logic in view models/services.
- **Concurrency correctness.** Avoid broad `@MainActor` on data models / filesystem / networking types. Use actors/services for isolation.
- **File persistence must be safe.** Use atomic writes where appropriate.
- **Privacy-first.** No unexpected network calls.
- **Preserve core behavior contracts.** Do not regress existing user-visible flows without explicitly calling it out.
- **Accessibility is first-class.** Treat accessibility as a foundation requirement for every user-facing change, not a later polish pass.

## Workflow
1. Read existing code and architecture before editing.
2. Read `AGENTS.project.md` before making project-specific decisions.
3. Propose a minimal plan in 2-5 bullets.
4. Implement the smallest viable patch; solve the specific problem first before generalizing.
5. Ensure build passes with **zero warnings**.
6. If tests exist or are touched, run them. Add tests for non-trivial logic.
7. If behavior changed, update docs (`README.md` / `AGENTS.project.md`) in the same patch.
8. Keep changes easy to validate locally.
9. For user-facing UI work, perform an accessibility pass before considering the task done.

## Accessibility baseline (required)
For every user-facing view, feature, or interaction, evaluate and implement the accessibility support that is relevant to that code.

Always scan for and handle, where applicable:
- VoiceOver support with clear labels, values, hints, traits, and reading order
- Semantic controls and roles using Apple-native accessibility APIs
- Dynamic Type / scalable text where the platform and UI call for it
- Sufficient contrast and legibility in light/dark appearances
- Hit target size and interaction affordance
- Reduce Motion / Reduce Transparency accommodations where motion, blur, or translucency are used
- State communication for toggles, selections, progress, timers, alerts, and transient status
- Focus behavior and keyboard navigation where relevant (especially macOS/tvOS)
- Image/chart/media descriptions when visual meaning would otherwise be lost
- Accessibility actions or adjustable behavior for custom controls when needed

Rules:
- Do not claim accessibility support exists unless there is concrete code evidence.
- Prefer semantic SwiftUI / Apple-native APIs over custom accessibility workarounds.
- If a custom control or visual treatment weakens accessibility, fix it or call out the gap explicitly.
- When shipping or reviewing a feature, note what accessibility support was added, verified, missing, or not applicable.
- When asked for an accessibility audit, report: what was scanned, what was identified in code, what is missing, and what can be safely declared in App Store Connect.

## Code style
- Keep types small and focused.
- Avoid invasive refactors unless the current structure is blocking progress.
- Prefer `Foundation` + `OSLog`/structured status over ad-hoc prints.
- Use actors/services for mutable shared state that should not run on the main thread.
- Prefer `@MainActor` only for UI/view models that must touch SwiftUI state.
- Keep mutable state ownership explicit and avoid duplicate mutation paths for the same source of truth.
- Prefer derived state over duplicated stored state where practical.
- Keep side effects behind narrow, intentional boundaries.
- Prefer cohesive feature-local code over premature modularization.
- Add abstractions only when they improve clarity, reduce coupling, or enable testing.
- Treat performance, memory use, energy use, and UI smoothness as architectural concerns.
- Avoid unbounded caches without a clear eviction strategy.
- Avoid broad invalidation, unnecessary recomputation, large observable surfaces, and expensive work in SwiftUI render paths.
- Avoid global singletons (unless explicitly designed).
- Keep command execution wrappers deterministic and easy to retry.
- Document non-obvious invariants, ownership rules, and architectural constraints when needed; favor intent and constraints over obvious narration.

## Deliverables for each change
- Mention which files were modified and why.
- Provide a short commit message suggestion.
- Mention any user-visible behavior changes explicitly.
- Mention accessibility impact for user-facing changes: what was improved, verified, still missing, or not applicable.

## What not to do
- Don't introduce new dependencies.
- Don't "fix" code by disabling concurrency checks.
- Don't add `@MainActor` broadly to silence warnings.
- Don't change public behavior without stating it.
- Don't hide failures; surface actionable status and retry paths.
- Don't replace plain-language setup guidance with unnecessary jargon.
- Don't mark an accessibility feature as supported unless the implementation is actually present and appropriate.

If something is ambiguous, default to the simplest solution that preserves correctness and forward progress.