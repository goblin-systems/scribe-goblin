export interface DesktopSelectionState {
  ids: Set<string>;
  anchorId: string | null;
}

export function createSelectionState(): DesktopSelectionState {
  return {
    ids: new Set<string>(),
    anchorId: null,
  };
}

export function getSelectionIds(state: DesktopSelectionState): string[] {
  return [...state.ids];
}

export function hasSelection(state: DesktopSelectionState, id: string): boolean {
  return state.ids.has(id);
}

export function clearDesktopSelection(state: DesktopSelectionState): void {
  state.ids.clear();
  state.anchorId = null;
}

export function selectSingle(state: DesktopSelectionState, id: string): void {
  state.ids = new Set([id]);
  state.anchorId = id;
}

export function toggleSelection(state: DesktopSelectionState, id: string): void {
  const next = new Set(state.ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  state.ids = next;
  state.anchorId = id;
}

export function selectRange(state: DesktopSelectionState, orderedIds: string[], targetId: string): void {
  const anchorId = state.anchorId ?? targetId;
  const startIndex = orderedIds.indexOf(anchorId);
  const endIndex = orderedIds.indexOf(targetId);

  if (startIndex === -1 || endIndex === -1) {
    selectSingle(state, targetId);
    return;
  }

  const [from, to] = startIndex <= endIndex
    ? [startIndex, endIndex]
    : [endIndex, startIndex];
  state.ids = new Set(orderedIds.slice(from, to + 1));
  state.anchorId = anchorId;
}

export function updateSelectionFromPointer(
  state: DesktopSelectionState,
  orderedIds: string[],
  id: string,
  event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
): void {
  if (event.shiftKey) {
    selectRange(state, orderedIds, id);
    return;
  }

  if (event.ctrlKey || event.metaKey) {
    toggleSelection(state, id);
    return;
  }

  selectSingle(state, id);
}

export function prepareContextSelection(state: DesktopSelectionState, id: string): void {
  if (!state.ids.has(id)) {
    selectSingle(state, id);
  }
}
