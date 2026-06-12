import type { EntryRow } from "./store";

export function sortPinnedOverlayEntries(entries: EntryRow[]): EntryRow[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const pinnedDelta = Number(Boolean(right.entry.pinned)) - Number(Boolean(left.entry.pinned));
      if (pinnedDelta !== 0) return pinnedDelta;
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}
