# Epic 002 - Search and retrieval

Status: **Done** (closed; moved from active backlog).

## Goal
Make captured knowledge easy to find through fast keyword and semantic retrieval.

## Scope
- Full-text search across stored entries.
- Semantic search over embeddings.
- Filters for source, date, tag, and source application.
- Related-item surfacing alongside search results.

## Outcome
- Backend keyword search foundation added with `search_entries` and `rebuild_search_indexes`.
- Rebuildable `entries_fts` and exact-match `entry_tags` derived structures maintained from SQLite `entries`.
- Notes and Clipboard keyword search use the backend search API with scope/source/date/tag/source app filters.
- Semantic retrieval moved to the backend; renderer no longer loads all embeddings to score client-side.
- Hybrid ranking blends keyword, semantic, and recency signals via Reciprocal Rank Fusion in backend search results.
- Related items are surfaced in Notes and Clipboard detail views.
- Search debug mode exposes ranking, FTS, semantic, and embedding diagnostics.
- Secret masking applies consistently in search results, detail panes, related items, and Alt-to-reveal flows.

## Done when
- Users can find entries by exact words or by meaning.
- Search remains responsive as the dataset grows.
- Filters and related results help narrow and expand context without manual tagging.

## Follow-ups (handed off to other epics)
- Per-query-length ranking-bucket tuning lives under epic-006.
- Graph and timeline browsing are tracked under epic-005.
