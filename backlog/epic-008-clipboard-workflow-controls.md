# Epic 008 - Clipboard workflow and capture controls

## Goal
Make the clipboard surface a fluent everyday tool: prioritize the clips users reach for repeatedly, paste them with one keystroke, scope the log to what matters, and respect privacy when capturing.

## Scope
- Paste-side ergonomics in the overlay (pinning, numeric quickpicks, modifier-driven paste).
- Capture rules that suppress unwanted entries at source.
- Retention controls so the clipboard log does not grow without bound.
- Image and rich-format clip support end to end.
- System-tray presence and window lifecycle behavior.
- Optional at-rest encryption of the clipboard database.

## Out of scope
- Cross-machine clipboard sync (covered by epic-007).
- Editor-style features for clipboard items beyond preview (covered by epic-009).

## Backlog
- Pinned / sticky clips that float to the top of the overlay regardless of recency, with persistence across restarts.
- Numeric quickpicks: `Ctrl+1..9` paste the top N items directly without stepping through the list.
- Modifier-paste matrix: extend the existing modified-paste flow to a documented set of transforms (plain text, lowercase, trimmed, etc.) with a help affordance in the overlay.
- Capture filter rules:
  - Per-application allow / blocklist (skip captures sourced from named apps).
  - Regex content blocklist (skip captures whose text matches a user-supplied pattern).
  - Min-size / max-size thresholds.
  - Ignored content types (e.g. skip files of a given MIME).
- Retention controls: auto-prune by age in days and by entry count, with safe defaults and a "vacuum now" action that compacts SQLite and the vector store.
- Image clipboard format: capture, store as attachment, render thumbnail in the overlay and main lists, paste as image.
- Format inspector in the detail pane: show which clipboard formats were present (text / HTML / RTF / image / files) and let the user paste any of them.
- System tray icon with menu (show overlay, show main window, toggle clipboard monitoring, quit) and minimize-to-tray behavior on close.
- Window position and size memory across monitors for the main window and overlay.
- Optional at-rest encryption of the local database, gated by a passphrase set in settings, with clear messaging about lost-passphrase recovery.

## Done when
- Frequent clips are reachable in one keystroke without scrolling.
- The user can suppress sensitive sources from ever being captured.
- The clipboard log self-maintains without manual cleanup.
- Images and rich content survive a copy → overlay → paste round trip.
- The app behaves like a tray-resident utility rather than a foreground-only window.
- Users who require it can keep their clipboard database encrypted on disk.
