## Objective

Implement Epic 003 slice 1 by persisting AI enrichment results on entries and invoking enrichment from the existing shared background processor so new and updated entries can be enriched best-effort without affecting capture responsiveness.

## In Scope

- Add persisted entry fields for `summary` and `enrichment_tags`.
- Add additive DB schema support and migration for those fields on `entries`.
- Expose persisted fields through existing entry DTOs/selects.
- Add a backend command to update enrichment fields for a single entry.
- Wire `enrichEntry()` into `processNoteBackground(id, content)`.
- Respect current enrichment settings and only run when enabled/configured.
- Treat enrichment as best-effort: failures are logged and do not block other background work.

## Out of Scope

- Queue management, job status, progress, retries, or failure UI.
- Backfill for existing entries.
- Chunking or long-content segmentation.
- Search/index ingestion or ranking based on `summary` / `enrichment_tags`.
- Presenter, detail-pane, list, overlay, or other UI rendering changes.
- New orchestration beyond `processNoteBackground()`.

## Files/Areas Expected

- `src/main/collection-controller.ts`
- `src-tauri/src/db.rs`
- `src-tauri/src/lib.rs`
- `src/store.ts`
- `src-tauri/src/import.rs`
- `tests/database.test.ts`

## Constraints

- Keep blast radius minimal and avoid unrelated refactors.
- Reuse the existing shared background path.
- SQLite remains the canonical store.
- Best-effort behavior is mandatory: enrichment failure must not fail capture or classification/secret processing.
- Do not add UI/search behavior in this slice.

## Acceptance Criteria

1. `entries` schema supports nullable `summary` and nullable `enrichment_tags`.
2. Existing databases are migrated safely with additive migration behavior.
3. Entry reads include the new fields without breaking current consumers.
4. A single backend command persists enrichment results for an entry by `id`.
5. `processNoteBackground()` invokes enrichment only when enabled/configured.
6. On success, summary and tags are stored consistently.
7. On failure, the error is logged and other background processing still completes.
8. No presenter, list, detail, overlay, or search behavior changes are introduced.
9. Tests cover persistence and round-trip behavior for the enrichment fields.

## Validation

- DB-level test proving enrichment fields persist and round-trip via entry reads.
- Relevant automated tests pass.
- Manual sanity check optional if automated coverage is sufficient for this slice.

## Current Risks/Dependencies

- `enrichEntry()` invocation conditions must avoid noisy failures when provider config is incomplete.
- `db.rs` and `collection-controller.ts` already carry unrelated collection/vector work; keep changes tightly scoped.
- Use a consistent low-risk storage format for `enrichment_tags` (JSON string array).

## Next Follow-up Items

- Decide how summaries/tags should be surfaced in UI.
- Plan backfill for older entries.
- Decide future queue/retry/observability model.
- Decide whether chunking is required before enrichment for long imports.
