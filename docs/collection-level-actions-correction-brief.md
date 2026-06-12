## Objective

Correct the previous scope: collection duplicate/delete/convert actions belong to the collection itself, not to checklist items inside the collection.

## In scope

- Move collection-level actions to collection-level interaction surface
- Remove collection duplicate/convert actions from checklist item context menus
- Keep checklist item context menu focused on item actions only

## Non-goals

- No rollback of checklist item `Space` toggle behavior
- No rollback of checklist completion behavior
- No change to `folder` default icon behavior

## Accepted decisions

- Collection-level actions should live on the collection surface, i.e. sidebar collection items
- Checklist item context menu should not contain collection-level duplicate/convert actions
- Collection-level actions to support:
  - delete collection
  - duplicate collection
  - convert collection between `standard` and `checklist`
- Existing delete affordance may remain, but a proper collection context menu is the preferred action surface
- Duplicating a collection should duplicate the collection container; entry-copy behavior should follow the smallest robust implementation path and be made explicit in code/tests

## Implementation requirements

- Add collection-level context menu or equivalent right-click interaction on sidebar collection items
- Remove collection duplicate/convert actions from checklist item menus
- Keep item-level menus scoped to item actions
- Implement collection duplication behavior if not already present
- Reuse existing delete modal/path for collection deletion where appropriate

## Acceptance criteria

- Right-clicking a collection exposes collection actions
- Checklist item right-click no longer shows collection duplicate/convert actions
- Collection-level delete/duplicate/convert actions work from the collection surface
- Relevant tests/typecheck/build/cargo tests pass

## Validation requirements

- Review sidebar collection interaction wiring
- Review collection duplication/convert/delete paths
- Run tests/typecheck/build/cargo tests
- Document manual verification still recommended

## Status snapshot

- Accepted and implemented
- Sidebar collection items now expose collection-level actions via right-click context menu
- Collection-level actions available there:
  - duplicate collection
  - convert collection between `standard` and `checklist`
  - delete collection (where allowed)
- Checklist item context menu no longer carries collection duplicate/convert actions
- Validation completed:
  - `npx vitest run` passed
  - `node_modules/.bin/tsc --noEmit` passed
  - `npm run build` passed
  - `cargo test --manifest-path src-tauri/Cargo.toml` passed
