## Objective

Add a `Modified paste` option to the overlay item context menu. Fix the overlay context menu so it opens at the cursor instead of pinned to the bottom of the overlay window.

## In scope

- Overlay right-click menu on history items
- New `Modified paste` menu flow with these transforms:
  - `UPPER CASE`
  - `lower case`
  - `Capitalise first`
  - `Capitalise All`
  - `iNVERT cASE`
  - `kebab-case`
  - `snake_case`
  - `PascalCase`
  - `camelCase`
  - `Trim whitespace`
  - `Remove new lines`
- Preserve existing paste flow: hide overlay, then simulate paste into the active app
- Respect current attachment-only behavior: modified paste remains unavailable where normal paste is unavailable
- Fix context menu positioning so right-click opens near the cursor inside the overlay
- Make modified-paste options fully usable within the fixed-size overlay window without relying on rendering outside the native window bounds

## Non-goals

- No changes to main window menus
- No changes to search/ranking/storage
- No new backend persistence

## Accepted decisions

- Modified paste is launched from the overlay right-click menu, but interaction may use an in-menu drill-in view instead of a flyout submenu if needed for overlay usability
- Transform is applied to the plain text payload before paste
- Modified paste should paste plain text only; do not preserve original HTML formatting for transformed variants
- Existing standard paste behavior remains unchanged
- Attachment-only entries must not allow modified paste
- Menu positioning bug must be fixed as part of this change
- Do not pursue DOM/CSS overflow outside the Tauri overlay window; treat native window bounds as the clipping boundary
- Prefer an in-window menu design that stays within overlay bounds

## Open questions resolved for implementation

- `Capitalise first` means uppercase the first letter of the full payload and leave the remainder unchanged
- `Capitalise All` means title-style capitalization across words
- `Trim whitespace` means trim leading and trailing whitespace from the full payload
- `Remove new lines` means replace CR/LF sequences with spaces, then avoid obvious doubled separators where practical

## Acceptance criteria

- Right-clicking an overlay item shows a context menu near the cursor
- Menu contains `Modified paste` and all required transform actions are reachable and visible within the overlay window
- Choosing a modified paste option hides the overlay and pastes transformed text into the target app
- Standard click/enter paste still behaves as before
- Attachment-only entries still block paste and modified paste
- No obvious regression to existing overlay actions: Save as Note, Add Badge, Mark Secret, Delete

## Validation requirements

- Review changed overlay UI/menu wiring
- Review transform logic for all required variants
- Run relevant tests/typecheck if available
- If there are no suitable automated tests, document manual verification steps clearly

## Current approved work items

1. [done] Analyze current context-menu library capabilities and overlay event wiring
2. [done] Implement/fix overlay context menu positioning
3. [done] Implement modified paste transform pipeline and submenu wiring
4. [done] Verify behavior and regressions

## Status snapshot

- Accepted and implemented
- Overlay now loads design-system menu styles and opens the context menu at cursor coordinates
- `Modified paste` now drills into an in-place second-level menu with Back, keeping all transform actions inside the overlay window
- Modified-paste interactions no longer rely on submenu overflow outside the overlay bounds
- Validation completed: transform tests passed, typecheck passed, build passed
