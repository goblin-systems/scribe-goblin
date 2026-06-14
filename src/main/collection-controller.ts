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
  EntryTagRecord,
  ProcessingDiagnostics,
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
import { matchesShortcut } from "../shortcuts";
import { debugLog, isDebugLoggingEnabled } from "../logger";
import {
  enrichEntry,
  normalizeEnrichmentResult,
  summarizeEntry,
} from "../enrichment";
import { scan } from "../secret-detection/index";
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
  canManuallyReorderCollectionEntries,
  copyEntriesToCollection,
  getAdjacentSelectedEntryId,
  getCollectionIcon,
  getNextChecklistCompletedState,
  isFilterCollection,
  isChecklistCollection,
  listCollectionEntries,
  moveEntriesToCollection,
  NOTES_COLLECTION_ID,
  reorderCollectionEntry,
  sortEntriesForCollection,
} from "./collections";
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

const COLLECTION_LIMIT = 200;
const NOTE_SECRET_REVEAL_BINDING_ID = "note-detail";

interface CollectionControllerOptions {
  getCollections: () => CollectionRow[];
  requestCreateCollection: (
    entryIds?: string[],
  ) => Promise<CollectionRow | null>;
  refreshCollections: () => Promise<void>;
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
let options: CollectionControllerOptions;
let activeCollectionId: string | null = null;
let currentSearchQuery = "";
let lastResults: SearchEntryResult[] = [];
let currentRelatedRequestId = 0;
let unsubscribeSecretReveal: (() => void) | null = null;
let selectedRelatedEntries: SearchEntryResult[] = [];
let contextMenuHandle: ContextMenuHandle | null = null;
let badgeModal: AddBadgeModalController;
let pointerReorderListenersBound = false;
let suppressNextListClick = false;
let unregisterContextMenuCloser: (() => void) | null = null;

interface PointerReorderState {
  pointerId: number;
  entryId: string;
  startX: number;
  startY: number;
  active: boolean;
  targetEntryId: string | null;
  position: "before" | "after" | null;
}

let pointerReorderState: PointerReorderState | null = null;

const selection = createSelectionState();

type SearchUiState = "idle" | "loading" | "error";

export function initCollectionController(
  d: ScribeDom,
  settingsGetter: () => Settings,
  controllerOptions: CollectionControllerOptions,
): void {
  dom = d;
  getSettings = settingsGetter;
  options = controllerOptions;

  unregisterContextMenuCloser?.();
  unregisterContextMenuCloser = registerContextMenuCloser(() => {
    contextMenuHandle?.close();
  });

  dom.notesList.addEventListener("contextmenu", () => {
    dismissOpenContextMenus();
  });

  unsubscribeSecretReveal?.();
  unsubscribeSecretReveal = subscribeSecretReveal(() => {
    refreshSecretPreviews();
  });
  bindPointerReorderListeners();

  setupBadgeRemoveDelegation();
  dom.notesBadgeFilterBtn.addEventListener("click", (e: MouseEvent) => {
    void handleBadgeFilterClick(dom.notesBadgeFilterBtn, dom.searchInput, e);
  });
  badgeModal = initAddBadgeModal(dom, async ({ ids, badges, color }) => {
    try {
      for (const badge of badges) {
        await invoke("db_add_manual_badge_bulk", { ids, badge, color });
      }
      await loadActiveCollection(dom.searchInput.value.trim() || undefined);
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

export function getActiveCollectionId(): string | null {
  return activeCollectionId;
}

export function getSelectedCollectionEntryIds(): string[] {
  return getSelectionIds(selection);
}

export function moveCollectionSelection(delta: -1 | 1): boolean {
  const nextId = getAdjacentSelectedEntryId(
    allEntries,
    getSelectionIds(selection),
    delta,
  );
  if (!nextId) return false;
  const nextEntry = allEntries.find((entry) => entry.id === nextId) ?? null;
  if (!nextEntry) return false;
  selectEntry(nextEntry);
  return true;
}

export async function handleCollectionReorderKeydown(
  event: KeyboardEvent,
): Promise<boolean> {
  if (event.defaultPrevented) return false;
  const moveUp = matchesShortcut("collection.reorderUp", {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  });
  const moveDown = matchesShortcut("collection.reorderDown", {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  });
  if (!moveUp && !moveDown) return false;
  if (isReorderInteractiveTarget(event.target)) return false;

  const activeCollection = getActiveCollection();
  if (!activeCollection || currentSearchQuery.trim().length > 0) return false;

  const selectedIds = getSelectionIds(selection);
  if (selectedIds.length !== 1) return false;

  const currentIndex = allEntries.findIndex((entry) => entry.id === selectedIds[0]);
  if (currentIndex === -1) return false;

  const direction = moveUp ? -1 : 1;
  const source = allEntries[currentIndex];
  let targetIndex = currentIndex + direction;
  while (targetIndex >= 0 && targetIndex < allEntries.length) {
    const target = allEntries[targetIndex];
    const capability = canManuallyReorderCollectionEntries({
      collection: activeCollection,
      searchQuery: currentSearchQuery,
      selectedIds,
      entry: source,
      target,
    });
    if (capability.enabled) {
      event.preventDefault();
      await performCollectionReorder(source.id, target.id, direction < 0 ? "before" : "after");
      return true;
    }
    targetIndex += direction;
  }

  return false;
}

export async function handleCollectionSpaceKeydown(
  event: KeyboardEvent,
): Promise<boolean> {
  if (!matchesShortcut("checklist.toggleSelected", {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  })) return false;
  if (event.defaultPrevented) return false;
  if (!(event.target instanceof HTMLElement)) return false;
  const interactiveAncestor = event.target.closest(
    "input, textarea, select, button, [contenteditable='true']",
  );
  if (
    event.target.isContentEditable ||
    interactiveAncestor !== null
  ) {
    return false;
  }

  const activeCollection = getActiveCollection();
  if (!activeCollection || !isChecklistCollection(activeCollection)) return false;

  const selectedEntries = getSelectedEntries();
  const nextCompleted = getNextChecklistCompletedState(selectedEntries);
  if (nextCompleted === null) return false;

  event.preventDefault();
  await toggleChecklistEntries(selectedEntries, nextCompleted);
  return true;
}

export async function setActiveCollection(
  collectionId: string,
  search?: string,
): Promise<void> {
  activeCollectionId = collectionId;
  clearCollectionSelection();
  await loadActiveCollection(search);
}

export async function loadActiveCollection(search?: string): Promise<void> {
  const collection = getActiveCollection();
  if (!collection) {
    renderList([]);
    setCollectionUiState("idle", "", 0);
    return;
  }

  currentSearchQuery = search?.trim() ?? "";
  setCollectionUiState("loading", currentSearchQuery);

  try {
    if (currentSearchQuery.length === 0 && !isFilterCollection(collection)) {
      allEntries = sortEntriesForCollection(
        await listCollectionEntries(collection.id, COLLECTION_LIMIT),
        collection,
      );
      lastResults = allEntries.map((entry, index) => ({
        entry,
        rank: allEntries.length - index,
        match_type: "filters_only",
        match_reasons: [],
        matched_terms: [],
        matched_tags: [],
        diagnostics: {
          query_text: null,
          fts_query: null,
          applied_filters: [`collection_id:${collection.id}`],
          bm25: null,
          search_mode: "keyword",
          cosine_similarity: null,
          semantic_fallback_reason: null,
          keyword_rank: null,
          semantic_rank: null,
          keyword_weight: null,
          semantic_weight: null,
          keyword_rrf_score: null,
          semantic_rrf_score: null,
          recency_max_boost: null,
          rrf_k: null,
          recency_boost: null,
          fused_score: null,
        },
      }));
    } else {
      const { query, filters } = parseCollectionSearchInput(
        currentSearchQuery,
        isFilterCollection(collection) ? null : collection.id,
      );
      const results = await searchEntries(
        { query, filters, limit: COLLECTION_LIMIT },
        getSettings(),
      );
      lastResults = results;
      allEntries = sortEntriesForCollection(
        results.map((result) => result.entry),
        collection,
      );
    }
    renderList(allEntries);
    setCollectionUiState("idle", currentSearchQuery, allEntries.length);
    options.refreshGraph?.();
  } catch (err) {
    console.error("Failed to load collection entries:", err);
    renderList([]);
    setCollectionUiState("error", currentSearchQuery, 0, err);
  }
}

export function handleCollectionSearchInput(query: string): void {
  dom.searchClearBtn.hidden = query.length === 0;
  syncFilterButtonState(dom.notesBadgeFilterBtn, query);

  if (searchDebounce !== null) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchDebounce = null;
    void loadActiveCollection(query.trim() || undefined);
  }, 300);
}

export function syncFilterButtonState(btn: HTMLElement, query: string): void {
  const hasTagFilter = /tag:\S+|label:\S+/.test(query);
  btn.classList.toggle("is-active", hasTagFilter);
}

export function parseCollectionSearchInput(
  rawQuery: string,
  collectionId: string | null,
): { query: string | null; filters: SearchFilters } {
  const filters: SearchFilters = collectionId ? { collection_id: collectionId } : {};
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

function renderList(entries: EntryRow[]): void {
  currentRenderedCount = entries.length;
  dom.notesList.replaceChildren();

  const hasEntries = entries.length > 0;
  dom.notesEmpty.hidden = hasEntries;

  if (!hasEntries) {
    clearDesktopSelection(selection);
    dom.noteDetailPlaceholder.hidden = true;
    dom.noteDetail.hidden = true;
  } else if (selection.ids.size === 0) {
    dom.noteDetailPlaceholder.hidden = false;
  }

  const validIds = new Set(entries.map((entry) => entry.id));
  selection.ids.forEach((id) => {
    if (!validIds.has(id)) selection.ids.delete(id);
  });

  for (const entry of entries) {
    dom.notesList.appendChild(buildListItem(entry));
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
    clearCollectionSelection(false);
  }

  applyIcons();
}

function setCollectionUiState(
  state: SearchUiState,
  query: string,
  resultCount = 0,
  error?: unknown,
): void {
  const collection = getActiveCollection();
  const collectionName = collection?.name ?? "Collection";
  dom.searchInput.placeholder = `Search ${collectionName.toLowerCase()}...`;

  if (state === "loading") {
    dom.notesStatusLeft.textContent = query
      ? `Searching ${collectionName.toLowerCase()} for "${query}"...`
      : `Loading ${collectionName.toLowerCase()}...`;
    dom.notesEmpty.innerHTML = `<i data-lucide="loader-circle" style="width:32px;height:32px;opacity:0.35;"></i><p class="hint">${query ? `Searching ${escapeHtml(collectionName.toLowerCase())} for <strong>${escapeHtml(query)}</strong>...` : `Loading ${escapeHtml(collectionName.toLowerCase())}...`}</p>`;
    dom.notesEmpty.hidden = false;
    renderStatusBarChips(dom.notesStatusMeta, {
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
    dom.notesStatusLeft.textContent = `${collectionName} search failed`;
    dom.notesEmpty.innerHTML = `<i data-lucide="alert-circle" style="width:32px;height:32px;opacity:0.35;"></i><p class="hint">Failed to load ${escapeHtml(collectionName.toLowerCase())}${query ? ` for <strong>${escapeHtml(query)}</strong>` : ""}.<br />${escapeHtml(message)}</p>`;
    dom.notesEmpty.hidden = false;
    renderStatusBarChips(dom.notesStatusMeta, {
      entries: allEntries,
      query,
      results: lastResults,
      settings: getSettings(),
    });
    applyIcons();
    return;
  }

  if (query) {
    dom.notesStatusLeft.textContent = renderSearchSummary(
      resultCount,
      query,
      "item",
    );
    dom.notesEmpty.innerHTML = `<i data-lucide="search-x" style="width:32px;height:32px;opacity:0.2;"></i><p class="hint">No ${escapeHtml(collectionName.toLowerCase())} items match <strong>${escapeHtml(query)}</strong>.<br />Try different keywords or filters like <code>tag:</code>, <code>source:</code>, or <code>app:</code>.</p>`;
  } else {
    dom.notesStatusLeft.textContent =
      resultCount > 0
        ? `${resultCount} item${resultCount === 1 ? "" : "s"}`
        : collectionName;
    dom.notesEmpty.innerHTML = `<i data-lucide="${escapeHtml(getCollectionIcon(collection ?? { id: "", slug: "", name: collectionName, icon: null, collection_type: "standard", kind: "user", sort_order: 0, created_at: 0, updated_at: 0 }))}" style="width:32px;height:32px;opacity:0.2;"></i><p class="hint">No items in ${escapeHtml(collectionName)} yet.<br />Use the + button to add one directly into this collection.</p>`;
  }

  renderStatusBarChips(dom.notesStatusMeta, {
    entries: allEntries,
    query,
    results: lastResults,
    settings: getSettings(),
  });
  applyIcons();
}

function buildListItem(entry: EntryRow): HTMLElement {
  const activeCollection = getActiveCollection();
  const checklistMode = Boolean(
    activeCollection && isChecklistCollection(activeCollection),
  );
  const item = document.createElement("div");
  item.className = `note-item${hasSelection(selection, entry.id) ? " is-selected" : ""}${checklistMode ? " is-checklist" : ""}${checklistMode && entry.checklist_completed ? " is-completed" : ""}`;
  item.dataset.id = entry.id;
  const reorderEnabled = currentSearchQuery.length === 0;
  item.draggable = false;
  item.dataset.reorderEnabled = reorderEnabled ? "true" : "false";

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

  const checkboxHtml = checklistMode
    ? `<input class="checklist-item-checkbox" type="checkbox" ${entry.checklist_completed ? "checked" : ""} aria-label="Mark item ${entry.checklist_completed ? "incomplete" : "complete"}" />`
    : "";
  const graphActionsHtml = `<div class="note-item-graph-actions">
      <button class="note-item-graph-eye icon-btn" type="button" data-graph-focus-entry-id="${escapeHtml(entry.id)}" aria-label="Center item in graph" title="Center in graph"><i data-lucide="locate-fixed"></i></button>
      <button class="note-item-graph-eye icon-btn" type="button" data-graph-filter-entry-id="${escapeHtml(entry.id)}" aria-label="Focus graph on related items" title="Focus graph"><i data-lucide="eye"></i></button>
    </div>`;

  item.innerHTML = `
    <div class="note-item-main">
      ${checkboxHtml}
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

  const checkbox = item.querySelector<HTMLInputElement>(".checklist-item-checkbox");
  checkbox?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  checkbox?.addEventListener("change", () => {
    void toggleChecklistCompleted(entry.id, checkbox.checked);
  });

  item.addEventListener("click", (event) => {
    if (suppressNextListClick) {
      suppressNextListClick = false;
      event.preventDefault();
      return;
    }
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

  item.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (isReorderInteractiveTarget(event.target)) return;
    if (!reorderEnabled) return;
    if (!getActiveCollection()) return;
    pointerReorderState = {
      pointerId: event.pointerId,
      entryId: entry.id,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetEntryId: null,
      position: null,
    };
  });

  item.addEventListener("contextmenu", () => {
    prepareContextSelection(selection, entry.id);
    syncListSelectionClasses();
    setupContextMenu();
    if (selection.ids.size > 1) renderBulkSelection();
    else selectEntry(entry);
  });

  item.addEventListener("dragstart", (event) => {
    if (!item.draggable) {
      event.preventDefault();
      return;
    }
    selection.ids = new Set([entry.id]);
    selection.anchorId = entry.id;
    syncListSelectionClasses();
    dom.notesList.dataset.draggingEntryId = entry.id;
    item.classList.add("is-dragging");
    selectEntry(entry);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", entry.id);
    }
  });

  item.addEventListener("dragend", () => {
    item.classList.remove("is-dragging");
    clearReorderDropIndicators();
  });

  item.addEventListener("dragover", (event) => {
    const draggingId = dom.notesList.dataset.draggingEntryId;
    if (!draggingId || draggingId === entry.id) return;
    const source = allEntries.find((candidate) => candidate.id === draggingId);
    if (!source) return;
    const capability = canManuallyReorderCollectionEntries({
      collection: activeCollection,
      searchQuery: currentSearchQuery,
      selectedIds: getSelectionIds(selection),
      entry: source,
      target: entry,
    });
    if (!capability.enabled) return;
    event.preventDefault();
    const position = dragPositionForEvent(item, event);
    applyDropIndicator(item, position);
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });

  item.addEventListener("dragenter", (event) => {
    const draggingId = dom.notesList.dataset.draggingEntryId;
    if (!draggingId || draggingId === entry.id) return;
    dom.notesList.dataset.draggingEntryId = draggingId;
  });

  item.addEventListener("dragleave", (event) => {
    if (!item.contains(event.relatedTarget as Node | null)) {
      clearDropIndicator(item);
    }
  });

  item.addEventListener("drop", (event) => {
    const draggingId = dom.notesList.dataset.draggingEntryId;
    clearDropIndicator(item);
    if (!draggingId || draggingId === entry.id) return;
    const source = allEntries.find((candidate) => candidate.id === draggingId);
    if (!source) return;
    const capability = canManuallyReorderCollectionEntries({
      collection: activeCollection,
      searchQuery: currentSearchQuery,
      selectedIds: getSelectionIds(selection),
      entry: source,
      target: entry,
    });
    if (!capability.enabled) return;
    event.preventDefault();
    const position = dragPositionForEvent(item, event);
    void performCollectionReorder(source.id, entry.id, position);
  });

  return item;
}

function isReorderInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest("input, textarea, select, button, [contenteditable='true']"),
  );
}

function dragPositionForEvent(
  item: HTMLElement,
  event: DragEvent,
): "before" | "after" {
  const rect = item.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function clearDropIndicator(item: HTMLElement): void {
  item.classList.remove("is-drop-before", "is-drop-after");
}

function clearReorderDropIndicators(options?: {
  preserveDraggingEntryId?: boolean;
}): void {
  dom.notesList
    .querySelectorAll<HTMLElement>(".note-item.is-drop-before, .note-item.is-drop-after")
    .forEach((item) => clearDropIndicator(item));
  if (!options?.preserveDraggingEntryId) {
    delete dom.notesList.dataset.draggingEntryId;
  }
}

function bindPointerReorderListeners(): void {
  if (pointerReorderListenersBound) return;
  pointerReorderListenersBound = true;
  window.addEventListener("pointermove", handlePointerReorderMove);
  window.addEventListener("pointerup", handlePointerReorderEnd);
  window.addEventListener("pointercancel", handlePointerReorderEnd);
}

function handlePointerReorderMove(event: PointerEvent): void {
  const state = pointerReorderState;
  if (!state || state.pointerId !== event.pointerId) return;

  if (!state.active) {
    const distance = Math.hypot(
      event.clientX - state.startX,
      event.clientY - state.startY,
    );
    if (distance < 6) return;

    const source = allEntries.find((entry) => entry.id === state.entryId);
    const sourceItem = dom.notesList.querySelector<HTMLElement>(
      `.note-item[data-id="${CSS.escape(state.entryId)}"]`,
    );
    if (!source || !sourceItem || !getActiveCollection()) {
      clearPointerReorderState();
      return;
    }

    selection.ids = new Set([state.entryId]);
    selection.anchorId = state.entryId;
    syncListSelectionClasses();
    selectEntry(source);
    dom.notesList.dataset.draggingEntryId = state.entryId;
    sourceItem.classList.add("is-dragging");
    state.active = true;
  }

  event.preventDefault();
  updatePointerReorderTarget(event.clientX, event.clientY);
}

function updatePointerReorderTarget(clientX: number, clientY: number): void {
  const state = pointerReorderState;
  if (!state?.active) return;

  state.targetEntryId = null;
  state.position = null;
  clearReorderDropIndicators({ preserveDraggingEntryId: true });

  const source = allEntries.find((entry) => entry.id === state.entryId);
  if (!source) return;

  const hovered = document.elementFromPoint(clientX, clientY);
  if (!(hovered instanceof HTMLElement)) return;

  const targetItem = hovered.closest<HTMLElement>(".note-item");
  const targetEntryId = targetItem?.dataset.id;
  if (!targetItem || !targetEntryId || targetEntryId === state.entryId) return;

  const target = allEntries.find((entry) => entry.id === targetEntryId);
  const collection = getActiveCollection();
  if (!target || !collection) return;

  const capability = canManuallyReorderCollectionEntries({
    collection,
    searchQuery: currentSearchQuery,
    selectedIds: [state.entryId],
    entry: source,
    target,
  });
  if (!capability.enabled) return;

  const position = clientY < targetItem.getBoundingClientRect().top + targetItem.getBoundingClientRect().height / 2
    ? "before"
    : "after";
  state.targetEntryId = targetEntryId;
  state.position = position;
  applyDropIndicator(targetItem, position);
}

function handlePointerReorderEnd(event: PointerEvent): void {
  const state = pointerReorderState;
  if (!state || state.pointerId !== event.pointerId) return;

  const wasActive = state.active;
  const entryId = state.entryId;
  const targetEntryId = state.targetEntryId;
  const position = state.position;

  clearPointerReorderState();

  if (!wasActive) return;

  suppressNextListClick = true;
  window.setTimeout(() => {
    suppressNextListClick = false;
  }, 0);

  if (!targetEntryId || !position) return;
  void performCollectionReorder(entryId, targetEntryId, position);
}

function clearPointerReorderState(): void {
  const entryId = pointerReorderState?.entryId;
  if (entryId) {
    dom.notesList
      .querySelector<HTMLElement>(`.note-item[data-id="${CSS.escape(entryId)}"]`)
      ?.classList.remove("is-dragging");
  }
  pointerReorderState = null;
  clearReorderDropIndicators();
}

function applyDropIndicator(item: HTMLElement, position: "before" | "after"): void {
  clearReorderDropIndicators({ preserveDraggingEntryId: true });
  item.classList.add(position === "before" ? "is-drop-before" : "is-drop-after");
}

async function performCollectionReorder(
  entryId: string,
  targetEntryId: string,
  position: "before" | "after",
): Promise<void> {
  const collection = getActiveCollection();
  if (!collection) return;
  await reorderCollectionEntry({
    collectionId: collection.id,
    entryId,
    targetEntryId,
    position,
  });
  dom.notesList.dataset.draggingEntryId = "";
  await loadActiveCollection();
  selection.ids = new Set([entryId]);
  selection.anchorId = entryId;
  syncListSelectionClasses();
  const selected = allEntries.find((entry) => entry.id === entryId);
  if (selected) selectEntry(selected);
}

function syncListSelectionClasses(): void {
  dom.notesList.querySelectorAll<HTMLElement>(".note-item").forEach((item) => {
    item.classList.toggle(
      "is-selected",
      hasSelection(selection, item.dataset.id || ""),
    );
    item.draggable = false;
    item.dataset.reorderEnabled = currentSearchQuery.length === 0 ? "true" : "false";
  });
}

function getSelectedEntries(): EntryRow[] {
  const selectedIds = selection.ids;
  return allEntries.filter((entry) => selectedIds.has(entry.id));
}

function getContextMenuItems(): ContextMenuItem[] {
  const selectedEntries = getSelectedEntries();
  const selectedIds = selectedEntries.map((entry) => entry.id);
  const activeCollection = getActiveCollection();
  const allSecret =
    selectedEntries.length > 0 &&
    selectedEntries.every(
      (entry) => entry.secret_verdict && entry.secret_verdict !== "not_secret",
    );

  const moveItems: ContextMenuItem[] = options
    .getCollections()
    .map((collection) => ({
      id: `move-${collection.id}`,
      label: collection.name,
      icon: getCollectionIcon(collection),
      disabled: activeCollectionId === collection.id,
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
      onSelect: async () => {
        await moveSelection(selectedIds, null, "Items moved out of collection");
      },
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

  const checklistActions: ContextMenuItem[] = [];

  if (activeCollection && isChecklistCollection(activeCollection)) {
    checklistActions.push({
      id: "duplicate-checklist-items",
      label:
        selectedIds.length === 1 ? "Duplicate checklist item" : "Duplicate checklist items",
      icon: "copy-plus",
      onSelect: async () => {
        await copySelection(
          selectedIds,
          activeCollection.id,
          `${selectedIds.length === 1 ? "Checklist item" : "Checklist items"} duplicated`,
        );
      },
    });
  }

  const items: ContextMenuItem[] = [
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
  ];

  if (checklistActions.length > 0) {
    items.push(...checklistActions);
  }

  items.push(
    { divider: true },
    {
      id: "delete",
      label: "Delete",
      icon: "trash-2",
      onSelect: async () => {
        await deleteEntries(selectedIds);
      },
    },
  );

  return items;
}

function setupContextMenu(): void {
  contextMenuHandle?.destroy();
  contextMenuHandle = bindContextMenu({
    target: dom.notesList,
    items: getContextMenuItems(),
  });
}

function refreshSecretPreviews(): void {
  const entriesById = new Map(allEntries.map((entry) => [entry.id, entry]));
  const revealSecrets = isSecretRevealActive();

  dom.notesList.querySelectorAll<HTMLElement>(".note-item").forEach((item) => {
    const entryId = item.dataset.id;
    if (!entryId) return;

    const entry = entriesById.get(entryId);
    if (!entry || !isSecretEntry(entry)) return;

    const preview = item.querySelector<HTMLElement>(".note-preview");
    if (!preview) return;

    const result =
      lastResults.find((candidate) => candidate.entry.id === entry.id) ?? null;
    preview.innerHTML =
      currentSearchQuery && result
        ? buildSearchHighlightedPreview(entry, result, { revealSecrets })
        : buildDisplayEntryPreview(entry, { revealSecrets });
  });

  if (selectedRelatedEntries.length > 0) {
    dom.noteDetailRelated.innerHTML = renderRelatedItemsSection(
      "Related items",
      selectedRelatedEntries,
      { revealSecrets },
    );
    bindRelatedEntriesClicks(selectedRelatedEntries);
  }
}

function selectEntry(entry: EntryRow): void {
  selection.ids = new Set([entry.id]);
  selection.anchorId = entry.id;
  syncListSelectionClasses();
  void loadRelatedEntries(entry);

  const debugEnabled = isDebugLoggingEnabled();
  const isSecret =
    entry.secret_verdict && entry.secret_verdict !== "not_secret";
  const result =
    lastResults.find((candidate) => candidate.entry.id === entry.id) ?? null;

  if (isSecret) {
    bindSecretDetailReveal({
      bindingId: NOTE_SECRET_REVEAL_BINDING_ID,
      container: dom.noteDetailContent,
      content: entry.content,
    });
  } else {
    clearSecretDetailReveal(NOTE_SECRET_REVEAL_BINDING_ID);
    const attachmentContent = renderEntryDetailContent(entry);
    if (attachmentContent) {
      dom.noteDetailContent.innerHTML = attachmentContent;
    } else {
      const detailHtml =
        currentSearchQuery && result
          ? renderEntryDetailText(entry, result)
          : null;
      if (detailHtml) dom.noteDetailContent.innerHTML = detailHtml;
      else dom.noteDetailContent.textContent = entry.content;
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

  dom.noteDetailMeta.innerHTML = `
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

  dom.noteDetailDebug.hidden = !debugEnabled;
  dom.noteDetailDebug.innerHTML = debugSections.join("");

  if (debugEnabled) {
    hydrateEmbeddingDebugSection(entry);
  }

  if (entry.secret_verdict && entry.secret_verdict !== "not_secret") {
    const verdictLabel =
      entry.secret_verdict === "secret"
        ? "🔴 Secret Detected"
        : "🟡 Likely Secret";
    const typeLabel = entry.secret_type || "unknown";
    dom.noteDetailSecretActions.innerHTML = `
      <div class="secret-banner">
        <span style="font-weight:600;">${verdictLabel}</span>
        <span class="hint">(${escapeHtml(typeLabel)} · via ${escapeHtml(entry.secret_source || "unknown")})</span>
      </div>
    `;
    dom.noteDetailSecretActions.hidden = false;
  } else {
    dom.noteDetailSecretActions.hidden = true;
  }

  dom.noteDetail.hidden = false;
  dom.noteDetailPlaceholder.hidden = true;
  dom.noteDetailDelete.dataset.id = entry.id;
  dom.noteDetailDelete.hidden = false;
  const detailTitle = dom.noteDetail.querySelector<HTMLHeadingElement>(
    ".note-detail-header h3",
  );
  if (detailTitle)
    detailTitle.textContent = getActiveCollection()?.name ?? "Collection Item";
  applyIcons();
}

function renderBulkSelection(): void {
  const selectedIds = getSelectionIds(selection);
  const count = selectedIds.length;
  clearSecretDetailReveal(NOTE_SECRET_REVEAL_BINDING_ID);
  selectedRelatedEntries = [];

  dom.noteDetail.hidden = false;
  dom.noteDetailPlaceholder.hidden = true;
  dom.noteDetailDelete.hidden = true;
  dom.noteDetailRelated.innerHTML = "";
  dom.noteDetailDebug.hidden = true;
  dom.noteDetailDebug.innerHTML = "";
  dom.noteDetailMeta.innerHTML = `<div class="hint">${count} selected</div>`;
  dom.noteDetailSecretActions.hidden = false;
  dom.noteDetailSecretActions.innerHTML = `
    <div class="bulk-actions-card">
      <div class="bulk-actions-title">${count} items selected</div>
      <div class="bulk-actions-row">
        <button class="secondary-btn slim-btn" type="button" data-bulk-action="add-badge">Add badge</button>
        <button class="secondary-btn slim-btn" type="button" data-bulk-action="mark-secret">Mark secret</button>
        <button class="secondary-btn slim-btn" type="button" data-bulk-action="mark-not-secret">Mark not secret</button>
        <button class="secondary-btn slim-btn" type="button" data-bulk-action="move-notes">Move to Notes</button>
        <button class="secondary-btn slim-btn" type="button" data-bulk-action="delete">Delete</button>
      </div>
    </div>
  `;
  dom.noteDetailContent.innerHTML = `<p class="hint">Use bulk actions here or right-click the selection for the full move menu.</p>`;
  const detailTitle = dom.noteDetail.querySelector<HTMLHeadingElement>(
    ".note-detail-header h3",
  );
  if (detailTitle) detailTitle.textContent = `${count} Selected`;

  dom.noteDetailSecretActions
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
          case "move-notes":
            void moveSelection(
              selectedIds,
              NOTES_COLLECTION_ID,
              "Items moved to Notes",
            );
            break;
          case "delete":
            void deleteEntries(selectedIds);
            break;
        }
      });
    });
}

export function clearCollectionSelection(restorePlaceholder = true): void {
  clearDesktopSelection(selection);
  selectedRelatedEntries = [];
  clearSecretDetailReveal(NOTE_SECRET_REVEAL_BINDING_ID);
  syncListSelectionClasses();
  dom.noteDetail.hidden = true;
  dom.noteDetailRelated.innerHTML = "";
  dom.noteDetailDebug.hidden = true;
  dom.noteDetailDebug.innerHTML = "";
  dom.noteDetailSecretActions.hidden = true;
  dom.noteDetailDelete.hidden = false;
  dom.noteDetailPlaceholder.hidden =
    !restorePlaceholder || currentRenderedCount === 0 ? true : false;
  dom.notesEmpty.hidden = currentRenderedCount > 0;
}

async function loadRelatedEntries(entry: EntryRow): Promise<void> {
  const requestId = ++currentRelatedRequestId;
  selectedRelatedEntries = [];
  dom.noteDetailRelated.innerHTML = `<section class="related-items-section"><div class="related-items-header">Related items</div><p class="hint related-items-empty">Loading related items...</p></section>`;

  try {
    const relatedPayload = await invoke<SearchEntryResultPayload[]>(
      "get_related_entries",
      {
        entryId: entry.id,
        filters: { collectionId: activeCollectionId },
        limit: 6,
        rankingConfig: getSettings().ranking,
      },
    );
    const related = normalizeSearchEntryResults(relatedPayload);
    const selectedId = getSelectionIds(selection)[0] ?? null;

    if (requestId !== currentRelatedRequestId || selectedId !== entry.id)
      return;

    selectedRelatedEntries = related;
    dom.noteDetailRelated.innerHTML = renderRelatedItemsSection(
      "Related items",
      related,
      { revealSecrets: isSecretRevealActive() },
    );
    bindRelatedEntriesClicks(related);
    applyIcons();
  } catch {
    const selectedId = getSelectionIds(selection)[0] ?? null;
    if (requestId !== currentRelatedRequestId || selectedId !== entry.id)
      return;
    selectedRelatedEntries = [];
    dom.noteDetailRelated.innerHTML = `<section class="related-items-section"><div class="related-items-header">Related items</div><p class="hint related-items-empty">Could not load related items.</p></section>`;
  }
}

function bindRelatedEntriesClicks(related: SearchEntryResult[]): void {
  dom.noteDetailRelated
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

export async function addNote(
  content: string,
  source: "manual" | "clipboard",
  html_content: string | null = null,
  sourceApp: string | null = null,
  targetCollectionId?: string | null,
): Promise<string> {
  const id = await invoke<string>("db_add_entry", {
    content,
    htmlContent: html_content,
    source,
    sourceApp,
    createdAt: Date.now(),
  });

  const collectionId =
    targetCollectionId ?? activeCollectionId ?? NOTES_COLLECTION_ID;
  await moveEntriesToCollection([id], collectionId);

  await loadActiveCollection(dom.searchInput.value.trim() || undefined);
  await emit("entries-changed");
  void processNoteBackground(id, content);
  return id;
}

export async function deleteSelectedCollectionEntries(): Promise<void> {
  const ids = getSelectionIds(selection);
  if (ids.length === 0) return;
  await deleteEntries(ids);
}

async function deleteEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await invoke("db_delete_entries", { ids });
  clearCollectionSelection();
  await loadActiveCollection(dom.searchInput.value.trim() || undefined);
  await emit("entries-changed");
  showToast(
    ids.length === 1 ? "Item deleted" : `${ids.length} items deleted`,
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
  clearCollectionSelection();
  await loadActiveCollection(dom.searchInput.value.trim() || undefined);
  await emit("entries-changed");
  showToast(successMessage, "success", 1200);
}

async function toggleChecklistCompleted(
  id: string,
  completed: boolean,
): Promise<void> {
  await invoke("db_set_entry_checklist_completed", {
    id,
    checklistCompleted: completed,
  });
  await loadActiveCollection(dom.searchInput.value.trim() || undefined);
  await emit("entries-changed");
}

async function toggleChecklistEntries(
  entries: EntryRow[],
  completed: boolean,
): Promise<void> {
  if (entries.length === 0) return;
  await Promise.all(
    entries.map((entry) =>
      invoke("db_set_entry_checklist_completed", {
        id: entry.id,
        checklistCompleted: completed,
      }),
    ),
  );
  await loadActiveCollection(dom.searchInput.value.trim() || undefined);
  await emit("entries-changed");
}

async function copySelection(
  ids: string[],
  collectionId: string | null,
  successMessage: string,
): Promise<void> {
  if (ids.length === 0) return;
  await copyEntriesToCollection(ids, collectionId);
  await loadActiveCollection(dom.searchInput.value.trim() || undefined);
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
  await loadActiveCollection(dom.searchInput.value.trim() || undefined);
  await emit("entries-changed");
  showToast(
    verdict === "not_secret" ? "Marked not secret" : "Marked as secret",
    "success",
    1200,
  );
}

export async function processNoteBackground(
  id: string,
  content: string,
): Promise<void> {
  const settings = getSettings();
  const embeddingPromise = invoke<number[]>("generate_embedding", {
    text: content,
    modelPath: settings.localEmbeddingModelPath?.trim() || null,
  }).catch((err) => {
    debugLog(`Embedding failed for entry ${id}: ${err}`, "WARN");
    return null;
  });

  const heuristicPromise = invoke<{
    matches: Array<{ label: string; reason: string }>;
  }>("heuristic_tag", { text: content }).catch((err) => {
    debugLog(`Heuristic tagging failed for entry ${id}: ${err}`, "WARN");
    return null;
  });

  const secretPromise = scan(content, undefined, {
    secretMaskerEnabled: settings.secretMaskerEnabled,
    secretMaskerModelPath: settings.secretMaskerModelPath,
    trufflehogPath: settings.trufflehogPath,
  }).catch((err) => {
    debugLog(`Secret detection failed for entry ${id}: ${err}`, "WARN");
    return null;
  });

  const summaryEnabled = shouldGenerateSummary(settings, content);
  const aiTaggingEnabled = shouldGenerateAiTags(settings);
  const enrichmentPromise = aiTaggingEnabled
    ? Promise.resolve()
        .then(() => enrichEntry(content, settings))
        .catch((err) => {
        debugLog(`Tag enrichment failed for entry ${id}: ${err}`, "WARN");
        return null;
      })
    : Promise.resolve(null);
  const summaryPromise = summaryEnabled
    ? Promise.resolve()
        .then(() => summarizeEntry(content, settings))
        .catch((err) => {
        debugLog(`Summary enrichment failed for entry ${id}: ${err}`, "WARN");
        return null;
      })
    : Promise.resolve(null);

  const [embeddingResult, heuristicResult, secretResult, enrichmentResult, summaryResult] = await Promise.all([
    embeddingPromise,
    heuristicPromise,
    secretPromise,
    enrichmentPromise,
    summaryPromise,
  ]);

  try {
    if (embeddingResult) {
      await invoke("db_update_entry_embedding", {
        id,
        embedding: JSON.stringify(embeddingResult),
      });
    }

    if (secretResult && secretResult.verdict !== "not_secret") {
      await invoke("db_update_entry_secret", {
        id,
        secretVerdict: secretResult.verdict,
        secretType: secretResult.secret_type,
        secretSource: secretResult.source,
      });
    }

    const normalizedTagEnrichment = aiTaggingEnabled && enrichmentResult
      ? normalizeEnrichmentResult(enrichmentResult)
      : { summary: "", tags: [], source: "none" as const, provider: null as string | null, model: null };
    const normalizedSummary = summaryResult
      ? normalizeEnrichmentSummary(summaryResult.summary)
      : null;

    const generatedTags: EntryTagRecord[] = [];
    const now = Date.now();
    const heuristicMatches = heuristicResult?.matches ?? [];
    for (const match of heuristicMatches) {
      generatedTags.push({
        id: crypto.randomUUID(),
        name: match.label.trim().toLowerCase(),
        source: "heuristic",
        kind: "classification",
        created_at: now,
        confidence: null,
        provider: "local-heuristic",
        model: match.reason,
        color: null,
      });
    }
    for (const tag of normalizedTagEnrichment.tags) {
      generatedTags.push({
        id: crypto.randomUUID(),
        name: tag,
        source: normalizedTagEnrichment.source === "heuristic" ? "heuristic" : "ai",
        kind: "enrichment",
        created_at: now,
        confidence: null,
        provider: normalizedTagEnrichment.provider ?? null,
        model: normalizedTagEnrichment.model ?? null,
        color: null,
      });
    }
    if (secretResult?.diagnostics.trufflehog.matched) {
      generatedTags.push({
        id: crypto.randomUUID(),
        name: (secretResult.diagnostics.trufflehog.detector ?? "trufflehog").trim().toLowerCase(),
        source: "trufflehog",
        kind: "detector",
        created_at: now,
        confidence: null,
        provider: "trufflehog",
        model: null,
        color: null,
      });
    }

    await invoke("db_update_entry_enrichment", {
      id,
      summary: normalizedSummary,
      enrichmentTags: serializeEnrichmentTags(normalizedTagEnrichment.tags),
    });
    await invoke("db_replace_generated_tags", {
      id,
      tagsJson: JSON.stringify(generatedTags),
    });

    const diagnostics: ProcessingDiagnostics = {
      version: 2,
      heuristic: heuristicResult
        ? {
            status: "completed",
            matches: heuristicMatches,
            error: null,
          }
        : {
            status: "failed",
            matches: [],
            error: "heuristic_failed",
          },
      enrichment: enrichmentResult
        ? {
            status: "completed",
            provider: normalizedTagEnrichment.provider ?? settings.enrichmentProvider,
            model: normalizedTagEnrichment.model ?? (settings.enrichmentModel || null),
            summary_present: normalizedSummary !== null,
            tags_returned: normalizedTagEnrichment.tags,
            source: normalizedTagEnrichment.source ?? "provider",
            reason: null,
            error: null,
          }
        : {
            status: aiTaggingEnabled
              ? normalizedTagEnrichment.tags.length > 0 ? "fallback" : "failed"
              : summaryEnabled ? "skipped" : "unavailable",
            provider: normalizedTagEnrichment.provider ?? (aiTaggingEnabled ? settings.enrichmentProvider : "none"),
            model: normalizedTagEnrichment.model ?? null,
            summary_present: normalizedSummary !== null,
            tags_returned: normalizedTagEnrichment.tags,
            source: normalizedTagEnrichment.source ?? (aiTaggingEnabled ? "heuristic" : "none"),
            reason: aiTaggingEnabled
              ? "provider_unavailable_or_failed"
              : summaryEnabled
                ? "tagging_disabled"
                : "enrichment_disabled",
            error: null,
          },
      secret_detection: secretResult
        ? {
            final_verdict: secretResult.verdict,
            final_type: secretResult.secret_type,
            final_source: secretResult.source,
            trufflehog: {
              status: secretResult.diagnostics.trufflehog.status,
              enabled: true,
              available: secretResult.diagnostics.trufflehog.available,
              matched: secretResult.diagnostics.trufflehog.matched,
              verified: secretResult.diagnostics.trufflehog.verified,
              detector: secretResult.diagnostics.trufflehog.detector,
              model: null,
              top_score: null,
              span_count: null,
            },
            secret_masker: {
              status: secretResult.diagnostics.secret_masker.status,
              enabled: secretResult.diagnostics.secret_masker.enabled,
              available: undefined,
              matched: secretResult.diagnostics.secret_masker.matched,
              verified: null,
              detector: null,
              model: secretResult.diagnostics.secret_masker.model,
              top_score: secretResult.diagnostics.secret_masker.top_score,
              span_count: secretResult.diagnostics.secret_masker.span_count,
            },
          }
        : {
            final_verdict: "not_secret",
            final_type: "unknown",
            final_source: "both",
            trufflehog: {
              status: "unavailable",
              enabled: true,
              available: false,
              matched: false,
              verified: null,
              detector: null,
              model: null,
              top_score: null,
              span_count: null,
            },
            secret_masker: {
              status: settings.secretMaskerEnabled ? "error" : "disabled",
              enabled: settings.secretMaskerEnabled,
              available: undefined,
              matched: false,
              verified: null,
              detector: null,
              model: settings.secretMaskerEnabled ? "distilbert-secret-masker" : null,
              top_score: null,
              span_count: null,
            },
          },
    };

    await invoke("db_update_entry_processing_diagnostics", {
      id,
      processingDiagnostics: JSON.stringify(diagnostics),
    });

    await loadActiveCollection(dom.searchInput.value.trim() || undefined);
    await emit("entries-changed");
  } catch (err) {
    debugLog(
      `Background processing DB update failed for entry ${id}: ${err}`,
      "ERROR",
    );
  }
}

const SUMMARY_MIN_LENGTH = 220;

function hasConfiguredEnrichmentProvider(settings: Settings): boolean {
  if (settings.enrichmentProvider === "none") return false;

  switch (settings.enrichmentProvider) {
    case "openai":
      return settings.providers.openai.apiKey.trim().length > 0;
    case "gemini":
      return settings.providers.gemini.apiKey.trim().length > 0;
    case "local-qwen":
      return true;
    default:
      return false;
  }
}

function shouldGenerateSummary(settings: Settings, content: string): boolean {
  return (
    settings.enrichmentSummaryEnabled &&
    settings.enrichmentProvider !== "local-qwen" &&
    content.trim().length >= SUMMARY_MIN_LENGTH &&
    hasConfiguredEnrichmentProvider(settings)
  );
}

function shouldGenerateAiTags(settings: Settings): boolean {
  return settings.enrichmentTaggingEnabled && hasConfiguredEnrichmentProvider(settings);
}

function normalizeEnrichmentSummary(summary: string): string | null {
  const trimmed = summary.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function serializeEnrichmentTags(tags: string[]): string | null {
  const normalized = tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export { normalizeEnrichmentSummary, serializeEnrichmentTags };

function renderBadgeHtml(entry: EntryRow): string {
  return renderEntryBadges(entry);
}

function renderDetailBadgeHtml(entry: EntryRow): string {
  return renderEntryBadges(entry, { includeScoreHint: true });
}

async function handleBadgeRemoveClick(btn: HTMLElement): Promise<void> {
  const entryId = btn.dataset.entryId;
  const tagId = btn.dataset.tagId;
  if (!entryId || !tagId) return;

  try {
    await invoke("db_remove_entry_tag", { id: entryId, tagId });
    showToast("Tag removed", "success", 1200);
    await loadActiveCollection(dom.searchInput.value.trim() || undefined);
    await emit("entries-changed");
  } catch {
    showToast("Failed to remove tag", "error");
  }
}

function setupBadgeRemoveDelegation(): void {
  dom.notesList.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>(
      ".badge-remove-btn",
    );
    if (!btn) return;
    event.stopPropagation();
    void handleBadgeRemoveClick(btn);
  });

  dom.noteDetailMeta.addEventListener("click", (event) => {
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

function getActiveCollection(): CollectionRow | null {
  if (!activeCollectionId) return null;
  return (
    options
      .getCollections()
      .find((collection) => collection.id === activeCollectionId) ?? null
  );
}

export async function handleBadgeFilterClick(
  btn: HTMLElement,
  input: HTMLInputElement,
  event: MouseEvent,
): Promise<void> {
  try {
    const badges = await invoke<string[]>("db_list_all_badges");
    const currentQuery = input.value.trim();
    const hasTagFilter = /tag:\S+|label:\S+/.test(currentQuery);

    const items: ContextMenuItem[] = badges.map((badge) => ({
      id: `filter-badge-${badge}`,
      label: badge,
      icon: "tag",
      onSelect: () => {
        let newQuery = currentQuery;
        if (hasTagFilter) {
          newQuery = currentQuery.replace(/(tag:\S+|label:\S+)/, `tag:${badge}`);
        } else {
          newQuery = currentQuery
            ? `${currentQuery} tag:${badge}`
            : `tag:${badge}`;
        }
        input.value = newQuery;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
    }));

    if (hasTagFilter) {
      items.unshift({
        id: "clear-badge-filter",
        label: "Clear badge filter",
        icon: "filter-x",
        onSelect: () => {
          const newQuery = currentQuery.replace(/(tag:\S+|label:\S+)/, "").trim();
          input.value = newQuery;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        },
      });
      items.push({ divider: true });
    }

    if (items.length === 0) {
      items.push({
        id: "no-badges",
        label: "No badges found",
        disabled: true,
      });
    }

    const menu = bindContextMenu({
      target: btn,
      items,
    });
    menu.open(event.clientX, event.clientY);
  } catch (err) {
    console.error("Failed to list badges:", err);
    showToast("Failed to load badges", "error");
  }
}
