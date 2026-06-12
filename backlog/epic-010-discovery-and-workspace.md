# Epic 010 - Discovery and workspace

## Goal
Make every action keyboard-reachable, let users keep multiple notes in view at once, build capture habits through daily-note and template flows, and add recovery affordances so the app can be trusted with long-lived content.

## Scope
- Global, fuzzy navigation surfaces beyond the clipboard overlay.
- Multi-pane / multi-tab workspace inside the main window.
- Daily-note and template flows.
- Recovery affordances (trash, version history).

## Out of scope
- Plugin SDKs.
- Cross-device workspace sync (covered by epic-007).

## Backlog
- Command palette (Ctrl+P / Ctrl+Shift+P): fuzzy match across menu actions, settings, collection switches, and editable shortcuts. Reuses `shortcuts-controller.ts`.
- Quick switcher for notes (Ctrl+O): fuzzy match against note titles, aliases, and frontmatter — distinct from the clipboard overlay (Ctrl+Shift+V).
- Tabs in the main window: open multiple notes side by side, drag to split horizontally / vertically, close / pin tabs.
- Saved workspace layouts: store and restore which collections and tabs were open.
- Daily notes: dated note auto-created on demand, with a configurable template.
- Note templates: user-defined templates pickable at create time (manual entry and quick-add), including frontmatter scaffolds.
- Bookmarks / starred notes pane in the sidebar.
- Trash bin: deleted notes and clipboard items move to trash for N days before permanent deletion; restore action in the detail pane.
- Per-note version history: snapshot on save, browse and restore prior versions.
- Heading-anchor link support (`[[Note#Heading]]`) once epic-009 lands.

## Done when
- Every action the app exposes is reachable from a keyboard-only command palette.
- Users can keep two or more notes visible at once.
- Daily notes and templates are first-class in the create flow.
- Accidental deletion is recoverable.
