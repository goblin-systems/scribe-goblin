## Objective

Stabilize three related behaviors:

1. Overlay context menu must fully dismiss when the overlay closes or loses focus.
2. Pasting must be more robust, especially for masked/secret entries and rich text paste.
3. The `Ctrl+Alt+V` global shortcut must survive renderer reload/edit cycles more reliably in dev.

## In scope

- Overlay close/reset lifecycle in `src/overlay.ts`
- Paste robustness across overlay paste paths and backend paste simulation
- Global shortcut lifecycle in `src/main.ts`

## Non-goals

- No redesign of the overlay interaction model beyond cleanup/reset needed for stability
- No search/storage/classification changes
- No large architecture migration unless absolutely necessary

## Accepted facts / decisions

- Overlay menu stale-visibility is most likely caused by not resetting/destroying menu state on overlay close paths.
- Masked/secret paste brittleness is likely strongly affected by the user still holding `Alt` while paste is injected; the backend should not depend on physical modifier state being ideal.
- Windows rich paste handling is likely brittle because HTML clipboard payloads are written as raw bytes without proper `CF_HTML` normalization.
- Global shortcut flakiness after reload is likely due to registration ownership living in renderer init without unregister/re-register lifecycle handling.
- Preferred fixes are the smallest robust ones:
  - central overlay close/reset helper
  - harden backend paste injection and HTML clipboard writing
  - idempotent shortcut registration with cleanup on unload/HMR

## Implementation requirements

### Overlay dismissal

- Create a single overlay close/reset path
- Ensure it clears/destroys context menu state
- Ensure it resets transient overlay UI state that should not persist across sessions
- Use this close/reset path consistently from Escape, focus loss, and paste-triggered hide flows

### Paste robustness

- Preserve existing paste UX and modified-paste behavior
- Keep modified paste plain-text only
- Preserve secret masking rules in UI surfaces; do not paste masked bullets instead of actual content
- Harden Windows paste so injected paste is not corrupted by currently held modifiers like `Alt`
- Improve HTML clipboard payload correctness where practical without changing frontend paste contract

### Shortcut durability

- Keep `Ctrl+Alt+V` as the shortcut
- Make registration idempotent
- Clean up and re-register safely during dev reload/edit cycles
- Do not require full app restart after normal renderer reloads in development

## Acceptance criteria

- Closing or blurring the overlay does not leave a stale context menu visible next time
- Masked/secret entries paste actual underlying content reliably
- Standard and modified paste are more reliable than before across target apps
- Rich paste remains supported where available
- `Ctrl+Alt+V` remains functional after ordinary dev edit/reload cycles without needing full app restart
- Relevant tests/typecheck/build pass

## Validation requirements

- Review overlay close/reset paths
- Review shortcut registration lifecycle handling
- Review backend paste injection changes
- Run tests, typecheck, and build
- Document any manual verification still recommended

## Status snapshot

- Accepted and implemented
- Overlay close paths now reset transient UI state and destroy the context menu handle before hiding
- Global shortcut registration is now unregister/re-register based with unload/HMR cleanup
- Windows paste path now writes Unicode text plus normalized CF_HTML and releases interfering modifiers before injected paste
- Validation completed:
  - `npx vitest run` passed
  - `npm run build` passed
  - `cargo test --manifest-path src-tauri/Cargo.toml` passed
