## Objective

Deliver two related improvements:

1. Improve the create-collection icon picker UX:
   - better search/filtering so partial fuzzy-style queries like `repl` can find `replace`, `reply`, etc.
   - show the actual icon next to each option
   - keep `folder` as the default icon
2. Add checklist collections:
   - create-collection modal can choose collection type `standard` or `checklist`
   - seeded `todo` and `shopping-list` collections are checklist collections
   - checklist collections render each item with a checkbox
   - completed items move to the bottom
   - completed item text is struck through

## In scope

- Create-collection modal UI and persistence
- Collection DTO/database changes
- Entry DTO/database changes needed for checklist completion state
- Checklist behavior in collection view item list
- Default collection seeding/backfill for collection type

## Non-goals

- No collection edit UI unless required for safe implementation
- No checklist behavior in clipboard view
- No broad redesign of shared presenters unless required
- No badge-based encoding of checklist completion

## Accepted decisions

- Keep `folder` as the default icon
- Replace the native icon `<select>` with local custom option UI so icons can render beside labels
- Use a lightweight local fuzzy-ish matcher; no new dependency required
- Do not overload existing `CollectionRow.kind` because it currently means system/user ownership
- Add a separate persisted `collection_type` field with values:
  - `standard`
  - `checklist`
- Default seeded collection types:
  - `notes` => `standard`
  - `todo` => `checklist`
  - `shopping-list` => `checklist`
- Add a separate persisted per-entry field for checklist completion:
  - `checklist_completed`
- Checklist completion must not be stored in badges or any user-visible tag-like metadata
- Checklist UI scope is the active collection view only for this feature
- Sorting rule for checklist collections: incomplete items first, completed items last, preserving existing relative order within each group
- Checkbox click toggles completion without triggering row open/selection side effects beyond what is necessary

## Interface contracts to freeze

### Collection DTO / DB

- Add `collection_type` to collections
- TS/Rust values: `standard | checklist`

### Entry DTO / DB

- Add `checklist_completed`
- TS boolean / Rust bool / SQLite integer default false

### Commands / frontend APIs

- Extend create collection flow to accept:
  - `name`
  - `icon`
  - `collectionType`
- Add backend command to toggle/set entry checklist completion

## Implementation requirements

### Icon picker

- Icon search should be materially better than strict substring-only token matching
- Matching should support partial/fuzzy-ish lookup such that `repl` can match names like `replace`
- Each option must display icon glyph + icon name
- Keep selected-icon preview

### Checklist collections

- Create-collection modal includes collection type selection
- New checklist collections persist as `collection_type = checklist`
- Collection list rendering detects checklist collections and shows checkbox controls on each item row
- Toggling completion persists state and re-renders list
- Completed items render with struck-through text and sort to the bottom
- Existing non-checklist collections keep current behavior

## Acceptance criteria

- Icon picker search can find likely intended icons for short partial queries like `repl`
- Icon list shows actual glyphs next to icon names
- `folder` is the default selected icon in create collection modal
- Create collection modal supports choosing `standard` vs `checklist`
- `todo` and `shopping-list` load as checklist collections
- Checklist collection items show checkboxes, completed state persists, completed items sort to bottom, and completed text is struck through
- Existing collections/items continue to function without regression
- Relevant tests/typecheck/build/cargo tests pass

## Validation requirements

- Review collection and entry schema/API changes
- Review create-collection modal wiring and picker UX
- Review checklist item rendering/toggle behavior in collection view
- Run frontend tests/typecheck/build and cargo tests
- Document manual verification still recommended

## Status snapshot

- Accepted and implemented
- Create-collection modal now has:
  - improved local fuzzy-ish icon filtering
  - icon glyphs beside icon labels
  - `folder` as the default icon
  - collection type selection (`standard` / `checklist`)
- Collections now persist `collection_type`
- Entries now persist `checklist_completed`
- Seeded `todo` and `shopping-list` collections now backfill/load as checklist collections
- Active checklist collection view now shows checkboxes, persists completion, moves completed items to the bottom, and strikes through completed text
- Validation completed:
  - `npx vitest run` passed
  - `node ./node_modules/typescript/bin/tsc --noEmit` passed
  - `npm run build` passed
  - `cargo test --manifest-path src-tauri/Cargo.toml` passed
