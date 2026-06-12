## Objective

Improve overlay keyboard usability for modified paste.

## In scope

- In overlay, `Ctrl+Enter` should open the context menu directly in the `Modified paste` view for the currently selected item
- Once the menu is active/open, keyboard navigation should control the menu instead of the clipboard history list

## Non-goals

- No redesign of the modified paste transforms themselves
- No backend paste changes
- No design-system package changes unless absolutely required

## Accepted decisions

- Reuse the existing overlay drill-in menu (`contextMenuView = "modified-paste"`) instead of adding a separate keyboard-only UI
- Rely on existing design-system menu keyboard support for navigating/focusing menu items
- When the menu is open, overlay-level keyboard shortcuts should not also run
- `Ctrl+Enter` is repurposed from strip-format paste to opening `Modified paste`
- Plain `Enter` remains normal paste

## Implementation requirements

- Add a helper to detect whether the context menu is currently open
- Add a helper to open the menu for the currently selected entry directly into `modified-paste`
- Anchor keyboard-opened menu to the selected row in a sensible way
- In overlay key handling:
  - preserve current Alt reveal handling
  - `Ctrl+Enter` opens `Modified paste` for current selection when menu is not already open
  - when menu is open, overlay history navigation/paste/delete/close shortcuts must not run

## Acceptance criteria

- `Ctrl+Enter` opens modified paste menu for the selected overlay item
- After opening the menu, Up/Down navigates menu options rather than moving clipboard history selection
- Enter activates the focused menu item rather than triggering normal paste
- Escape closes/backs out of the menu rather than immediately moving the history selection or triggering unrelated overlay actions
- Plain `Enter` without menu open still performs normal paste
- Existing mouse-based modified paste flow still works

## Validation requirements

- Review overlay key handling and menu-open detection
- Run tests/typecheck/build
- Document manual verification steps for keyboard flow

## Status snapshot

- Accepted and implemented
- `Ctrl+Enter` now opens the currently selected entry directly into the `Modified paste` menu view
- While the context menu is open, overlay-level history navigation and action shortcuts are suppressed so menu keyboard navigation owns the arrow/enter/escape flow
- Plain `Enter` still performs normal paste when the menu is closed
- Validation completed:
  - `npx vitest run` passed
  - `node_modules/.bin/tsc --noEmit` passed
  - `npm run build` passed
