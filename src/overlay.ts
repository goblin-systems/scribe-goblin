import {
  applyIcons,
  bindContextMenu,
  setTheme,
  type ContextMenuHandle,
  type ContextMenuItem,
} from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import { cursorPosition, getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { load, type Store } from "@tauri-apps/plugin-store";
import {
  applyModifiedPasteTransform,
  MODIFIED_PASTE_OPTIONS,
  type ModifiedPasteTransformId,
} from "./overlay-modified-paste";
import { getOverlayKeydownAction, getOverlayKeyupAction } from "./overlay-keyboard";
import { sortPinnedOverlayEntries } from "./overlay-pins";
import { resolveStoredUiTheme } from "./overlay-theme";
import type { EntryRow } from "./store";
import { formatBytes, formatImportOrigin, isAttachmentOnlyEntry, overlayFooterHintText, parseManualBadges, sourceLabel } from "./store";
import { loadSettings, type Settings } from "./settings";
import { searchEntries } from "./main/search-controller";
import { getShortcutDisplayLabel } from "./shortcuts";
import { attachAutocomplete } from "./autocomplete";

const BADGE_TONE_CLASS_BY_COLOR: Record<string, string> = {
  default: "overlay-badge--default",
  blue: "overlay-badge--blue",
  green: "overlay-badge--green",
  red: "overlay-badge--red",
  orange: "overlay-badge--orange",
};

let entries: EntryRow[] = [];
let selectedIndex = 0;
let contextMenuHandle: ContextMenuHandle | null = null;
let contextEntryId: string | null = null;
let currentSettings: Settings | null = null;
let contextMenuView: "root" | "modified-paste" = "root";
let lastContextMenuPosition: { x: number; y: number } | null = null;
let uiStore: Store | null = null;
const searchInput = document.getElementById("overlay-search") as HTMLInputElement;
const resultsList = document.getElementById("results-list") as HTMLDivElement;
const footerHint = document.getElementById("overlay-footer-hint") as HTMLSpanElement;
const footerPasteKey = document.getElementById("overlay-footer-paste-key") as HTMLElement;
const footerDeleteKey = document.getElementById("overlay-footer-delete-key") as HTMLElement;
const footerCloseKey = document.getElementById("overlay-footer-close-key") as HTMLElement;

async function getUiStore(): Promise<Store> {
  if (!uiStore) {
    uiStore = await load("settings.json", { autoSave: true, defaults: {} });
  }
  return uiStore;
}

async function applyOverlayTheme(): Promise<void> {
  const store = await getUiStore();
  const theme = resolveStoredUiTheme(await store.get<string>("uiTheme"));
  setTheme(theme);
}

function destroyContextMenuHandle(): void {
  contextMenuHandle?.close();
  contextMenuHandle?.destroy();
  contextMenuHandle = null;
}

function resetOverlayTransientState(): void {
  destroyContextMenuHandle();
  contextEntryId = null;
  contextMenuView = "root";
  lastContextMenuPosition = null;
  document.body.classList.remove("alt-pressed");
}

async function closeOverlay(): Promise<void> {
  resetOverlayTransientState();
  await getCurrentWindow().hide();
}

function currentSearch(): string {
  return searchInput.value.trim();
}

async function refreshEntries(): Promise<void> {
  await loadEntries(currentSearch());
}

function getContextEntry(): EntryRow | null {
  if (!contextEntryId) return null;
  return entries.find((entry) => entry.id === contextEntryId) ?? null;
}

function setupContextMenu(): void {
  const entry = getContextEntry();
  const isSecret = Boolean(entry?.secret_verdict && entry.secret_verdict !== "not_secret");
  const isAttachmentOnly = entry ? isAttachmentOnlyEntry(entry) : true;
  const items: ContextMenuItem[] =
    contextMenuView === "modified-paste"
      ? [
          {
            id: "modified-paste-back",
            label: "Back",
            icon: "arrow-left",
            onSelect: () => {
              reopenContextMenu("root");
            },
          },
          { divider: true },
          ...MODIFIED_PASTE_OPTIONS.map((option) => ({
            id: `modified-paste-${option.id}`,
            label: option.label,
            disabled: isAttachmentOnly,
            onSelect: async () => {
              await performModifiedPaste(option.id);
            },
          })),
        ]
      : [
          {
            id: "modified-paste",
            label: "Modified paste",
            icon: "type",
            disabled: isAttachmentOnly,
            onSelect: () => {
              reopenContextMenu("modified-paste");
            },
          },
          { divider: true },
          {
            id: entry?.pinned ? "unpin-clip" : "pin-clip",
            label: entry?.pinned ? "Unpin clip" : "Pin clip",
            icon: entry?.pinned ? "pin-off" : "pin",
            onSelect: async () => {
              if (!contextEntryId) return;
              await invoke("db_set_entry_pinned", {
                id: contextEntryId,
                pinned: !entry?.pinned,
              });
              await refreshEntries();
              await emit("entries-changed");
            },
          },
          {
            id: "save-note",
            label: "Save as Note",
            icon: "bookmark-plus",
            onSelect: async () => {
              if (!contextEntryId) return;
              await invoke("db_promote_to_note", { id: contextEntryId });
              await refreshEntries();
              await emit("entries-changed");
            },
          },
          {
            id: "add-badge",
            label: "Add Badge...",
            icon: "plus",
            onSelect: async () => {
              if (!contextEntryId) return;
              const raw = window.prompt("Badge name(s), comma-separated");
              if (raw === null) return;
              const badges = raw.split(",").map((s) => s.trim()).filter(Boolean);
              if (badges.length === 0) return;
              for (const badge of badges) {
                await invoke("db_add_manual_badge", { id: contextEntryId, badge, color: "default" });
              }
              await refreshEntries();
              await emit("entries-changed");
            },
          },
          {
            id: isSecret ? "mark-not-secret" : "mark-secret",
            label: isSecret ? "Mark Not Secret" : "Mark as Secret",
            icon: isSecret ? "shield-check" : "shield-alert",
            onSelect: async () => {
              if (!contextEntryId) return;
              await invoke("db_update_entry_secret", {
                id: contextEntryId,
                secretVerdict: isSecret ? "not_secret" : "likely_secret",
                secretType: "unknown",
                secretSource: "manual",
              });
              await refreshEntries();
              await emit("entries-changed");
            },
          },
          { divider: true },
          {
            id: "delete",
            label: "Delete",
            icon: "trash-2",
            onSelect: async () => {
              if (!contextEntryId) return;
              await invoke("db_delete_entry", { id: contextEntryId });
              await refreshEntries();
              await emit("entries-changed");
            },
          },
        ];

  destroyContextMenuHandle();
  contextMenuHandle = bindContextMenu({
    target: resultsList,
    items,
  });
}

function openContextMenuAt(x: number, y: number): void {
  lastContextMenuPosition = { x, y };
  contextMenuHandle?.open(x, y);
  window.requestAnimationFrame(clampOpenContextMenuToViewport);
}

function isContextMenuOpen(): boolean {
  return document.querySelector(".context-menu.is-open") !== null;
}

function getSelectedContextMenuPosition(): { x: number; y: number } {
  const selectedItem = resultsList.querySelector<HTMLElement>(".result-item.is-selected");
  if (selectedItem) {
    const rect = selectedItem.getBoundingClientRect();
    return {
      x: Math.max(8, Math.round(rect.right - 8)),
      y: Math.max(8, Math.round(rect.top + Math.min(rect.height / 2, 24))),
    };
  }

  const rect = resultsList.getBoundingClientRect();
  return {
    x: Math.max(8, Math.round(rect.left + rect.width / 2)),
    y: Math.max(8, Math.round(rect.top + Math.min(rect.height / 2, 24))),
  };
}

function clampOpenContextMenuToViewport(): void {
  const menu = document.querySelector<HTMLElement>(".context-menu.is-open");
  if (!menu) return;

  const rect = menu.getBoundingClientRect();
  const margin = 8;
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  const nextLeft = Math.min(Math.max(rect.left, margin), Math.max(margin, maxLeft));
  const nextTop = Math.min(Math.max(rect.top, margin), Math.max(margin, maxTop));

  menu.style.left = `${nextLeft}px`;
  menu.style.top = `${nextTop}px`;
}

function reopenContextMenu(view: "root" | "modified-paste"): void {
  contextMenuView = view;
  setupContextMenu();
  const position = lastContextMenuPosition;
  if (!position) return;
  window.setTimeout(() => {
    openContextMenuAt(position.x, position.y);
  }, 0);
}

function openModifiedPasteMenuForSelection(): void {
  const entry = entries[selectedIndex];
  if (!entry) return;

  contextEntryId = entry.id;
  contextMenuView = "modified-paste";
  setupContextMenu();

  const position = getSelectedContextMenuPosition();
  openContextMenuAt(position.x, position.y);
}

async function loadEntries(search = "") {
  try {
    currentSettings = await loadSettings();
    updateFooterShortcutLabels();
    const trimmedSearch = search.trim();
    if (trimmedSearch) {
      const results = await searchEntries(
        {
          query: trimmedSearch,
          filters: { is_note: false },
          limit: 50,
        },
        currentSettings,
      );
      entries = sortPinnedOverlayEntries(results.map((result) => result.entry));
    } else {
      const result = await invoke<EntryRow[]>("db_list_entries", {
        search: null,
        limit: 50,
      });
      entries = sortPinnedOverlayEntries(result.filter((entry) => entry.is_note === false));
    }
    if (selectedIndex >= entries.length) {
      selectedIndex = Math.max(0, entries.length - 1);
    }
    renderEntries();
  } catch (err) {
    console.error("Failed to load entries:", err);
  }
}

function renderEntries() {
  resultsList.innerHTML = "";
  updateFooterHint();
  if (entries.length === 0) {
    resultsList.innerHTML = '<div class="overlay-empty-state">No history found</div>';
    return;
  }

  entries.forEach((entry, index) => {
    const item = document.createElement("div");
    const isSecret = entry.secret_verdict && entry.secret_verdict !== "not_secret";
    const isAttachmentOnly = isAttachmentOnlyEntry(entry);
    item.className = `result-item ${index === selectedIndex ? "is-selected" : ""} ${isSecret ? "is-secret" : ""} ${entry.pinned ? "is-pinned" : ""}`;
    
    const content = document.createElement("div");
    content.className = "result-content";
    content.innerHTML = `
      <span class="unmasked-content">${escapeHtml(entry.import_name?.trim() || entry.content)}</span>
      <span class="masked-content">${"•".repeat(Math.min(entry.content.length, 32))}</span>
    `;
    
    const meta = document.createElement("div");
    meta.className = "result-meta";
    const date = new Date(entry.created_at).toLocaleString();
    const metaLabel = buildOverlayMetaLabel(entry, isAttachmentOnly);
    
    const pinHtml = entry.pinned
      ? `<span class="overlay-badge overlay-badge--pinned">Pinned</span>`
      : "";
    const badgeHtml = `${pinHtml}${renderBadgeHtml(entry)}`;

    meta.innerHTML = `<div class="result-meta-badges">${badgeHtml}</div><span>${escapeHtml(metaLabel)} · ${escapeHtml(date)}</span>`;
    
    item.appendChild(content);
    item.appendChild(meta);

    if (isAttachmentOnly) {
      const attachmentHint = document.createElement("div");
      attachmentHint.className = "result-attachment-hint";
      attachmentHint.textContent = "Attachment-only import — paste disabled";
      item.appendChild(attachmentHint);
    }
    
    item.onclick = () => {
      selectedIndex = index;
      void performPaste();
    };

    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedIndex = index;
      contextEntryId = entry.id;
      contextMenuView = "root";
      setupContextMenu();
      renderEntries();
      openContextMenuAt(event.clientX, event.clientY);
    });
    
    resultsList.appendChild(item);
    
    if (index === selectedIndex) {
      item.scrollIntoView({ block: "nearest" });
    }
  });

  applyIcons();
}

function escapeHtml(str: string): string {
  const p = document.createElement("p");
  p.textContent = str;
  return p.innerHTML;
}

async function performPaste() {
  const entry = entries[selectedIndex];
  if (!entry) return;
  if (isAttachmentOnlyEntry(entry)) {
    updateFooterHint();
    return;
  }

  await closeOverlay();

  setTimeout(async () => {
    try {
      await invoke("simulate_paste", {
        text: entry.content,
        html: entry.html_content,
      });
    } catch (err) {
      console.error("Paste failed:", err);
    }
  }, 100);
}

async function performModifiedPaste(transform: ModifiedPasteTransformId): Promise<void> {
  const entry = getContextEntry() ?? entries[selectedIndex];
  if (!entry || isAttachmentOnlyEntry(entry)) {
    updateFooterHint();
    return;
  }

  const entryIndex = entries.findIndex((candidate) => candidate.id === entry.id);
  if (entryIndex >= 0) {
    selectedIndex = entryIndex;
  }

  const transformedText = applyModifiedPasteTransform(entry.content, transform);
  await closeOverlay();

  setTimeout(async () => {
    try {
      await invoke("simulate_paste", {
        text: transformedText,
        html: null,
      });
    } catch (err) {
      console.error("Modified paste failed:", err);
    }
  }, 100);
}

async function deleteSelectedEntry() {
  const entry = entries[selectedIndex];
  if (!entry) return;

  try {
    await invoke("db_delete_entry", { id: entry.id });
    entries.splice(selectedIndex, 1);
    if (selectedIndex >= entries.length) {
      selectedIndex = Math.max(0, entries.length - 1);
    }
    renderEntries();
    await emit("entries-changed");
  } catch (err) {
    console.error("Delete failed:", err);
  }
}

function updateFooterHint(): void {
  footerHint.textContent = overlayFooterHintText(entries[selectedIndex]);
}

function updateFooterShortcutLabels(): void {
  const overrides = currentSettings?.shortcutOverrides ?? {};
  footerPasteKey.textContent = getShortcutDisplayLabel("overlay.paste", overrides);
  footerDeleteKey.textContent = getShortcutDisplayLabel("overlay.delete", overrides);
  footerCloseKey.textContent = getShortcutDisplayLabel("overlay.close", overrides);
}

function buildOverlayMetaLabel(entry: EntryRow, isAttachmentOnly: boolean): string {
  const parts: string[] = [sourceLabel(entry.source)];

  if (entry.source === "import") {
    const origin = formatImportOrigin(entry.import_origin);
    if (origin) parts.push(origin);
    if (entry.content_type) parts.push(entry.content_type);
    const size = formatBytes(entry.attachment_size_bytes);
    if (size) parts.push(size);
  }

  if (isAttachmentOnly) {
    parts.push("attachment");
  }

  return parts.join(" · ");
}

function renderBadgeHtml(entry: EntryRow): string {
  const parts: string[] = [];

  if (entry.label && entry.label !== "other") {
    parts.push(`<span class="overlay-badge overlay-badge--auto">${escapeHtml(entry.label)}<button data-entry-id="${entry.id}" data-badge-name="${escapeHtml(entry.label)}" data-badge-type="auto" type="button" aria-label="Remove badge" class="badge-remove-btn">×</button></span>`);
  }

  for (const badge of parseManualBadges(entry.manual_badges)) {
    const toneClass = BADGE_TONE_CLASS_BY_COLOR[badge.color] || BADGE_TONE_CLASS_BY_COLOR.default;
    parts.push(`<span class="overlay-badge ${toneClass}">${escapeHtml(badge.name)}<button data-entry-id="${entry.id}" data-badge-name="${escapeHtml(badge.name)}" data-badge-type="manual" type="button" aria-label="Remove badge" class="badge-remove-btn">×</button></span>`);
  }

  return parts.join("");
}

async function handleBadgeRemoveClick(btn: HTMLElement): Promise<void> {
  const entryId = btn.dataset.entryId;
  const badgeType = btn.dataset.badgeType;
  const badgeName = btn.dataset.badgeName;
  if (!entryId || !badgeType || !badgeName) return;

  try {
    if (badgeType === "auto") {
      await invoke("db_clear_entry_label", { id: entryId });
    } else {
      await invoke("db_remove_manual_badge", { id: entryId, badge: badgeName });
    }
    await refreshEntries();
    await emit("entries-changed");
  } catch (err) {
    console.error("Failed to remove badge:", err);
  }
}

resultsList.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".badge-remove-btn");
  if (btn) {
    e.stopPropagation();
    void handleBadgeRemoveClick(btn);
  }
});

searchInput.oninput = () => {
  selectedIndex = 0;
  void loadEntries(searchInput.value);
};

const overlayAutocomplete = attachAutocomplete(searchInput, {
  getSettings: () => currentSettings,
});

window.onkeydown = (e) => {
  switch (getOverlayKeydownAction({
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    isContextMenuOpen: isContextMenuOpen(),
  })) {
    case "reveal-on":
      e.preventDefault();
      if (!document.body.classList.contains("alt-pressed")) {
        document.body.classList.add("alt-pressed");
      }
      return;
    case "move-down":
      e.preventDefault();
      if (entries.length > 0) {
        selectedIndex = (selectedIndex + 1) % entries.length;
        renderEntries();
      }
      return;
    case "move-up":
      e.preventDefault();
      if (entries.length > 0) {
        selectedIndex = (selectedIndex - 1 + entries.length) % entries.length;
        renderEntries();
      }
      return;
    case "paste":
      e.preventDefault();
      void performPaste();
      return;
    case "open-modified-paste":
      e.preventDefault();
      openModifiedPasteMenuForSelection();
      return;
    case "delete":
      e.preventDefault();
      void deleteSelectedEntry();
      return;
    case "close":
      void closeOverlay();
      return;
    case "none":
      return;
  }
};

window.onkeyup = (e) => {
  if (getOverlayKeyupAction(e.key) === "reveal-off") {
    e.preventDefault();
    document.body.classList.remove("alt-pressed");
  }
};

// Listen for show-overlay event
listen("show-overlay", async (event: { payload?: { x?: number; y?: number } }) => {
  const appWindow = getCurrentWindow();
  await applyOverlayTheme();
  
  try {
    const pos = await cursorPosition();
    const factor = await appWindow.scaleFactor();
    const logical = pos.toLogical(factor);
    await appWindow.setPosition(new LogicalPosition(logical.x - 200, logical.y - 20));
  } catch (err) {
    console.error("Failed to get cursor position natively:", err);
    // Center roughly on cursor when coordinates are available (fallback)
    const { x, y } = event.payload ?? {};
    if (typeof x === "number" && typeof y === "number") {
      await appWindow.setPosition(new LogicalPosition(x - 200, y - 20));
    }
  }

  await appWindow.show();
  await appWindow.setFocus();

  resetOverlayTransientState();
  searchInput.value = "";
  selectedIndex = 0;
  // Pick up settings the user may have changed in the main window.
  currentSettings = await loadSettings();
  overlayAutocomplete.refresh();
  await loadEntries();
  searchInput.focus();
});

listen("entries-changed", async () => {
  currentSettings = await loadSettings();
  overlayAutocomplete.refresh();
  updateFooterShortcutLabels();
  await refreshEntries();
});

// Auto-focus search on start
window.onload = () => {
  void (async () => {
    await applyOverlayTheme();
    searchInput.focus();
    currentSettings = await loadSettings();
    updateFooterShortcutLabels();
    await loadEntries();
  })();
};

// Hide when focus is lost
window.onblur = () => {
  void closeOverlay();
};
