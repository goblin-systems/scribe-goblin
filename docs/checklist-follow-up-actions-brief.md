## Objective

Add follow-up checklist usability actions:

- Pressing `Space` in collection view toggles completion for the currently selected checklist item(s)
- Checklist item right-click menu gains checklist-relevant actions
- Allow converting the current collection between `checklist` and `standard`

## In scope

- Keyboard handling in collection view for checklist collections
- Context menu actions in collection view
- Backend/frontend support for updating a collection's `collection_type`

## Non-goals

- No change to the already accepted default icon behavior; `folder` remains the default for new collection creation
- No checklist behavior in clipboard view
- No broad collection edit UI beyond context actions needed here

## Accepted decisions

- `Space` toggles completion for the currently selected checklist item(s)
- If selected checklist items are mixed complete/incomplete, `Space` should make them complete unless all are already complete; if all are complete, `Space` should unmark them
- Checklist-specific context menu actions should include:
  - delete item(s) (existing delete remains fine if present)
  - duplicate checklist item(s)
  - convert current collection to `standard` or `checklist` (depending on current type)
- “Convert between checklist and standard type” applies to the active collection, exposed from the item context menu while in that collection
- `folder` remains the default icon for all new collections including checklist collections

## Implementation requirements

- Add collection-view keyboard handling for `Space` without breaking text-input interactions
- Space-toggle should operate on current selection in checklist collections only
- Add/update context menu items so checklist item right-click has duplicate and collection-type conversion actions available
- Add backend command/API to update a collection's `collection_type`
- On converting a collection to `standard`, completed state may remain persisted on entries but checklist UI must no longer render in standard collections

## Acceptance criteria

- In a checklist collection, pressing `Space` toggles the selected checklist item(s)
- Right-clicking checklist items exposes duplicate and collection-type conversion actions
- Converting current collection between `checklist` and `standard` persists and updates UI behavior accordingly
- New checklist creation still defaults to `folder`
- Relevant tests/typecheck/build/cargo tests pass

## Validation requirements

- Review collection-view key handling
- Review context menu item conditions and actions
- Review backend/frontend collection-type update path
- Run tests/typecheck/build/cargo tests
- Document manual verification still recommended

## Status snapshot

- Accepted and implemented
- In checklist collections, `Space` now toggles selected checklist item(s)
- Checklist item context menu now supports duplicate item(s) and active-collection type conversion
- Active collection can now be converted between `standard` and `checklist` with persisted `collection_type`
- New checklist creation still defaults to `folder`
- Validation completed:
  - `npx vitest run` passed
  - `node_modules/.bin/tsc --noEmit` passed
  - `npm run build` passed
  - `cargo test --manifest-path src-tauri/Cargo.toml` passed
