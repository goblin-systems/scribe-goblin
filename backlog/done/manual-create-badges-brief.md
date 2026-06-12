# Feature Brief - Add badges during manual item creation

Status: **Done** (closed; moved from active backlog).

## Outcome
- Quick-add form in `index.html` exposes optional badge input and a color swatch picker.
- `src/main/quick-add-badges.ts` normalizes and merges badge tokens.
- Badges entered during quick-add are applied to the new entry via existing `db_add_manual_badge_bulk`.
- Saving without badges still works exactly as before.
- The flow works for Notes and other collection-targeted quick-add destinations.

## Original objective
Allow users to assign badges immediately when creating a manual item from the main window quick-add flow.

## Scope (delivered)
- Optional badge input controls on the inline quick-add form.
- Saved badges immediately apply to the newly created item using existing badge commands.
- Works across Notes / Todo / Shopping List / other collections via the active-collection quick-add flow.

## Touched files
- `index.html`
- `src/main.ts`
- `src/main/dom.ts`
- `src/main/quick-add-badges.ts`
- `src/main/add-badge-modal.ts` (parser reused)
- `src/main/collection-controller.ts` (reused `addNote(...)`)

## Acceptance criteria (met)
- Quick-add UI exposes an obvious optional way to enter badges during manual creation.
- Saving without badges still works exactly as before.
- Saving with badges creates the item and applies badges immediately.
- Works regardless of whether the active destination is Notes or another collection.
- Badge assignment uses existing backend badge mechanisms with no duplicate storage logic.
- Result follows existing UI conventions and stays coherent with the Goblin design system.
