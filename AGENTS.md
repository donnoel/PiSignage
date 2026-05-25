This repo is an Apple-platform app codebase. You are an engineering agent collaborating with the human. Make small, correct, testable changes with a clean build at every step.

## Hard requirements

- **No build warnings.** Treat warnings as errors.
- **No large rewrites.** Prefer small, surgical diffs.
- **Apple-native only.** No third-party libraries unless explicitly requested.
- **SwiftUI + MVVM.** Keep UI declarative; isolate logic in view models and services.
- **Concurrency correctness.** Do not silence warnings with broad `@MainActor`. Use actors/services for non-UI mutable state.
- **Safe persistence.** Use atomic writes where appropriate.
- **Privacy-first.** No unexpected network calls or data collection.
- **Preserve behavior.** Do not regress user-visible flows without calling it out.
- **Accessibility matters.** Treat accessibility as part of the feature, not polish.

## Workflow

1. Read only the files needed for the task.
2. Read `AGENTS.project.md` only when the change touches app-specific behavior, architecture, persistence, release behavior, or known project constraints.
3. Make a brief plan only when the task is non-trivial.
4. Implement the smallest viable patch.
5. Run the narrowest useful validation.
6. Report what changed, files touched, validation performed, and anything skipped.

## Code guidance

- Keep types small and focused.
- Avoid invasive refactors unless the current structure blocks the requested change.
- Prefer `OSLog` or structured status over ad-hoc prints.
- Keep mutable state ownership explicit.
- Prefer derived state over duplicated stored state where practical.
- Keep side effects behind narrow boundaries.
- Add abstractions only when they improve clarity, reduce coupling, or enable testing.
- Treat performance, memory use, energy use, and UI smoothness as architectural concerns.
- Avoid unbounded caches without a clear eviction strategy.
- Avoid expensive work in SwiftUI render paths.

## Accessibility baseline

For user-facing UI changes, check the relevant basics:

- clear labels, values, hints, traits, and reading order
- semantic SwiftUI / Apple-native controls
- Dynamic Type or scalable text where appropriate
- contrast and legibility in light/dark mode
- hit target size and interaction affordance
- Reduce Motion / Reduce Transparency where motion, blur, or translucency are used
- clear state communication for selections, progress, timers, alerts, and errors
- focus, keyboard, or tvOS behavior where relevant

Do not claim accessibility support exists unless there is concrete code evidence. Report what was improved, verified, missing, or not applicable.

## Quota Discipline / Quota-Smart Codex Mode

Use the smallest amount of work necessary to complete the task correctly.

### Before editing

- Do not scan the whole repository unless the task truly requires it.
- Do not run broad audits unless explicitly asked.
- Prefer targeted searches by filename, symbol name, failing test output, or known feature area.
- Ask for clarification only if the request is unsafe or ambiguous enough to risk breaking behavior.
- If the likely fix is unclear, investigate first and do not edit until the smallest safe change is identified.

### While editing

- Make the smallest safe diff.
- Do not rewrite working code for style.
- Do not touch unrelated files.
- Do not expand scope beyond the requested task.
- Stop after the requested change is complete.

### Validation

Use the narrowest useful validation first:

1. Syntax or build check for the touched target.
2. Targeted unit test if logic changed.
3. Targeted UI test if navigation or user flow changed.
4. Full test suite only for shared architecture, persistence, app startup, CI, release behavior, or broad refactors.

No app build is required for documentation-only changes unless requested.

## Do not

- Do not introduce dependencies without approval.
- Do not disable concurrency checks to fix warnings.
- Do not add broad `@MainActor` to silence warnings.
- Do not change public behavior without stating it.
- Do not hide failures.
- Do not replace plain-language setup guidance with jargon.
- Do not produce long explanations, broad recommendations, or extra cleanup unless requested.

If something is ambiguous, default to the simplest solution that preserves correctness and forward progress.
