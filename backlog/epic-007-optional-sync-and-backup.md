# Epic 007 - Optional sync and backup

## Goal
Allow multi-machine access without introducing a Scribe-hosted backend.

## Scope
- Optional encrypted sync to a user-provided storage target.
- Local-first behavior when sync is disabled.
- Backup and restore flows for database and vector data.

## Status

### Done
- Storage layout already separates `db`, `attachments`, `vectors`, `config` (epic-001), which gives each one its own sync lane.

### Open
- Define the sync contract for database, vectors, config, and attachments (which is canonical, which is derivable, conflict semantics).
- Add client-side encryption before any synced payload leaves the machine.
- Integrate with S3-compatible user-owned storage (R2, B2, S3, MinIO).
- Conflict handling and recovery for multi-machine changes.
- Backup and restore UX for local-only users (one-shot snapshot, restore wizard).
- Expose sync health, last successful sync time, and failure states.
- Decide whether at-rest encryption of the local DB is part of this epic or a separate one (see epic-008 capture filters / privacy).

## Done when
- Users can keep the app fully local or opt into encrypted sync.
- Sync works across machines without any vendor-hosted Scribe service.
- Restore flows are documented and testable.
