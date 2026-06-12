import {
  applyIcons,
  bindContextMenu,
  showToast,
  type ContextMenuHandle,
  type ContextMenuItem,
} from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { ScribeDom } from "./dom";
import type { Settings } from "../settings";
import type {
  CollectionRow,
  EntryRow,
  SearchEntryResult,
  SearchEntryResultPayload,
  SearchFilters,
} from "../store";
import { searchEntries } from "./search-controller";
import {
  formatRelativeTime,
  normalizeSearchEntryResults,
  sourceIcon,
} from "../store";
import { sortPinnedOverlayEntries } from "../overlay-pins";
import {
  buildDisplayEntryPreview,
  buildSearchHighlightedPreview,
  buildEntryDetailMeta,
  escapeHtml,
  isSecretEntry,
  hydrateEmbeddingDebugSection,
  renderEmbeddingDebugSection,
  renderEntryDetailText,
  renderEntryBadges,
  renderProcessingDiagnosticsSection,
  renderRelatedItemsSection,
  renderSearchDebugSection,
  renderSearchExplanation,
  renderSearchSummary,
  renderEntryDetailContent,
  renderImportMetaBadges,
} from "./entry-presenters";
import { isDebugLoggingEnabled } from "../logger";
import {
  bindSecretDetailReveal,
  clearSecretDetailReveal,
  isSecretRevealActive,
  subscribeSecretReveal,
} from "./secret-reveal-controller";
import {
  initAddBadgeModal,
  type AddBadgeModalController,
} from "./add-badge-modal";
import {
  copyEntriesToCollection,
  getCollectionIcon,
  moveEntriesToCollection,
} from "./collections";
import {
  clearCollectionSelection,
  handleBadgeFilterClick,
  syncFilterButtonState,
} from "./collection-controller";
import {
  clearDesktopSelection,
  createSelectionState,
  getSelectionIds,
  hasSelection,
  prepareContextSelection,
  updateSelectionFromPointer,
} from "./selection";
import { renderStatusBarChips } from "./status-bar";
import {
  dismissOpenContextMenus,
  registerContextMenuCloser,
} from "./context-menu-registry";

const CLIPBOARD_LIMIT = 200;
const CLIPBOARD_FETCH_LIMIT = 500;
const CLIPBOARD_SECRET_REVEAL_BINDING_ID = "clipboard-detail";

interface ClipboardControllerOptions {
  getCollections: () => CollectionRow[];
  requestCreateCollection: (
    entryIds?: string[],
  ) => Promise<CollectionRow | null>;
  refreshGraph?: () => void;
  isGraphVisible?: () => boolean;
  setGraphHoveredEntry?: (entryId: string | null) => void;
  focusGraphEntry?: (entryId: string) => void;
  applyRelatedToFilter?: (entryId: string) => void;
}

let allEntries: EntryRow[] = [];
let currentRenderedCount = 0;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let getSettings: () => Settings;
let dom: ScribeDom;
let options: ClipboardControllerOptions;
let contextMenuHandle: ContextMenuHandle | null = null;
let currentSearchQuery = "";
let lastResults: SearchEntryResult[] = [];
let currentRelatedRequestId = 0;
let unsubscribeSecretReveal: (() => void) | null = null;
let selectedRelatedEntries: SearchEntryResult[] = [];
let badgeModal: AddBadgeModalController;
let unregisterContextMenuCloser: (() => void) | null = null;

const selection = createSelectionState();

type SearchUiState = "idle" | "loading" | "error";

export function initClipboardController(
  d: ScribeDom,
  settingsGetter: () => Settings,
  controllerOptions: ClipboardControllerOptions,
): void {
  dom = d;
  getSettings = settingsGetter;
  options = controllerOptions;

  unregisterContextMenuCloser?.();
  unregisterContextMenuCloser = registerContextMenuCloser(() => {
    contextMenuHandle?.close();
  });

  dom.clipboardList.addEventListener("contextmenu", () => {
    dismissOpenContextMenus();
  });

  unsubscribeSecretReveal?.();
  unsubscribeSecretReveal = subscribeSecretReveal(() => {
    refreshSecretPreviews();
  });

  setupBadgeRemoveDelegation();
  dom.clipboardBadgeFilterBtn.addEventListener("click", (e) => {
    void handleBadgeFilterClick(
      dom.clipboardBadgeFilterBtn,
      dom.clipboardSearchInput,
      e,
    );
  });
  badgeModal = initAddBadgeModal(dom, async ({ ids, badges, color }) => {
    try {
      for (const badge of badges) {
        await invoke("db_add_manual_badge_bulk", { ids, badge, color });
      }
      await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
      await emit("entries-changed");
      showToast(
        badges.length === 1 ? "Badge added" : `${badges.length} badges added`,
        "success",
        1200,
      );
    } catch {
      showToast("Failed to add badge", "error");
    }
  });
}

export function getSelectedClipboardEntryIds(): string[] {
  return getSelectionIds(selection);
}

export async function loadClipboard(search?: string): Promise<void> {
  currentSearchQuery = search?.trim() ?? "";
  setClipboardUiState("loading", currentSearchQuery);

  try {
    const { query, filters } = parseClipboardSearchInput(currentSearchQuery);
    const results = await searchEntries(
      { query, filters, limit: CLIPBOARD_FETCH_LIMIT },
      getSettings(),
    );
    lastResults = results
      .filter((result) => result.entry.collection_id === null)
      .slice(0, CLIPBOARD_LIMIT);
    allEntries = sortPinnedOverlayEntries(lastResults.map((result) => result.entry));
    renderList(allEntries);
    setClipboardUiState("idle", currentSearchQuery, allEntries.length);
    options.refreshGraph?.();
  } catch (err) {
    console.error("Failed to load clipboard entries:", err);
    renderList([]);
    setClipboardUiState("error", currentSearchQuery, 0, err);
  }
}

export function handleClipboardSearchInput(query: string): void {
  dom.clipboardSearchClearBtn.hidden = query.length === 0;
  syncFilterButtonState(dom.clipboardBadgeFilterBtn, query);

  if (searchDebounce !== null) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchDebounce = null;
    void loadClipboard(query.trim() || undefined);
  }, 300);
}

function renderList(entries: EntryRow[]): void {
  currentRenderedCount = entries.length;
  dom.clipboardList.replaceChildren();

  const hasEntries = entries.length > 0;
  dom.clipboardEmpty.hidden = hasEntries;

  if (!hasEntries) {
    clearDesktopSelection(selection);
    dom.clipboardDetailPlaceholder.hidden = true;
    dom.clipboardDetail.hidden = true;
  } else if (selection.ids.size === 0) {
    dom.clipboardDetailPlaceholder.hidden = false;
  }

  const validIds = new Set(entries.map((entry) => entry.id));
  selection.ids.forEach((id) => {
    if (!validIds.has(id)) selection.ids.delete(id);
  });

  for (const entry of entries) {
    dom.clipboardList.appendChild(buildClipboardItem(entry));
  }

  if (selection.ids.size === 1) {
    const selectedId = getSelectionIds(selection)[0] ?? null;
    const selectedEntry = selectedId
      ? (entries.find((entry) => entry.id === selectedId) ?? null)
      : null;
    if (selectedEntry) selectEntry(selectedEntry);
  } else if (selection.ids.size > 1) {
    renderBulkSelection();
  } else {
    clearClipboardSelection(false);
  }

  applyIcons();
}

export function parseClipboardSearchInput(rawQuery: string): {
  query: string | null;
  filters: SearchFilters;
} {
  const filters: SearchFilters = { is_note: false };
  const terms: string[] = [];

  for (const token of rawQuery.split(/\s+/).filter(Boolean)) {
    const separatorIndex = token.indexOf(":");
    if (separatorIndex <= 0) {
      terms.push(token);
      continue;
    }

    const key = token.slice(0, separatorIndex).toLowerCase();
    const value = token.slice(separatorIndex + 1).trim();
    if (!value) continue;

    switch (key) {
      case "label":
      case "tag":
        filters.tag = value.toLowerCase();
        break;
      case "related-to":
      case "related":
        filters.related_to = value;
        break;
      case "source":
        filters.source = value.toLowerCase();
        break;
      case "app":
      case "sourceapp":
        filters.source_app = value;
        break;
      case "from": {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) filters.date_from = parsed;
        else terms.push(token);
        break;
      }
      case "to": {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) filters.date_to = parsed;
        else terms.push(token);
        break;
      }
      default:
        terms.push(token);
        break;
    }
  }

  return {
    query: terms.length > 0 ? terms.join(" ") : null,
    filters,
  };
}

function setClipboardUiState(
  state: SearchUiState,
  query: string,
  resultCount = 0,
  error?: unknown,
): void {
  if (state === "loading") {
    dom.clipboardStatusLeft.textContent = query
      ? `Searching clipboard for "${query}"...`
      : "Loading clipboard...";
    dom.clipboardEmpty.innerHTML = `<i data-lucide="loader-circle" style="width:32px;height:32px;opacity:0.35;"></i><p class="hint">${query ? `Searching clipboard for <strong>${escapeHtml(query)}</strong>...` : "Loading clipboard..."}</p>`;
    dom.clipboardEmpty.hidden = false;
    renderStatusBarChips(dom.clipboardStatusMeta, {
      entries: allEntries,
      query,
      results: lastResults,
      settings: getSettings(),
    });
    applyIcons();
    return;
  }

  if (state === "error") {
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    dom.clipboardStatusLeft.textContent = "Clipboard search failed";
    dom.clipboardEmpty.innerHTML = `<i data-lucide="alert-circle" style="width:32px;height:32px;opacity:0.35;"></i><p class="hint">Failed to load clipboard items${query ? ` for <strong>${escapeHtml(query)}</strong>` : ""}.<br />${escapeHtml(message)}</p>`;
    dom.clipboardEmpty.hidden = false;
    renderStatusBarChips(dom.clipboardStatusMeta, {
      entries: allEntries,
      query,
      results: lastResults,
      settings: getSettings(),
    });
    applyIcons();
    return;
  }

  if (query) {
    dom.clipboardStatusLeft.textContent = renderSearchSummary(
      resultCount,
      query,
      "clipboard item",
    );
    dom.clipboardEmpty.innerHTML = `<i data-lucide="search-x" style="width:32px;height:32px;opacity:0.2;"></i><p class="hint">No clipboard items match <strong>${escapeHtml(query)}</strong>.<br />Try different keywords or filters like <code>tag:</code>, <code>source:</code>, or <code>app:</code>.</p>`;
  } else {
    dom.clipboardStatusLeft.textContent =
      resultCount > 0
        ? `${resultCount} clipboard item${resultCount === 1 ? "" : "s"}`
        : "Clipboard";
    dom.clipboardEmpty.innerHTML = `<i data-lucide="clipboard" style="width:32px;height:32px;opacity:0.2;"></i><p class="hint">No clipboard items yet.<br />Enable clipboard monitoring in Settings &gt; Capture.</p>`;
  }

  renderStatusBarChips(dom.clipboardStatusMeta, {
    entries: allEntries,
    query,
    results: lastResults,
    settings: getSettings(),
  });
  applyIcons();
}

function buildClipboardItem(entry: EntryRow): HTMLElement {
  const item = document.createElement("div");
  item.className = `note-item${hasSelection(selection, entry.id) ? " is-selected" : ""}`;
  item.dataset.id = entry.id;

  const result =
    lastResults.find((candidate) => candidate.entry.id === entry.id) ?? null;
  const displayPreview =
    currentSearchQuery && result
      ? buildSearchHighlightedPreview(entry, result, {
          revealSecrets: isSecretRevealActive(),
        })
      : buildDisplayEntryPreview(entry, {
          revealSecrets: isSecretRevealActive(),
        });

  const badgeHtml = renderBadgeHtml(entry);
  const importMeta = renderImportMetaBadges(entry);
  const searchReason =
    currentSearchQuery && result
      ? `<div class="note-search-meta hint">${escapeHtml(renderSearchExplanation(result))}</div>`
      : "";

  const secretBadge =
    entry.secret_verdict && entry.secret_verdict !== "not_secret"
      ? `<span class="badge" style="background:rgba(255,0,0,0.15);color:#ff6b6b;">${entry.secret_verdict === "secret" ? "secret" : "likely secret"}</span>`
      : "";

  const appInfo = entry.source_app
    ? `<span class="hint">via ${escapeHtml(entry.source_app)}</span>`
    : "";
  const graphActionsHtml = `<div class="note-item-graph-actions">
      <button class="note-item-graph-eye icon-btn" type="button" data-graph-focus-entry-id="${escapeHtml(entry.id)}" aria-label="Center item in graph" title="Center in graph"><i data-lucide="locate-fixed"></i></button>
      <button class="note-item-graph-eye icon-btn" type="button" data-graph-filter-entry-id="${escapeHtml(entry.id)}" aria-label="Focus graph on related items" title="Focus graph"><i data-lucide="eye"></i></button>
    </div>`;

  item.innerHTML = `
    <div class="note-item-main">
      <div class="note-item-body">
        <div class="note-item-header">
          <i data-lucide="${sourceIcon(entry.source)}" class="note-source-icon"></i>
          <span class="note-time hint">${formatRelativeTime(entry.created_at)}</span>
          ${appInfo}
          ${importMeta}
          ${badgeHtml}
          ${secretBadge}
        </div>
        <p class="note-preview">${displayPreview}</p>
        ${searchReason}
      </div>
      ${graphActionsHtml}
    </div>
  `;

  item.addEventListener("click", (event) => {
    updateSelectionFromPointer(
      selection,
      allEntries.map((candidate) => candidate.id),
      entry.id,
      event,
    );
    syncListSelectionClasses();
    if (selection.ids.size > 1) renderBulkSelection();
    else selectEntry(entry);
  });

  item.addEventListener("mouseenter", () => {
    options.setGraphHoveredEntry?.(entry.id);
  });

  item.addEventListener("mouseleave", () => {
    options.setGraphHoveredEntry?.(null);
  });

  const graphEyeButton = item.querySelector<HTMLElement>("[data-graph-focus-entry-id]");
  graphEyeButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    options.focusGraphEntry?.(entry.id);
  });

  const graphFilterButton = item.querySelector<HTMLElement>("[data-graph-filter-entry-id]");
  graphFilterButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    options.applyRelatedToFilter?.(entry.id);
  });

  item.addEventListener("contextmenu", () => {
    prepareContextSelection(selection, entry.id);
    syncListSelectionClasses();
    setupContextMenu();
    if (selection.ids.size > 1) renderBulkSelection();
    else selectEntry(entry);
  });

  return item;
}

function syncListSelectionClasses(): void {
  dom.clipboardList
    .querySelectorAll<HTMLElement>(".note-item")
    .forEach((item) => {
      item.classList.toggle(
        "is-selected",
        hasSelection(selection, item.dataset.id || ""),
      );
    });
}

function getSelectedEntries(): EntryRow[] {
  return allEntries.filter((entry) => selection.ids.has(entry.id));
}

function getContextMenuItems(): ContextMenuItem[] {
  const selectedEntries = getSelectedEntries();
  const selectedIds = selectedEntries.map((entry) => entry.id);
  const allSecret =
    selectedEntries.length > 0 &&
    selectedEntries.every(
      (entry) => entry.secret_verdict && entry.secret_verdict !== "not_secret",
    );
  const allPinned =
    selectedEntries.length > 0 &&
    selectedEntries.every((entry) => entry.pinned);

  const moveItems: ContextMenuItem[] = options
    .getCollections()
    .map((collection) => ({
      id: `move-${collection.id}`,
      label: collection.name,
      icon: getCollectionIcon(collection),
      onSelect: async () => {
        await moveSelection(
          selectedIds,
          collection.id,
          `${selectedIds.length === 1 ? "Item" : "Items"} moved to ${collection.name}`,
        );
      },
    }));

  moveItems.push(
    { divider: true },
    {
      id: "move-none",
      label: "No collection",
      icon: "inbox",
      disabled: true,
    },
    {
      id: "move-new",
      label: "New collection from selected...",
      icon: "folder-plus",
      onSelect: async () => {
        const collection = await options.requestCreateCollection(selectedIds);
        if (!collection) return;
        await moveSelection(
          selectedIds,
          collection.id,
          `Items moved to ${collection.name}`,
        );
      },
    },
  );

  const copyItems: ContextMenuItem[] = options
    .getCollections()
    .map((collection) => ({
      id: `copy-${collection.id}`,
      label: collection.name,
      icon: getCollectionIcon(collection),
      onSelect: async () => {
        await copySelection(
          selectedIds,
          collection.id,
          `${selectedIds.length === 1 ? "Item" : "Items"} copied to ${collection.name}`,
        );
      },
    }));

  copyItems.push(
    { divider: true },
    {
      id: "copy-none",
      label: "No collection",
      icon: "inbox",
      onSelect: async () => {
        await copySelection(
          selectedIds,
          null,
          `${selectedIds.length === 1 ? "Item" : "Items"} copied to No collection`,
        );
      },
    },
  );

  return [
    {
      id: "move-to",
      label: "Move to",
      icon: "folder-output",
      items: moveItems,
    } as ContextMenuItem,
    {
      id: "copy-to",
      label: "Copy to",
      icon: "copy",
      items: copyItems,
    } as ContextMenuItem,
    {
      id: allPinned ? "unpin-clips" : "pin-clips",
      label: allPinned
        ? selectedIds.length === 1 ? "Unpin clip" : "Unpin clips"
        : selectedIds.length === 1 ? "Pin clip" : "Pin clips",
      icon: allPinned ? "pin-off" : "pin",
      onSelect: async () => {
        await setPinned(selectedIds, !allPinned);
      },
    },
    {
      id: "add-badge",
      label: "Add Badge...",
      icon: "plus",
      onSelect: () => badgeModal.open(getSelectionIds(selection)),
    },
    {
      id: allSecret ? "mark-not-secret" : "mark-secret",
      label: allSecret ? "Mark Not Secret" : "Mark as Secret",
      icon: allSecret ? "shield-check" : "shield-alert",
      onSelect: async () => {
        await setSecretVerdict(
          selectedIds,
          allSecret ? "not_secret" : "likely_secret",
        );
      },
    },
    { divider: true },
    {
      id: "delete",
      label: "Delete",
      icon: "trash-2",
      onSelect: async () => {
        await deleteEntries(selectedIds);
      },
    },
  ];
}

function setupContextMenu(): void {
  contextMenuHandle?.destroy();
  contextMenuHandle = bindContextMenu({
    target: dom.clipboardList,
    items: getContextMenuItems(),
  });
}

function refreshSecretPreviews(): void {
  const entriesById = new Map(allEntries.map((entry) => [entry.id, entry]));
  const revealSecrets = isSecretRevealActive();

  dom.clipboardList
    .querySelectorAll<HTMLElement>(".note-item")
    .forEach((item) => {
      const entryId = item.dataset.id;
      if (!entryId) return;
      const entry = entriesById.get(entryId);
      if (!entry || !isSecretEntry(entry)) return;

      const preview = item.querySelector<HTMLElement>(".note-preview");
      if (!preview) return;

      const result =
        lastResults.find((candidate) => candidate.entry.id === entry.id) ??
        null;
      preview.innerHTML =
        currentSearchQuery && result
          ? buildSearchHighlightedPreview(entry, result, { revealSecrets })
          : buildDisplayEntryPreview(entry, { revealSecrets });
    });

  if (selectedRelatedEntries.length > 0) {
    dom.clipboardDetailRelated.innerHTML = renderRelatedItemsSection(
      "Related items",
      selectedRelatedEntries,
      { revealSecrets },
    );
    bindRelatedClipboardClicks(selectedRelatedEntries);
  }
}

function selectEntry(entry: EntryRow): void {
  selection.ids = new Set([entry.id]);
  selection.anchorId = entry.id;
  syncListSelectionClasses();
  void loadRelatedClipboardEntries(entry);

  const debugEnabled = isDebugLoggingEnabled();
  const isSecret =
    entry.secret_verdict && entry.secret_verdict !== "not_secret";
  const result =
    lastResults.find((candidate) => candidate.entry.id === entry.id) ?? null;

  if (isSecret) {
    bindSecretDetailReveal({
      bindingId: CLIPBOARD_SECRET_REVEAL_BINDING_ID,
      container: dom.clipboardDetailContent,
      content: entry.content,
    });
  } else {
    clearSecretDetailReveal(CLIPBOARD_SECRET_REVEAL_BINDING_ID);
    const attachmentContent = renderEntryDetailContent(entry);
    if (attachmentContent) {
      dom.clipboardDetailContent.innerHTML = attachmentContent;
    } else {
      const detailHtml =
        currentSearchQuery && result
          ? renderEntryDetailText(entry, result)
          : null;
      if (detailHtml) dom.clipboardDetailContent.innerHTML = detailHtml;
      else dom.clipboardDetailContent.textContent = entry.content;
    }
  }

  const labelInfo = renderDetailBadgeHtml(entry);
  const metaParts = buildEntryDetailMeta(entry)
    .map((part) => `<span class="hint">${escapeHtml(part)}</span>`)
    .join(`<span class="hint">·</span>`);
  const detailGraphActions = `
    <button class="icon-btn icon-btn-sm" type="button" data-detail-graph-focus-entry-id="${escapeHtml(entry.id)}" title="Center in graph" aria-label="Center in graph">
      <i data-lucide="locate-fixed"></i>
    </button>
    <button class="icon-btn icon-btn-sm" type="button" data-detail-graph-filter-entry-id="${escapeHtml(entry.id)}" title="Focus graph" aria-label="Focus graph">
      <i data-lucide="eye"></i>
    </button>
  `;

  dom.clipboardDetailMeta.innerHTML = `
    <div class="row gap-2" style="align-items:center; flex-wrap: wrap;">
      <span class="hint">${new Date(entry.created_at).toLocaleString()}</span>
      <span class="hint">·</span>
      ${metaParts}
      ${labelInfo}
      <span class="detail-graph-actions">${detailGraphActions}</span>
    </div>
  `;
  const debugSections: string[] = [];

  if (result && currentSearchQuery) {
    if (debugEnabled) {
      debugSections.push(
        `<div class="search-diagnostics-block">${renderSearchDebugSection(result)}</div>`,
      );
    }
  } else if (debugEnabled && result) {
    debugSections.push(
      `<div class="search-diagnostics-block">${renderSearchDebugSection(result)}</div>`,
    );
  }

  if (debugEnabled) {
    debugSections.push(
      `<div class="search-diagnostics-block">${renderProcessingDiagnosticsSection(entry)}</div>`,
    );
    debugSections.push(renderEmbeddingDebugSection(entry));
  }

  dom.clipboardDetailDebug.hidden = !debugEnabled;
  dom.clipboardDetailDebug.innerHTML = debugSections.join("");

  if (debugEnabled) {
    hydrateEmbeddingDebugSection(entry);
  }

  if (entry.secret_verdict && entry.secret_verdict !== "not_secret") {
    const verdictLabel =
      entry.secret_verdict === "secret"
        ? "🔴 Secret Detected"
        : "🟡 Likely Secret";
    const typeLabel = entry.secret_type || "unknown";
    dom.clipboardDetailSecretActions.innerHTML = `
      <div class="secret-banner">
        <span style="font-weight:600;">${verdictLabel}</span>
        <span class="hint">(${escapeHtml(typeLabel)} · via ${escapeHtml(entry.secret_source || "unknown")})</span>
      </div>
    `;
    dom.clipboardDetailSecretActions.hidden = false;
  } else {
    dom.clipboardDetailSecretActions.hidden = true;
  }

  dom.clipboardDetail.hidden = false;
  dom.clipboardDetailPlaceholder.hidden = true;
  dom.clipboardDetailDelete.hidden = false;
  dom.clipboardDetailDelete.dataset.id = entry.id;
  const detailTitle = dom.clipboardDetail.querySelector<HTMLHeadingElement>(
    ".note-detail-header h3",
  );
  if (detailTitle) detailTitle.textContent = "Clipboard Item";
  applyIcons();
}

function renderBulkSelection(): void {
  const selectedIds = getSelectionIds(selection);
  const count = selectedIds.length;
  clearSecretDetailReveal(CLIPBOARD_SECRET_REVEAL_BINDING_ID);
  selectedRelatedEntries = [];

  dom.clipboardDetail.hidden = false;
  dom.clipboardDetailPlaceholder.hidden = true;
  dom.clipboardDetailDelete.hidden = true;
  dom.clipboardDetailRelated.innerHTML = "";
  dom.clipboardDetailDebug.hidden = true;
  dom.clipboardDetailDebug.innerHTML = "";
  dom.clipboardDetailMeta.innerHTML = `<div class="hint">${count} selected</div>`;
  dom.clipboardDetailSecretActions.hidden = false;
  dom.clipboardDetailSecretActions.innerHTML = `
    <div class="bulk-actions-card">
      <div class="bulk-actions-title">${count} items selected</div>
      <div class="bulk-actions-row">
        <button class="secondary-btn slim-btn" type="button" data-bulk-action="add-badge">Add badge</button>
        <button class="secondary-btn slim-btn" type="button" data-bulk-action="mark-secret">Mark secret</button>
        <button class="secondary-btn slim-btn" type="button" data-bulk-action="mark-not-secret">Mark not secret</button>
        <button class="secondary-btn slim-btn" type="button" data-bulk-action="delete">Delete</button>
      </div>
    </div>
  `;
  dom.clipboardDetailContent.innerHTML = `<p class="hint">Use bulk actions here or right-click the selection for the full move menu.</p>`;
  const detailTitle = dom.clipboardDetail.querySelector<HTMLHeadingElement>(
    ".note-detail-header h3",
  );
  if (detailTitle) detailTitle.textContent = `${count} Selected`;

  dom.clipboardDetailSecretActions
    .querySelectorAll<HTMLElement>("[data-bulk-action]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.bulkAction;
        if (!action) return;
        switch (action) {
          case "add-badge":
            badgeModal.open(getSelectionIds(selection));
            break;
          case "mark-secret":
            void setSecretVerdict(selectedIds, "likely_secret");
            break;
          case "mark-not-secret":
            void setSecretVerdict(selectedIds, "not_secret");
            break;
          case "delete":
            void deleteEntries(selectedIds);
            break;
        }
      });
    });
}

export function clearClipboardSelection(restorePlaceholder = true): void {
  clearDesktopSelection(selection);
  selectedRelatedEntries = [];
  clearSecretDetailReveal(CLIPBOARD_SECRET_REVEAL_BINDING_ID);
  syncListSelectionClasses();
  dom.clipboardDetail.hidden = true;
  dom.clipboardDetailRelated.innerHTML = "";
  dom.clipboardDetailDebug.hidden = true;
  dom.clipboardDetailDebug.innerHTML = "";
  dom.clipboardDetailSecretActions.hidden = true;
  dom.clipboardDetailDelete.hidden = false;
  dom.clipboardDetailPlaceholder.hidden =
    !restorePlaceholder || currentRenderedCount === 0 ? true : false;
  dom.clipboardEmpty.hidden = currentRenderedCount > 0;
}

async function loadRelatedClipboardEntries(entry: EntryRow): Promise<void> {
  const requestId = ++currentRelatedRequestId;
  selectedRelatedEntries = [];
  dom.clipboardDetailRelated.innerHTML = `<section class="related-items-section"><div class="related-items-header">Related items</div><p class="hint related-items-empty">Loading related items...</p></section>`;

  try {
    const relatedPayload = await invoke<SearchEntryResultPayload[]>(
      "get_related_entries",
      {
        entryId: entry.id,
        filters: { isNote: false },
        limit: 12,
        rankingConfig: getSettings().ranking,
      },
    );
    const related = normalizeSearchEntryResults(relatedPayload)
      .filter((result) => result.entry.collection_id === null)
      .slice(0, 6);
    const selectedId = getSelectionIds(selection)[0] ?? null;

    if (requestId !== currentRelatedRequestId || selectedId !== entry.id)
      return;

    selectedRelatedEntries = related;
    dom.clipboardDetailRelated.innerHTML = renderRelatedItemsSection(
      "Related items",
      related,
      { revealSecrets: isSecretRevealActive() },
    );
    bindRelatedClipboardClicks(related);
    applyIcons();
  } catch {
    const selectedId = getSelectionIds(selection)[0] ?? null;
    if (requestId !== currentRelatedRequestId || selectedId !== entry.id)
      return;
    selectedRelatedEntries = [];
    dom.clipboardDetailRelated.innerHTML = `<section class="related-items-section"><div class="related-items-header">Related items</div><p class="hint related-items-empty">Could not load related items.</p></section>`;
  }
}

function bindRelatedClipboardClicks(related: SearchEntryResult[]): void {
  dom.clipboardDetailRelated
    .querySelectorAll<HTMLElement>("[data-entry-id]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.entryId;
        const next =
          related.find((result) => result.entry.id === id)?.entry ?? null;
        if (next) selectEntry(next);
      });
    });
}

export async function deleteSelectedClipboardItem(): Promise<void> {
  const ids = getSelectionIds(selection);
  if (ids.length === 0) return;
  await deleteEntries(ids);
}

async function deleteEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await invoke("db_delete_entries", { ids });
  clearClipboardSelection();
  await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
  await emit("entries-changed");
  showToast(
    ids.length === 1 ? "Deleted" : `${ids.length} items deleted`,
    "success",
    1200,
  );
}

async function moveSelection(
  ids: string[],
  collectionId: string | null,
  successMessage: string,
): Promise<void> {
  if (ids.length === 0) return;
  await moveEntriesToCollection(ids, collectionId);
  clearClipboardSelection();
  await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
  await emit("entries-changed");
  showToast(successMessage, "success", 1200);
}

async function copySelection(
  ids: string[],
  collectionId: string | null,
  successMessage: string,
): Promise<void> {
  if (ids.length === 0) return;
  await copyEntriesToCollection(ids, collectionId);
  await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
  await emit("entries-changed");
  showToast(successMessage, "success", 1200);
}

async function setSecretVerdict(
  ids: string[],
  verdict: "likely_secret" | "not_secret",
): Promise<void> {
  if (ids.length === 0) return;
  await invoke("db_set_secret_verdict_bulk", {
    ids,
    secretVerdict: verdict,
    secretType: "unknown",
    secretSource: "manual",
  });
  await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
  await emit("entries-changed");
  showToast(
    verdict === "not_secret" ? "Marked not secret" : "Marked as secret",
    "success",
    1200,
  );
}

async function setPinned(ids: string[], pinned: boolean): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    await invoke("db_set_entry_pinned", { id, pinned });
  }
  await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
  await emit("entries-changed");
  showToast(
    pinned
      ? ids.length === 1 ? "Clip pinned" : `${ids.length} clips pinned`
      : ids.length === 1 ? "Clip unpinned" : `${ids.length} clips unpinned`,
    "success",
    1200,
  );
}

function renderBadgeHtml(entry: EntryRow): string {
  return renderEntryBadges(entry, { includePinned: true });
}

function renderDetailBadgeHtml(entry: EntryRow): string {
  return renderEntryBadges(entry, {
    includePinned: true,
    includeScoreHint: true,
  });
}

async function handleBadgeRemoveClick(btn: HTMLElement): Promise<void> {
  const entryId = btn.dataset.entryId;
  const tagId = btn.dataset.tagId;
  if (!entryId || !tagId) return;

  try {
    await invoke("db_remove_entry_tag", { id: entryId, tagId });
    showToast("Tag removed", "success", 1200);
    await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
    await emit("entries-changed");
  } catch {
    showToast("Failed to remove tag", "error");
  }
}

function setupBadgeRemoveDelegation(): void {
  dom.clipboardList.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>(
      ".badge-remove-btn",
    );
    if (!btn) return;
    event.stopPropagation();
    void handleBadgeRemoveClick(btn);
  });

  dom.clipboardDetailMeta.addEventListener("click", (event) => {
    const graphFocusBtn = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-detail-graph-focus-entry-id]",
    );
    if (graphFocusBtn) {
      event.stopPropagation();
      const entryId = graphFocusBtn.dataset.detailGraphFocusEntryId;
      if (entryId) options.focusGraphEntry?.(entryId);
      return;
    }

    const graphFilterBtn = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-detail-graph-filter-entry-id]",
    );
    if (graphFilterBtn) {
      event.stopPropagation();
      const entryId = graphFilterBtn.dataset.detailGraphFilterEntryId;
      if (entryId) options.applyRelatedToFilter?.(entryId);
      return;
    }

    const btn = (event.target as HTMLElement).closest<HTMLElement>(
      ".badge-remove-btn",
    );
    if (!btn) return;
    event.stopPropagation();
    void handleBadgeRemoveClick(btn);
  });
}
