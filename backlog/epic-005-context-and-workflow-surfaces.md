# Epic 005 - Context and workflow surfaces

## Goal
Expose captured knowledge through the main app, quick workflows, and contextual recall.

## Scope
- Main app browsing for notes and clipboard history.
- Quick entry and paste overlay workflows.
- Context surfacing based on what the user is doing.
- Future timeline and graph-oriented browsing views.

## Status

### Done
- Main IA split between Clipboard and user-defined Collections (Standard / Checklist), with icon picker, rename, duplicate, delete-with-move-destination, and reorderable entries.
- Overlay paster supports search, selection, paste, modified-paste (Ctrl/Shift transforms), Alt-to-reveal secrets, and overlay theming.
- Related entries surface in Notes and Clipboard detail panes.
- Status bar shows app/notes/clipboard summary across views.
- Centralized editable shortcuts controller (`src/main/shortcuts-controller.ts`) so future hotkey edits go through one path.

### Open
- Refine main-app information architecture for notes vs clipboard vs collections (sidebar grouping, header affordances, empty states).
- Improve the overlay for faster filtering (filter by source, by collection, by badge) and richer previews.
- Timeline browsing view across captures (day / week / month grouping with scrubbing).
- Graph or cluster view for topic discovery (depends on epic-004 link / cluster output).
- Contextual recall: surface related entries based on current clipboard contents or active foreground window.
- Stronger status feedback for background processing and indexing (queue depth, last-run, failures).

## Done when
- The main app and overlay support fast capture recall workflows.
- Users can browse by search, time, and relationship.
- Contextual suggestions surface useful prior material while working.
