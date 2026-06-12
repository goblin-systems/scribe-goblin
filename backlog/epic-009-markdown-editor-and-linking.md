# Epic 009 - Markdown editor and linking

## Goal
Turn Notes into a structured authoring surface: rich markdown rendering, bidirectional linking between notes, and lightweight typed metadata so a growing corpus stays navigable.

## Scope
- Markdown-aware editing for Notes (not for Clipboard items).
- Bidirectional linking between notes (`[[wiki links]]`) with backlink discovery.
- Lightweight structural metadata (frontmatter / properties, aliases) that integrates with existing search.
- Read-side rendering of tables, fenced code blocks, math, and inline images / PDFs from existing attachments.

## Out of scope
- Plugin SDKs or third-party extension surfaces.
- Mobile clients.
- Canvas / infinite-whiteboard surfaces.
- Full-fidelity WYSIWYG block editing — start with split source / preview.

## Backlog
- Markdown editor for the note detail pane: source mode and rendered preview, toggleable, honoring existing Goblin theming.
- Wiki-link parser: `[[Note Title]]` and `[[Note Title|alias]]` resolved against the Notes corpus, with autocomplete on `[[`.
- Backlinks pane in the note detail showing all notes that link to the current note, plus unlinked-mention candidates derived from FTS.
- Outgoing-links pane in the note detail (counterpart to backlinks).
- Note aliases: an entry-level list of alternate titles that wiki-links can resolve to.
- Frontmatter / properties: typed key-value metadata at the top of a note (string, number, date, list), exposed as filterable facets in search.
- Render fenced code blocks with syntax highlighting, tables, and KaTeX-style math.
- Inline image / PDF preview in note rendering, using the existing attachments storage.
- Heading outline / TOC pane derived from the rendered note.
- Word count and reading-time indicator in the note status bar.
- Migration: existing plain-text notes render as-is; opt-in markdown rendering per note or globally.

## Done when
- A non-trivial markdown note can be authored and read in the app without losing fidelity.
- `[[wiki links]]` resolve, autocomplete, and surface in a backlinks pane.
- Frontmatter values are searchable as filters.
- Rendered notes show tables, code, math, and inline media correctly.
