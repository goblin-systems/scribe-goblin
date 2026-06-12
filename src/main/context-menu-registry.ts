const contextMenuClosers = new Set<() => void>();

export function registerContextMenuCloser(closer: () => void): () => void {
  contextMenuClosers.add(closer);
  return () => {
    contextMenuClosers.delete(closer);
  };
}

export function dismissOpenContextMenus(): void {
  for (const closer of contextMenuClosers) {
    try {
      closer();
    } catch (error) {
      console.error("Failed to dismiss context menu:", error);
    }
  }
}
