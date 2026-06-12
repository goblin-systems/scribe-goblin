# Epic 004 - Deduplication and knowledge graph

## Goal
Reduce noise and reveal relationships across saved material.

## Scope
- Detect exact and near-duplicate entries.
- Collapse duplicate captures without losing history.
- Infer relationships from embeddings and metadata.
- Expose clusters and related groups over time.

## Status

### Done
- Related-item surfacing (per-entry, embedding-driven) ships from epic-002 and is reused for any future cluster UI.

### Open
- Exact-duplicate detection for repeated clipboard captures (content hash, attachment sha256 already exists and can be reused).
- Near-duplicate detection using embedding similarity above a tunable threshold.
- Storage representation for duplicate groups (canonical entry + duplicate-of pointer; or shared group id) and migration plan.
- UI representation: collapsed duplicate stacks in lists and overlay; expand-on-click; preserve history without flooding.
- Persistent inferred-link table (entry_id ↔ entry_id with score and reason) so links survive embedding re-runs.
- Cluster generation for related fragments and evolving topics; decide between online (incremental) vs batch clustering.
- Detail-panel affordance for browsing duplicate and related groups distinct from per-entry "related items".

## Done when
- Repeated captures no longer flood the history.
- Related fragments can be traversed from any entry.
- The app can show meaningful clusters without manual linking.
