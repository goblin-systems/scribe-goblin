## Objective

When creating a new collection, allow choosing an icon from the packaged Goblin design system icon set, with search.

## In scope

- Extend create-collection modal to include icon selection
- Use packaged Goblin/design-system icon library as the source of icons
- Allow searching/filtering icons during selection
- Persist chosen icon on the collection
- Make all existing collection icon render paths respect the persisted icon while preserving fallback behavior

## Non-goals

- No collection edit/rename UI unless required for safe implementation
- No upstream design-system package changes unless absolutely necessary
- No unrelated collection UX refactors

## Accepted decisions

- The design system does not currently expose a reusable icon-picker component
- The design system does expose the packaged icon set and primitives sufficient to build a local picker
- Store collection icons as kebab-case Lucide icon names (for existing `data-lucide` rendering compatibility)
- Add a nullable `icon` field to collections and keep existing slug-based fallback logic for collections without an explicit icon
- Preferred implementation is a lightweight local searchable picker built in this app on top of the packaged icon set

## Implementation requirements

- Extend collection persistence and TS/Rust DTOs with nullable `icon`
- Update create collection command/path to accept an icon value
- Update collection icon resolution helper to prefer persisted icon over slug fallback
- Extend create-collection modal UI to support:
  - selected icon preview
  - search input
  - keyboard/mouse selectable icon list/grid/select
- Use the packaged design-system icon library as the source of icon names
- Search should be local/client-side

## UX direction

- Smallest robust solution is acceptable; a local searchable select is fine
- If practical, show a visible icon preview so the current choice is obvious
- Default selection may remain the current fallback icon (`folder`) for new user collections unless implementation finds a better low-friction default

## Acceptance criteria

- Creating a collection allows choosing an icon with search
- Selected icon persists and is shown anywhere collection icons are rendered
- Existing collections without explicit icons still render correctly via fallback logic
- Notes/system collection behavior is not regressed
- Relevant tests/typecheck/build pass

## Validation requirements

- Review collection DB/API model changes
- Review create-collection modal wiring
- Review collection icon rendering call sites
- Run tests/typecheck/build
- Document any manual verification still recommended

## Status snapshot

- Accepted and implemented
- Create-collection modal now includes a local searchable icon picker backed by the packaged design-system icon set
- Collection icons are persisted via nullable `collections.icon`
- Existing icon rendering now prefers persisted icons and falls back to prior slug-based defaults
- Validation completed:
  - `npx vitest run` passed
  - `npm run build` passed
  - `cargo test --manifest-path src-tauri/Cargo.toml` passed
