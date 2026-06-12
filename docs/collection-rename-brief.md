## Objective

Add `Rename collection` to the sidebar collection context menu.

## In scope

- Sidebar collection context menu action
- Backend/frontend collection rename command/path
- Updating collection `name` and `slug` safely on rename

## Non-goals

- No separate full collection edit UI
- No icon/type edit flow beyond existing actions

## Accepted decisions

- Rename belongs on the sidebar collection context menu
- Smallest robust UX is acceptable; a browser/Tauri prompt is fine if no existing modal is available
- Renaming should update both display `name` and derived unique `slug`
- Notes protection semantics remain unchanged; rename availability may follow existing collection action rules unless implementation finds a reason to restrict it

## Acceptance criteria

- Sidebar collection context menu includes `Rename collection`
- Renaming persists and updates the sidebar/current view correctly
- Slug uniqueness remains safe after rename
- Relevant tests/typecheck/build/cargo tests pass
