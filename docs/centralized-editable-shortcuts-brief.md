## Objective

Centralize shortcut definitions so runtime matching, defaults, settings storage, and UI labels all resolve from one shortcut catalog.

## In scope

- Add a Shortcuts settings modal/screen that lists all current shortcuts
- Support v1 editable bindings for:
  - `global.showOverlay` (default `Control+Alt+V`)
  - `main.focusSearch` (default `Primary+F`)
  - `main.newItem` (default `Primary+N`)
  - `main.openImport` (default `Primary+I`)
- Show all other current shortcuts in the same settings surface as fixed/reserved
- Store editable shortcut overrides in settings while keeping defaults in a central shortcut catalog
- Render shortcut labels from effective bindings rather than hardcoded markup strings

## Non-goals

- No generic command bus or broad input-system rewrite
- No change to existing domain handlers beyond adopting centralized shortcut definitions/matching
- No v1 editing for modal flows, overlay navigation/actions, transient reveal behavior, checklist controls, or system quit

## Accepted decisions

- The shortcut catalog is the single source of truth for shortcut ids, defaults, editability, scope, and display labels
- Existing domain-specific handlers stay in place; centralization covers definition lookup, effective binding resolution, matching helpers, and label rendering
- Editable overrides are persisted in settings; catalog defaults remain code-defined and are used when no override exists
- The Shortcuts settings surface must list both editable and fixed/reserved shortcuts so users can see the full keyboard model
- Fixed/reserved items listed in v1 include:
  - modal `Enter` / `Escape` flows
  - transient Alt reveal
  - main `Escape` / `Delete`
  - checklist `Space`
  - collection reorder `Shift+ArrowUp` / `Shift+ArrowDown`
  - overlay `ArrowUp` / `ArrowDown`, `Enter`, `Ctrl+Enter`, `Delete`, `Escape`
  - system quit label `Alt+F4`
- Global shortcut changes must use unregister/register rollback handling; only successfully registered global bindings are persisted
- Once implemented, runtime markup should not hardcode shortcut labels; labels should come from effective bindings supplied by the shortcut system

## Implementation requirements

- Add a central shortcut catalog that defines id, scope, default binding, editability, reserved/fixed status, and UI label metadata
- Add settings serialization/deserialization for editable overrides keyed by shortcut id
- Add effective-binding helpers that merge catalog defaults with stored overrides and expose display labels consistently to runtime UI
- Add matching helpers for renderer and main-process usage so existing handlers can consume centralized definitions without changing ownership of behavior
- Add a Shortcuts settings modal/screen that:
  - lists all current shortcuts
  - clearly separates editable versus fixed/reserved entries
  - allows editing only the four v1 bindings
  - shows effective labels for all entries
- For `global.showOverlay`, attempt unregister/register safely, restore the prior binding on failure, surface the error, and persist only successful changes
- Replace remaining hardcoded shortcut labels in app UI with catalog-backed effective labels

## Acceptance criteria

- A single shortcut catalog exists and is used for defaults, runtime matching helpers, settings editing, and UI labels
- Users can view all current shortcuts from the Shortcuts settings surface
- Users can edit only `global.showOverlay`, `main.focusSearch`, `main.newItem`, and `main.openImport` in v1
- Fixed/reserved shortcuts are visible but not editable
- Restarted app sessions retain successful editable overrides from settings
- Failed global shortcut changes do not break the previously working binding and are not persisted
- Runtime shortcut labels reflect current effective bindings instead of hardcoded strings
- Existing shortcut behaviors continue to work through their current domain handlers

## Validation requirements

- Review the catalog and settings flow to confirm defaults live centrally and overrides are only applied for editable shortcut ids
- Verify every shortcut label shown in runtime UI resolves from effective bindings rather than inline hardcoded text
- Manually validate editable flows for all four v1 bindings, including save, reload, and reset-to-default behavior if provided
- Manually validate fixed/reserved entries are listed and not editable
- Manually validate global shortcut rollback behavior by attempting an invalid or conflicting binding and confirming the previous binding still works
- Run tests/typecheck/build

## Status snapshot

- Accepted; implementation not started
- Phase 1: add shortcut catalog, effective-binding helpers, and settings persistence for editable overrides
- Phase 2: migrate existing handler entry points and runtime labels to the centralized shortcut definitions
- Phase 3: add the Shortcuts settings surface and complete editable global shortcut rollback handling
- Phase 4: validate current shortcut coverage, reserved-item visibility, and regression-test existing flows
