## Objective

Improve entry auto-tagging quality and add a debug-only item-detail diagnostics section that shows what processing ran, with what tool/model, including TruffleHog status.

## Problem Statement

- Current local auto-tagging is mostly a coarse single-label classifier, not rich semantic tagging.
- Many entries fall back to `other`, which effectively means no visible auto tag.
- Enrichment tags exist but are optional, weakly normalized, and not surfaced in detail views.
- Secret detection stores only the final verdict/type/source, so TruffleHog status and flakiness are hard to inspect per entry.

## In Scope

### 1. Processing diagnostics in item details
- Add a debug-only shared "Processing diagnostics" section in item detail panes.
- Show, per entry:
  - classification/tagging tool + model
  - selected label + score
  - top classifier candidates if available
  - enrichment provider/model/status and returned tags/summary status
  - secret detection final verdict/type/source
  - TruffleHog availability/match/verified status
  - secret-masker status
- Metadata only; never expose raw secret text/spans.

### 2. Persist per-entry diagnostics
- Add a nullable `processing_diagnostics` JSON field on entries.
- Persist a versioned diagnostics snapshot from `processNoteBackground()`.

### 3. Improve tagging quality in the current architecture
- Keep the current single auto-label contract, but improve selection quality by:
  - making classifier hypotheses neutral to notes/imports (not clipboard-specific)
  - reducing over-aggressive fallback to `other`
  - exposing top candidate scores for debugging
  - adding low-risk heuristics for obvious URL / command / code / structured-data cases
- Improve enrichment tag quality by:
  - strengthening the enrichment prompt
  - normalizing/deduping/suppressing generic tags before persistence
  - adding a local heuristic fallback tagger when enrichment is unavailable, so local-only setups get better tags

## Out of Scope

- Search/index changes to use `enrichment_tags`
- Multi-label classifier redesign or taxonomy overhaul
- Queue/history tables for processing runs
- Reprocessing/backfill of older entries
- UI changes outside debug detail panes
- Search ranking changes
- Raw secret evidence persistence or display

## Accepted Architecture Decisions

- Add one new nullable field on `entries`: `processing_diagnostics TEXT`.
- Store diagnostics as a versioned JSON blob.
- Keep `label`, `label_score`, `summary`, and `enrichment_tags` as the primary user-facing persisted outputs.
- Treat heuristic tags as additive/fallback quality improvements, not a replacement for manual badges.
- Keep Notes and Clipboard separation unchanged.

## Expected Data Contract

`processing_diagnostics` should contain versioned metadata for:
- classification
  - tool
  - model(s)
  - selected label/score
  - fallback-to-other info
  - top candidates
- enrichment
  - status
  - provider/model
  - summary present
  - tags returned
  - error/skipped reason
- secret_detection
  - final verdict/type/source
  - TruffleHog available/matched/verified/detector
  - secret-masker enabled/matched/model/top-score/span-count

Do not store raw secret text.

## Expected File Areas

- `src-tauri/src/db.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/classifier.rs`
- `src/main/collection-controller.ts`
- `src/main/entry-presenters.ts`
- `src/main/clipboard-controller.ts`
- `src/store.ts`
- `src/secret-detection/index.ts`
- `src/secret-detection/trufflehog.ts`
- `src/secret-detection/types.ts`
- `src/enrichment.ts`
- `tests/database.test.ts`
- `tests/entry-presenters.test.ts`
- `tests/secret-detection.test.ts`
- relevant Rust tests in `classifier.rs`

## Acceptance Criteria

1. Item details show a debug-only processing diagnostics section for both Notes and Clipboard entries.
2. The diagnostics section clearly shows tagging/classification tool and model, enrichment tool/model/status, and TruffleHog detection status.
3. `processing_diagnostics` persists enough metadata to explain why an entry was or was not tagged.
4. Local-only flows produce better tagging coverage than before on representative fixtures.
5. Classifier fallback to `other` is less aggressive on clearly classifiable examples without regressing obvious secret/content-type cases.
6. Enrichment tags are normalized, deduped, and stripped of generic junk tags.
7. No raw secret values are persisted or rendered in diagnostics.
8. Existing secret masking behavior remains intact.

## Validation

- Rust unit/regression tests for classifier selection and heuristic overrides.
- TS tests for diagnostics persistence and best-effort background processing.
- TS presenter tests for diagnostics rendering.
- Secret detection tests covering TruffleHog status states.
- Manual smoke check on both Notes and Clipboard detail panes.

## Risks / Tradeoffs

- Shared presenter changes have multi-surface blast radius; keep rendering isolated and masking-safe.
- Heuristics can overfit; keep them conservative and covered by representative tests.
- Diagnostics JSON is less queryable than normalized tables, but is the smallest practical step now.

## Definition of Done

- Diagnostics are persisted and visible in debug detail panes.
- Tagging quality is measurably improved on representative tests/fixtures.
- Relevant tests pass.
- No unrelated UI/search scope is introduced.
