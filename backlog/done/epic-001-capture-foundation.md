# Epic 001 - Capture foundation

Status: **Done** (closed; moved from active backlog).

## Goal
Build the local-first capture layer for clipboard, manual entry, and imported content.

## Scope
- Capture clipboard entries automatically in the background.
- Support quick manual entry from the main app and overlay workflows.
- Support importing pasted long-form content and files.
- Store each entry with timestamp, source, source app, and optional HTML content.
- Keep all captured data in local app storage by default.

## Out of scope
- Cloud-hosted capture services.

## Outcome
- Sources normalized around `clipboard`, `manual`, and `import`.
- Import workflow supports pasted text, selected files, and drag/drop.
- Imported attachments are stored locally with metadata and surfaced in main app and overlay.
- Local storage layout bootstraps separate `db`, `attachments`, `vectors`, and `config` directories.
- Clipboard HTML is preserved when present with text fallback; source app metadata is captured.

## Done when
- Users can capture from clipboard, add notes manually, and import external content.
- Imported and captured entries appear in the main app and overlay consistently.
- All data remains local unless the user explicitly enables sync later.
