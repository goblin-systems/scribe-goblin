# AGENTS.md

## Auto

- Search Tauri DTOs currently use mixed casing across request and response boundaries. Requests from TS are sent in snake_case (`is_note`, `source_app`, `date_from`, `date_to`), while Rust search response DTOs are serialized in camelCase. Frontend must normalize search payloads at the boundary; see `src/store.ts` helpers.
- Notes and Clipboard are intentionally separate datasets. Notes = `is_note: true`, Clipboard = `is_note: false`. Regressions here are easy when touching search/filter plumbing.
- Search debug UI is intentionally debug-only and depends on normalized search payloads. If debug output shows `unknown` / `—` unexpectedly, check casing mismatches before debugging ranking logic.
- Secret masking must stay consistent across all surfaces: main lists, detail panes, related items, and overlay. Use shared helpers in `src/main/entry-presenters.ts` and reveal state from `src/main/secret-reveal-controller.ts`.
- Main-window transient secret reveal uses actual Alt modifier state, not a manual toggle. Preserve `event.altKey` / `getModifierState("Alt")` style handling to avoid every-second-press bugs.
- Persistent secret reveal (eye button) in main detail panes is separate from transient Alt reveal and should remain additive, not replace Alt behavior.
- Related-item previews must respect secret masking and current reveal state; do not use plain `buildEntryPreview()` directly for surfaces that can show secrets.
- Epic 001 is complete. Capture sources are `clipboard`, `manual`, `import`. Import supports pasted text, file picker, and drag/drop. Local storage bootstraps `db/`, `attachments/`, `vectors/`, and `config/`.
- Epic 002 is complete. Search architecture is SQLite source of truth plus rebuildable derived search structures (`entries_fts`, `entry_tags`) and backend-owned semantic/hybrid retrieval. Do not reintroduce renderer-side corpus embedding scans.
- Keep SQLite as canonical store. Treat search/index layers as derived and rebuildable. Future vector/index changes should happen behind the backend search API, not by changing frontend assumptions.
- Vite build chunking was intentionally configured to remove large chunk warnings. Prefer real chunking over threshold increases.
- `src/main/entry-presenters.ts` now contains critical shared presentation logic for previews, debug search diagnostics, related-item rendering, and secret masking behavior. Changes there can affect multiple surfaces at once.
- Collection rename must use the Goblin modal flow in `src/main.ts`, not `window.prompt`.
