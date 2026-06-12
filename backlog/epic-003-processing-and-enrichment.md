# Epic 003 - Processing and enrichment

## Goal
Process captured content in the background so entries become structured, searchable, and useful without manual effort.

## Scope
- Chunk long content into meaningful segments.
- Generate embeddings for new and existing entries.
- Enrich entries with summaries, keywords, and suggested tags.
- Run processing asynchronously so capture stays fast.

## Status

### Done
- Embeddings generation wired through provider abstraction (OpenAI / Gemini / Ollama / local MiniLM).
- `reembed_all_entries` command performs full-corpus re-embedding from settings.
- Enrichment provider plumbing exists for OpenAI and Gemini in `src/enrichment.ts` with strict JSON contract for `summary` + `tags`.
- Local SetFit classifier provides on-device label + score on every captured entry (`label`, `label_score`).
- Enrichment toggle persisted in settings.

### Open
- `enrichEntry()` is not yet called from any capture or background path — it needs to be wired into a job pipeline.
- No persisted `summary` / `enrichment_tags` columns on the `entries` table; today only manual badges and the classifier label are stored. Decide schema and migration.
- Paragraph-aware chunking for long imported / pasted content is not implemented; embeddings currently run on the whole entry text.
- No queue, retry, or status tracking for embedding and enrichment jobs.
- No first-run backfill flow for older entries (only manual "Regenerate All Embeddings").
- Surfacing of summaries and tags in the detail panes and search results once persisted.

## Done when
- New entries are processed automatically in the background.
- Summaries and tags are stored and visible in the UI.
- Long-form content is chunked before retrieval and enrichment.
- Job status (queued / running / failed) is observable from the UI.
