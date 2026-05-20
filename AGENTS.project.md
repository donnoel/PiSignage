# AGENTS.project.md

# PiSignage Project Guide for Agents

## Product intent
Describe what this app is for in plain language.
Suggested structure:
- Who the app serves
- The main problem it solves
- The success criteria

## Current product phase (scaffold)
This file is expected to evolve over time.
Update this section as soon as implementation starts.

Starter checklist:
1) Define MVP scope
2) Define architecture boundaries
3) Define reliability and UX goals
4) Define testing priorities
5) Define accessibility expectations for the product early, not at submission time

## Architecture snapshot (current)
Capture the current technical shape as it becomes real:
- app entry and navigation model
- core view models/services
- data flow and persistence
- major custom UI components that may need explicit accessibility work

## Concurrency rules (important)
Keep rules explicit for this project as they become known.
- keep UI state on the main actor
- keep IO/network work off the main actor
- avoid broad isolation as a shortcut

## Accessibility requirements (important)
Accessibility must be designed into the project from the beginning and updated as the codebase evolves.

For this project, agents should scan the codebase for the accessibility support that should exist based on the actual UI and interaction model, not from a generic checklist alone.

At a minimum, evaluate and document where relevant:
- VoiceOver labels, values, hints, traits, grouping, and reading order
- Dynamic Type / text scaling behavior
- Contrast, legibility, and support for light/dark appearance
- Reduce Motion / Reduce Transparency handling
- Hit targets and gesture accessibility
- Keyboard navigation and focus behavior for macOS/tvOS
- State announcements for progress, selection, toggles, timers, errors, and transient UI
- Support for custom controls, charts, images, media, and any non-standard interaction pattern

Project rules:
- New user-facing code should include accessibility support as it is built.
- Accessibility regressions should be treated as real product bugs.
- Do not claim an accessibility feature is supported unless there is concrete implementation evidence.
- When requested, provide an accessibility audit that clearly separates:
  1) features scanned for
  2) features identified in code
  3) gaps or incorrect implementations
  4) features that appear safe to declare in App Store Connect
- If a feature is not applicable to the current codebase, say so explicitly instead of forcing a false positive.

## Behavior invariants (do not regress)
List critical product contracts once identified.
Examples:
- setup flows
- creation/sync pipelines
- data safety guarantees
- accessibility behavior for critical user flows once established

## UX rules
Document UX guarantees (copy tone, interactions, failure handling, keyboard flows).

Accessibility-specific UX expectations should also be captured here once known:
- whether motion must be reduced in key screens
- whether text must scale without truncating essential meaning
- whether custom visuals require alternate spoken summaries

## Coding conventions
Project-specific style or patterns that go beyond AGENTS.md.
Prefer Apple-native accessibility APIs and semantic SwiftUI modifiers over custom workarounds.

## Build/run notes
- target platforms
- warning policy
- local run/test setup notes
- note any accessibility test steps, VoiceOver checks, or platform-specific validation flows once defined

## Near-term priorities
Keep this list short and current.
Include accessibility gaps here when they are known and still unresolved.

## Output expectations per patch
Provide:
- Summary of change
- Files modified
- Any migration considerations
- Commit message suggestion
- Accessibility notes for user-facing work: added, verified, missing, or not applicable