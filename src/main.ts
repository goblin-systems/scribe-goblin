import {
  applyIcons,
  bindContextMenu,
  closeModal,
  createIcon,
  ICON_SET,
  openModal,
  showToast,
  type ContextMenuHandle,
  type ContextMenuItem,
} from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import {
  isRegistered,
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { createDom } from "./main/dom";
import { createProgressBar } from "./main/progress-bar";
import { setupShell } from "./main/shell-controller";
import { setupShortcutsController } from "./main/shortcuts-controller";
import { initAiModelsController } from "./main/models-controller";
import {
  populateSettingsUI,
  resetRankingSettingsUI,
  updateProviderSetupSections,
  updateEmbeddingVisibility,
  updateEnrichmentVisibility,
  updateEmbeddingModelOptions,
  updateEnrichmentModelOptions,
  scheduleAutosave,
  cancelAutosave,
  readSettingsFromForm,
  wireReembedAllButton,
} from "./main/settings-controller";
import {
  addNote,
  clearCollectionSelection,
  deleteSelectedCollectionEntries,
  getSelectedCollectionEntryIds,
  handleCollectionReorderKeydown,
  handleCollectionSearchInput,
  handleCollectionSpaceKeydown,
  initCollectionController,
  loadActiveCollection,
  moveCollectionSelection,
  processNoteBackground,
  setActiveCollection,
  syncFilterButtonState,
} from "./main/collection-controller";
import { parseBadgeInput } from "./main/add-badge-modal";
import {
  clearClipboardSelection,
  deleteSelectedClipboardItem,
  handleClipboardSearchInput,
  initClipboardController,
  loadClipboard,
} from "./main/clipboard-controller";
import { configureDebugLogging, debugLog } from "./logger";
import {
  initImportController,
  openImportModal,
} from "./main/import-controller";
import { initSecretRevealController } from "./main/secret-reveal-controller";
import {
  loadSettings,
  saveSettings,
  saveProviderModelCache,
  fingerprintApiKey,
  type Settings,
} from "./settings";
import { testEmbeddingConnection } from "./embedding";
import { resetTruffleHogCache } from "./secret-detection/trufflehog";
import type { CollectionRow, EntryRow } from "./store";
import {
  canDeleteCollection,
  canRenameCollection,
  createCollection,
  duplicateCollection,
  deleteCollection,
  getAdjacentCollectionId,
  getCollectionIcon,
  getDefaultCollectionId,
  getNextCollectionType,
  isFilterCollection,
  listCollections,
  moveEntriesToCollection,
  NOTES_COLLECTION_ID,
  reorderCollection,
  renameCollection,
  updateCollectionType,
  type ActiveView,
} from "./main/collections";
import {
  filterCollectionIconNames,
  getDefaultCreateCollectionIcon,
  getCollectionIconNames,
} from "./main/collection-icon-picker";
import type { CollectionType } from "./store";
import { shouldFocusActiveSearchInput } from "./main-keyboard";
import { appendBadgeToInputValue } from "./main/quick-add-badges";
import {
  getDefaultShortcutBinding,
  getShortcutDisplayLabel,
  matchesShortcut,
  resolveEffectiveShortcutBinding,
  toGlobalShortcutAccelerator,
  withShortcutOverride,
  type EditableShortcutId,
} from "./shortcuts";
import {
  mountCollectionGraph,
  type CollectionGraphContext,
} from "./main/collection-graph";
import {
  dismissOpenContextMenus,
  registerContextMenuCloser,
} from "./main/context-menu-registry";

// ── App state ──────────────────────────────────────────────────────────────

let currentSettings: Settings;
let previewSettings: Settings | null = null;
let collections: CollectionRow[] = [];
let activeView: ActiveView = { kind: "clipboard" };
let pendingCreateMoveIds: string[] = [];
let pendingDeleteCollectionId: string | null = null;
let pendingRenameCollectionId: string | null = null;
const QUICK_ADD_DEFAULT_BADGE_COLOR = "default";
const COLLECTION_ICON_NAMES = getCollectionIconNames(ICON_SET);
const DEFAULT_CREATE_COLLECTION_ICON = getDefaultCreateCollectionIcon(ICON_SET);

let selectedCreateCollectionIcon = DEFAULT_CREATE_COLLECTION_ICON;
let selectedCreateCollectionType: CollectionType = "standard";
  let sidebarCollectionContextMenuHandles: ContextMenuHandle[] = [];
  let draggingCollectionId: string | null = null;
let overlayShortcutBinding = "";
let unregisterSidebarContextMenuCloser: (() => void) | null = null;

function syncCreateCollectionIconPreview(
  dom: ReturnType<typeof createDom>,
): void {
  dom.createCollectionIconPreview.replaceChildren();
  dom.createCollectionIconPreviewLabel.textContent = selectedCreateCollectionIcon;
  const icon = createIcon(selectedCreateCollectionIcon);
  if (icon) dom.createCollectionIconPreview.appendChild(icon);
}

function renderCreateCollectionIconOptions(
  dom: ReturnType<typeof createDom>,
): void {
  const filteredIcons = filterCollectionIconNames(
    COLLECTION_ICON_NAMES,
    dom.createCollectionIconSearchInput.value,
  );
  const iconNames = filteredIcons.includes(selectedCreateCollectionIcon)
    ? filteredIcons
    : [selectedCreateCollectionIcon, ...filteredIcons];

  dom.createCollectionIconOptions.replaceChildren();

  if (iconNames.length === 0) {
    const empty = document.createElement("div");
    empty.className = "collection-icon-empty";
    empty.textContent = "No matches found. Keeping the current selection visible.";
    dom.createCollectionIconOptions.appendChild(empty);
  }

  for (const iconName of iconNames) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `collection-icon-option${iconName === selectedCreateCollectionIcon ? " is-selected" : ""}`;
    option.dataset.iconName = iconName;
    option.setAttribute("role", "option");
    option.setAttribute(
      "aria-selected",
      iconName === selectedCreateCollectionIcon ? "true" : "false",
    );
    option.innerHTML = `
      <span class="collection-icon-option-icon"><i data-lucide="${iconName}"></i></span>
      <span class="collection-icon-option-label">${iconName === selectedCreateCollectionIcon && !filteredIcons.includes(selectedCreateCollectionIcon) ? `${iconName} (selected)` : iconName}</span>
    `;
    option.addEventListener("click", () => {
      selectedCreateCollectionIcon = iconName;
      syncCreateCollectionIconPreview(dom);
      renderCreateCollectionIconOptions(dom);
    });
    dom.createCollectionIconOptions.appendChild(option);
  }

  dom.createCollectionIconHint.textContent = dom.createCollectionIconSearchInput
    .value.trim()
    ? filteredIcons.length > 0
      ? `${filteredIcons.length} matching icon${filteredIcons.length === 1 ? "" : "s"}.`
      : "No matches found. Keeping the current selection visible."
    : `${COLLECTION_ICON_NAMES.length} icons available.`;

  applyIcons();
}

function syncCreateCollectionTypeSelection(
  dom: ReturnType<typeof createDom>,
): void {
  dom.createCollectionTypeStandard.checked =
    selectedCreateCollectionType === "standard";
  dom.createCollectionTypeChecklist.checked =
    selectedCreateCollectionType === "checklist";
  dom.createCollectionTypeFilter.checked =
    selectedCreateCollectionType === "filter";
}

function getActiveCollectionFilterQuery(dom: ReturnType<typeof createDom>): string | null {
  const raw = dom.searchInput.value.trim();
  return raw.length > 0 ? raw : null;
}

function syncCreateCollectionTypeAvailability(dom: ReturnType<typeof createDom>): void {
  const filterQuery = getActiveCollectionFilterQuery(dom);
  const filterAvailable = Boolean(filterQuery);
  dom.createCollectionTypeFilter.disabled = !filterAvailable;

  if (!filterAvailable && selectedCreateCollectionType === "filter") {
    selectedCreateCollectionType = "standard";
    syncCreateCollectionTypeSelection(dom);
  }

  dom.createCollectionTypeHint.textContent = filterAvailable
    ? "Filter collections save the current search/filter query and reopen it when selected."
    : "Checklist collections show completion checkboxes. Filter collections are only available when an active search/filter is in place.";
}

type HotModule = {
  dispose(callback: () => void | Promise<void>): void;
};

function getImportMetaHot(): HotModule | undefined {
  return (import.meta as ImportMeta & { hot?: HotModule }).hot;
}

function getShortcutOverrides() {
  return getSettings().shortcutOverrides;
}

function getEffectiveShortcutLabel(id: Parameters<typeof getShortcutDisplayLabel>[0]): string {
  return getShortcutDisplayLabel(id, getShortcutOverrides());
}

function updateRuntimeShortcutLabels(dom: ReturnType<typeof createDom>): void {
  const newItemLabel = document.getElementById("shortcut-label-main-new-item");
  const importLabel = document.getElementById("shortcut-label-main-open-import");
  const systemQuitLabel = document.getElementById("shortcut-label-system-quit");
  const quickAddHint = document.getElementById("quick-add-shortcut-hint");

  if (newItemLabel) newItemLabel.textContent = getEffectiveShortcutLabel("main.newItem");
  if (importLabel) importLabel.textContent = getEffectiveShortcutLabel("main.openImport");
  if (systemQuitLabel) systemQuitLabel.textContent = getEffectiveShortcutLabel("system.quit");
  if (quickAddHint) {
    quickAddHint.textContent = `${getEffectiveShortcutLabel("editor.submit")} to save, ${getEffectiveShortcutLabel("editor.cancel")} to cancel.`;
  }
}

async function unregisterOverlayShortcut(binding = overlayShortcutBinding): Promise<void> {
  try {
    if (binding && await isRegistered(binding)) {
      await unregister(binding);
      debugLog(`Global shortcut ${binding} unregistered`, "INFO");
    }
  } catch (err) {
    debugLog(`Failed to unregister global shortcut: ${err}`, "ERROR");
    console.error("Failed to unregister global shortcut:", err);
  }
}

async function registerOverlayShortcut(binding: string): Promise<void> {
  await unregisterOverlayShortcut(binding);

  try {
    await register(binding, async (event) => {
      if (event.state === "Pressed") {
        debugLog(`Global shortcut ${binding} pressed`, "INFO");
        try {
          const targetAppBundleId = await invoke<string | null>("get_frontmost_app_bundle_id").catch(
            () => null,
          );
          await invoke("set_macos_accessory_activation_policy", { accessory: true }).catch(
            () => undefined,
          );
          await invoke("configure_overlay_macos_panel").catch(() => undefined);
          const [x, y] = await invoke<[number, number]>("get_cursor_position");
          debugLog(`Cursor position for overlay: ${x}, ${y}`, "INFO");
          await emit("show-overlay", { x, y, targetAppBundleId });
        } catch (err) {
          await invoke("set_macos_accessory_activation_policy", { accessory: false }).catch(
            () => undefined,
          );
          debugLog(
            `Failed to get cursor pos or emit show-overlay: ${err}`,
            "ERROR",
          );
        }
      }
    });
    overlayShortcutBinding = binding;
    debugLog(`Global shortcut ${binding} registered`, "INFO");
  } catch (err) {
    debugLog(`Failed to register global shortcut: ${err}`, "ERROR");
    throw err;
  }
}

async function applyGlobalOverlayShortcutChange(
  binding: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const previous = overlayShortcutBinding;
  try {
    if (previous && previous !== binding) {
      await unregisterOverlayShortcut(previous);
    }
    await registerOverlayShortcut(binding);
    return { ok: true };
  } catch (error) {
    try {
      if (previous && previous !== binding) {
        await registerOverlayShortcut(previous);
      }
    } catch (rollbackError) {
      console.error("Failed to rollback global shortcut:", rollbackError);
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

function getActiveSearchInput(dom: ReturnType<typeof createDom>): HTMLInputElement {
  return activeView.kind === "clipboard"
    ? dom.clipboardSearchInput
    : dom.searchInput;
}

function focusActiveSearchInput(dom: ReturnType<typeof createDom>): void {
  const input = getActiveSearchInput(dom);
  input.focus();
  input.select();
}

async function clearActiveSearch(
  dom: ReturnType<typeof createDom>,
): Promise<boolean> {
  if (activeView.kind === "clipboard") {
    const query = dom.clipboardSearchInput.value.trim();
    if (!query) return false;
    dom.clipboardSearchInput.value = "";
    dom.clipboardSearchClearBtn.hidden = true;
    syncFilterButtonState(dom.clipboardBadgeFilterBtn, "");
    await loadClipboard();
    return true;
  }

  const query = dom.searchInput.value.trim();
  if (!query) return false;
  dom.searchInput.value = "";
  dom.searchClearBtn.hidden = true;
  syncFilterButtonState(dom.notesBadgeFilterBtn, "");
  await loadActiveCollection();
  return true;
}

function getSettings(): Settings {
  return previewSettings ?? currentSettings;
}

function setSettings(next: Settings): void {
  currentSettings = next;
}

function rankingChanged(left: Settings, right: Settings): boolean {
  return (
    left.ranking.shortKeywordWeight !== right.ranking.shortKeywordWeight ||
    left.ranking.shortSemanticWeight !== right.ranking.shortSemanticWeight ||
    left.ranking.mediumKeywordWeight !== right.ranking.mediumKeywordWeight ||
    left.ranking.mediumSemanticWeight !== right.ranking.mediumSemanticWeight ||
    left.ranking.longKeywordWeight !== right.ranking.longKeywordWeight ||
    left.ranking.longSemanticWeight !== right.ranking.longSemanticWeight ||
    left.ranking.semanticRelevanceThreshold !==
      right.ranking.semanticRelevanceThreshold ||
    left.ranking.recencyBoostMax !== right.ranking.recencyBoostMax ||
    left.ranking.rrfK !== right.ranking.rrfK
  );
}

function getActiveCollection(): CollectionRow | null {
  const currentView = activeView;
  if (currentView.kind !== "collection") return null;
  return (
    collections.find(
      (collection) => collection.id === currentView.collectionId,
    ) ?? null
  );
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  // Init DB
  try {
    await invoke("db_init");
  } catch (err) {
    console.error("Failed to initialise database:", err);
    document.body.innerHTML = `<div style="padding:2rem;color:#ff6b6b;font-family:monospace;">
      Failed to initialise database: ${String(err)}
    </div>`;
    return;
  }

  currentSettings = await loadSettings();
  await configureDebugLogging(currentSettings.debugLoggingEnabled);

  unregisterSidebarContextMenuCloser?.();
  unregisterSidebarContextMenuCloser = registerContextMenuCloser(() => {
    sidebarCollectionContextMenuHandles.forEach((handle) => {
      handle.close();
    });
  });

  const dom = createDom();
  initSecretRevealController();

  const renderQuickAddBadgeSuggestions = (suggestions: string[]) => {
    dom.quickAddBadgeSuggestions.replaceChildren();
    dom.quickAddBadgeSuggestions.hidden = suggestions.length === 0;

    for (const suggestion of suggestions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quick-add-badge-suggestion";
      button.dataset.badge = suggestion;
      button.textContent = suggestion;
      dom.quickAddBadgeSuggestions.appendChild(button);
    }
  };

  const refreshQuickAddBadgeSuggestions = async () => {
    try {
      const query = dom.quickAddInput.value.trim() || null;
      const queryEmbedding = query
        ? await invoke<number[]>("generate_embedding", { text: query }).catch(() => null)
        : null;
      const suggestions = await invoke<string[]>("list_badge_suggestions", {
        query,
        queryEmbedding,
        rankingConfig: getSettings().ranking,
      });
      renderQuickAddBadgeSuggestions(suggestions);
    } catch (error) {
      console.error("Failed to load quick-add badge suggestions:", error);
      renderQuickAddBadgeSuggestions([]);
    }
  };

  const openQuickAdd = () => {
    void refreshQuickAddBadgeSuggestions();
    dom.quickAddForm.hidden = false;
    dom.quickAddInput.focus();
  };

  let shortcutsController: ReturnType<typeof setupShortcutsController>;
  shortcutsController = setupShortcutsController({
    dom,
    getShortcutOverrides,
    applyShortcutOverride: async (id: EditableShortcutId, binding: string | null) => {
      const nextOverrides = withShortcutOverride(getShortcutOverrides(), id, binding);

      if (id === "global.showOverlay") {
        const effectiveGlobalBinding = resolveEffectiveShortcutBinding(
          "global.showOverlay",
          nextOverrides,
        );
        const result = await applyGlobalOverlayShortcutChange(
          toGlobalShortcutAccelerator(effectiveGlobalBinding),
        );
        if (!result.ok) {
          return result;
        }
      }

      const nextSettings: Settings = {
        ...currentSettings,
        shortcutOverrides: nextOverrides,
      };
      await saveSettings(nextSettings);
      currentSettings = nextSettings;
      previewSettings = null;
      updateRuntimeShortcutLabels(dom);
      shortcutsController.refresh();
      return { ok: true };
    },
    resetAllEditableShortcuts: async () => {
      const result = await applyGlobalOverlayShortcutChange(
        toGlobalShortcutAccelerator(getDefaultShortcutBinding("global.showOverlay")),
      );
      if (!result.ok) return result;

      const nextSettings: Settings = {
        ...currentSettings,
        shortcutOverrides: {},
      };
      await saveSettings(nextSettings);
      currentSettings = nextSettings;
      previewSettings = null;
      updateRuntimeShortcutLabels(dom);
      shortcutsController.refresh();
      return { ok: true };
    },
  });

  const aiModelsController = initAiModelsController(dom, getSettings);
  const shell = setupShell({
    dom,
    getSettings,
    setSettings,
    onOpenQuickAdd: openQuickAdd,
    onOpenShortcutsSettings: () => shortcutsController.openShortcutsSettings(),
    onOpenAiModelsSettings: () => void aiModelsController.refresh(),
  });
  await shell.applySettingsToUI(currentSettings);
  await initImportController(dom);

  populateSettingsUI(dom, currentSettings);
  updateRuntimeShortcutLabels(dom);
  wireReembedAllButton(dom, getSettings);

  const handleRetagAll = async (btn: HTMLButtonElement) => {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Retagging…";
    const progress = createProgressBar(dom.retagProgressHost);

    try {
      const nextSettings = readSettingsFromForm(dom, currentSettings);
      await saveSettings(nextSettings);
      currentSettings = nextSettings;

      const entries = await invoke<EntryRow[]>("db_list_entries", {
        search: null,
        limit: 1000000,
      });

      progress.update(0, entries.length);
      let processed = 0;
      for (const entry of entries) {
        await processNoteBackground(entry.id, entry.content);
        processed += 1;
        progress.update(processed, entries.length);
      }

      if (activeView.kind === "clipboard") {
        await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
      } else {
        await loadActiveCollection(dom.searchInput.value.trim() || undefined);
      }

      await emit("entries-changed");
      progress.finish(`Retagged ${entries.length} items`);
      showToast(`Retagged ${entries.length} items`, "success", 1600);
      btn.textContent = "Done!";
      window.setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
        progress.reset();
      }, 2500);
    } catch (err) {
      btn.textContent = originalText;
      btn.disabled = false;
      progress.reset();
      console.error("retag_all_items failed:", err);
      showToast("Failed to retag items", "error");
    }
  };

  dom.retagAllEnrichmentBtn.addEventListener("click", async () => {
    await handleRetagAll(dom.retagAllEnrichmentBtn);
  });

  // ── Collection graph (shows when a list is open but nothing is selected)
  const openEntryByListClick = (listId: string) => (entryId: string) => {
    const list = document.getElementById(listId);
    const item = list?.querySelector<HTMLElement>(
      `.note-item[data-id="${CSS.escape(entryId)}"]`,
    );
    if (item) item.click();
  };
  const applyRelatedToFilter = (entryId: string) => {
    if (activeView.kind === "clipboard") {
      clearClipboardSelection();
      const nextQuery = `related-to:${entryId}`;
      dom.clipboardSearchInput.value = nextQuery;
      dom.clipboardSearchClearBtn.hidden = false;
      void loadClipboard(nextQuery);
      dom.clipboardSearchInput.focus();
      return;
    } else {
      clearCollectionSelection();
      const nextQuery = `related-to:${entryId}`;
      dom.searchInput.value = nextQuery;
      dom.searchClearBtn.hidden = false;
      syncFilterButtonState(dom.notesBadgeFilterBtn, nextQuery);
      void loadActiveCollection(nextQuery);
      dom.searchInput.focus();
      return;
    }
  };
  const openGraphAndCenterEntry = (entryId: string) => {
    if (activeView.kind === "clipboard") {
      clearClipboardSelection();
      void clipboardGraph.revealAndFocusEntry(entryId);
      return;
    }
    clearCollectionSelection();
    void notesGraph.revealAndFocusEntry(entryId);
  };
  const collectionGraphContext = (): CollectionGraphContext => {
    const currentView = activeView;
    const isClipboard = currentView.kind === "clipboard";
    return {
      kind: isClipboard ? "clipboard" : "collection",
      collectionId: isClipboard ? null : currentView.collectionId,
      searchQuery: isClipboard
        ? dom.clipboardSearchInput.value
        : dom.searchInput.value,
    };
  };

  const notesGraph = mountCollectionGraph({
    hostId: "notes-graph-host",
    placeholderId: "note-detail-placeholder",
    detailId: "note-detail",
    listId: "notes-list",
    getContext: collectionGraphContext,
    getSettings,
    onSelectEntry: openEntryByListClick("notes-list"),
  });
  const clipboardGraph = mountCollectionGraph({
    hostId: "clipboard-graph-host",
    placeholderId: "clipboard-detail-placeholder",
    detailId: "clipboard-detail",
    listId: "clipboard-list",
    getContext: collectionGraphContext,
    getSettings,
    onSelectEntry: openEntryByListClick("clipboard-list"),
  });

  const switchView = async (view: ActiveView) => {
    activeView = view;
    const showClipboard = view.kind === "clipboard";
    const clipboardPanel = document.getElementById(
      "view-clipboard",
    ) as HTMLElement;
    const collectionPanel = document.getElementById(
      "view-notes",
    ) as HTMLElement;
    clipboardPanel.hidden = !showClipboard;
    clipboardPanel.classList.toggle("is-active", showClipboard);
    collectionPanel.hidden = showClipboard;
    collectionPanel.classList.toggle("is-active", !showClipboard);
    dom.clipboardStatusBar.hidden = !showClipboard;
    dom.notesStatusBar.hidden = showClipboard;

    dom.sidebarNav
      .querySelectorAll<HTMLElement>(".sidebar-nav-item")
      .forEach((button) => {
        button.classList.toggle(
          "is-active",
          button.dataset.viewKind === "clipboard" && showClipboard,
        );
      });
    dom.collectionsNav
      .querySelectorAll<HTMLElement>(".sidebar-nav-item")
      .forEach((button) => {
        button.classList.toggle(
          "is-active",
          button.dataset.collectionId ===
            (view.kind === "collection" ? view.collectionId : ""),
        );
      });

    if (view.kind === "clipboard") {
      clearClipboardSelection();
      await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
      return;
    }

    const selectedCollection = collections.find(
      (collection) => collection.id === view.collectionId,
    ) ?? null;
    if (selectedCollection && isFilterCollection(selectedCollection)) {
      dom.searchInput.value = selectedCollection.filter_query?.trim() ?? "";
      dom.searchClearBtn.hidden = dom.searchInput.value.length === 0;
    }

    await setActiveCollection(
      view.collectionId,
      dom.searchInput.value.trim() || undefined,
    );
  };

  const renderSidebar = () => {
    sidebarCollectionContextMenuHandles.forEach((handle) => handle.destroy());
    sidebarCollectionContextMenuHandles = [];

    dom.sidebarNav.innerHTML = `
      <button class="sidebar-nav-item${activeView.kind === "clipboard" ? " is-active" : ""}" type="button" data-view-kind="clipboard">
        <i data-lucide="clipboard"></i>
        <span>Clipboard</span>
      </button>
    `;

    dom.collectionsNav.replaceChildren();
    for (const collection of collections) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `sidebar-nav-item${activeView.kind === "collection" && activeView.collectionId === collection.id ? " is-active" : ""}`;
      item.dataset.collectionId = collection.id;
      item.draggable = true;
      item.innerHTML = `
        <i data-lucide="${getCollectionIcon(collection)}"></i>
        <span>${collection.name}</span>
        ${canDeleteCollection(collection) ? `<span class="sidebar-nav-delete" data-delete-collection-id="${collection.id}" title="Delete ${collection.name}"><i data-lucide="trash-2"></i></span>` : ""}
      `;
      item.addEventListener("dragstart", (event) => {
        draggingCollectionId = collection.id;
        item.classList.add("is-dragging");
        event.dataTransfer?.setData("text/plain", collection.id);
        event.dataTransfer!.effectAllowed = "move";
      });
      item.addEventListener("dragend", () => {
        draggingCollectionId = null;
        item.classList.remove("is-dragging");
        dom.collectionsNav
          .querySelectorAll<HTMLElement>(".sidebar-nav-item")
          .forEach((candidate) => {
            candidate.classList.remove("drop-before", "drop-after");
          });
      });
      item.addEventListener("dragover", (event) => {
        if (!draggingCollectionId || draggingCollectionId === collection.id) return;
        event.preventDefault();
        const rect = item.getBoundingClientRect();
        const before = event.clientY < rect.top + rect.height / 2;
        item.classList.toggle("drop-before", before);
        item.classList.toggle("drop-after", !before);
      });
      item.addEventListener("dragleave", () => {
        item.classList.remove("drop-before", "drop-after");
      });
      item.addEventListener("drop", (event) => {
        if (!draggingCollectionId || draggingCollectionId === collection.id) return;
        event.preventDefault();
        const rect = item.getBoundingClientRect();
        const before = event.clientY < rect.top + rect.height / 2;
        item.classList.remove("drop-before", "drop-after");
        void reorderSidebarCollection(
          draggingCollectionId,
          collection.id,
          before ? "before" : "after",
        );
      });
      item.addEventListener("click", async (event) => {
        const deleteTrigger = (
          event.target as HTMLElement
        ).closest<HTMLElement>("[data-delete-collection-id]");
        if (deleteTrigger) {
          event.stopPropagation();
          openDeleteCollectionModal(
            deleteTrigger.dataset.deleteCollectionId || null,
          );
          return;
        }
        await switchView({ kind: "collection", collectionId: collection.id });
      });
      sidebarCollectionContextMenuHandles.push(
        bindSidebarCollectionContextMenu(item, collection),
      );
      dom.collectionsNav.appendChild(item);
    }

    dom.sidebarNav
      .querySelector<HTMLButtonElement>("[data-view-kind='clipboard']")
      ?.addEventListener("click", () => {
        void switchView({ kind: "clipboard" });
      });

    applyIcons();
  };

  const refreshCollections = async () => {
    collections = await listCollections();
    const activeCollection = getActiveCollection();
    if (activeView.kind === "collection" && !activeCollection) {
      activeView = {
        kind: "collection",
        collectionId: getDefaultCollectionId(collections),
      };
    }
    renderSidebar();
  };

  const navigateCollections = async (delta: -1 | 1) => {
    if (activeView.kind !== "collection") return false;
    const nextCollectionId = getAdjacentCollectionId(
      collections,
      activeView.collectionId,
      delta,
    );
    if (!nextCollectionId) return false;
    await switchView({ kind: "collection", collectionId: nextCollectionId });
    return true;
  };

  const reorderSidebarCollection = async (
    collectionId: string,
    targetCollectionId: string,
    position: "before" | "after",
  ) => {
    if (collectionId === targetCollectionId) return;
    await reorderCollection({ collectionId, targetCollectionId, position });
    await refreshCollections();
    if (activeView.kind === "collection") {
      renderSidebar();
    }
  };

  const openCreateCollectionModal = (entryIds: string[] = []) => {
    pendingCreateMoveIds = [...entryIds];
    dom.createCollectionInput.value = "";
    dom.createCollectionIconSearchInput.value = "";
    selectedCreateCollectionIcon = DEFAULT_CREATE_COLLECTION_ICON;
    selectedCreateCollectionType = "standard";
    syncCreateCollectionTypeSelection(dom);
    syncCreateCollectionTypeAvailability(dom);
    syncCreateCollectionIconPreview(dom);
    renderCreateCollectionIconOptions(dom);
    openModal({ backdrop: dom.createCollectionModal });
    dom.createCollectionInput.focus();
  };

  const resetRenameCollectionModal = () => {
    pendingRenameCollectionId = null;
    dom.renameCollectionInput.value = "";
  };

  const closeRenameCollectionModal = () => {
    closeModal({ backdrop: dom.renameCollectionModal });
    resetRenameCollectionModal();
  };

  const openRenameCollectionModal = (collection: CollectionRow) => {
    pendingRenameCollectionId = collection.id;
    dom.renameCollectionInput.value = collection.name;
    openModal({ backdrop: dom.renameCollectionModal });
    dom.renameCollectionInput.focus();
    dom.renameCollectionInput.select();
  };

  const requestCreateCollection = async (
    entryIds: string[] = [],
  ): Promise<CollectionRow | null> => {
    openCreateCollectionModal(entryIds);
    return null;
  };

  const duplicateSidebarCollection = async (
    collection: CollectionRow,
  ): Promise<void> => {
    try {
      const duplicated = await duplicateCollection(collection.id);
      await refreshCollections();
      await emit("entries-changed");
      await switchView({ kind: "collection", collectionId: duplicated.id });
      showToast(`Collection duplicated to ${duplicated.name}`, "success", 1200);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Failed to duplicate collection",
        "error",
      );
    }
  };

  const convertSidebarCollection = async (
    collection: CollectionRow,
  ): Promise<void> => {
    const nextCollectionType = getNextCollectionType(collection.collection_type);
    const nextFilterQuery =
      nextCollectionType === "filter" ? getActiveCollectionFilterQuery(dom) : null;

    if (nextCollectionType === "filter" && !nextFilterQuery) {
      showToast("Filter collections require an active search/filter", "error");
      return;
    }

    try {
      await updateCollectionType(collection.id, nextCollectionType, nextFilterQuery);
      await refreshCollections();
      if (
        activeView.kind === "collection" &&
        activeView.collectionId === collection.id
      ) {
        await loadActiveCollection(dom.searchInput.value.trim() || undefined);
      }
      await emit("entries-changed");
      showToast(
        `Collection converted to ${nextCollectionType}`,
        "success",
        1200,
      );
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Failed to convert collection",
        "error",
      );
    }
  };

  const renameSidebarCollection = async (
    collection: CollectionRow,
  ): Promise<void> => {
    openRenameCollectionModal(collection);
  };

  const submitRenameCollection = async (): Promise<void> => {
    if (!pendingRenameCollectionId) return;

    const collection = collections.find(
      (candidate) => candidate.id === pendingRenameCollectionId,
    );
    if (!collection) {
      closeRenameCollectionModal();
      return;
    }

    const name = dom.renameCollectionInput.value.trim();
    if (!name) {
      showToast("Collection name cannot be empty", "error");
      return;
    }

    if (name === collection.name) {
      closeRenameCollectionModal();
      return;
    }

    try {
      const renamed = await renameCollection(collection.id, name);
      closeRenameCollectionModal();
      await refreshCollections();
      if (
        activeView.kind === "collection" &&
        activeView.collectionId === collection.id
      ) {
        await switchView({ kind: "collection", collectionId: renamed.id });
      }
      showToast(`Collection renamed to ${renamed.name}`, "success", 1200);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Failed to rename collection",
        "error",
      );
    }
  };

  const bindSidebarCollectionContextMenu = (
    item: HTMLButtonElement,
    collection: CollectionRow,
  ): ContextMenuHandle => {
    item.addEventListener("contextmenu", () => {
      dismissOpenContextMenus();
    });

    const nextCollectionType = getNextCollectionType(collection.collection_type);
    const items: ContextMenuItem[] = [
      ...(canRenameCollection(collection)
        ? [
            {
              id: `rename-collection-${collection.id}`,
              label: "Rename collection",
              icon: "pencil",
              onSelect: async () => {
                await renameSidebarCollection(collection);
              },
            } satisfies ContextMenuItem,
          ]
        : []),
      {
        id: `duplicate-collection-${collection.id}`,
        label: "Duplicate collection",
        icon: "copy-plus",
        onSelect: async () => {
          await duplicateSidebarCollection(collection);
        },
      },
      {
        id: `convert-collection-${collection.id}`,
        label: `Convert collection to ${nextCollectionType}`,
        icon:
          nextCollectionType === "checklist"
            ? "square-check-big"
            : nextCollectionType === "filter"
              ? "filter"
              : "folder",
        onSelect: async () => {
          await convertSidebarCollection(collection);
        },
      },
    ];

    if (canDeleteCollection(collection)) {
      items.push(
        { divider: true },
        {
          id: `delete-collection-${collection.id}`,
          label: "Delete collection",
          icon: "trash-2",
          onSelect: () => {
            openDeleteCollectionModal(collection.id);
          },
        },
      );
    }

    return bindContextMenu({
      target: item,
      items,
    });
  };

  const openDeleteCollectionModal = (collectionId: string | null) => {
    if (!collectionId) return;
    pendingDeleteCollectionId = collectionId;
    const collection = collections.find(
      (candidate) => candidate.id === collectionId,
    );
    if (!collection) return;

    dom.deleteCollectionMessage.textContent = `Delete ${collection.name}. Choose where its items should go, or leave them in No collection.`;
    dom.deleteCollectionDestinationSelect.innerHTML = collections
      .filter((candidate) => candidate.id !== collectionId)
      .map(
        (candidate) =>
          `<option value="${candidate.id}"${candidate.id === NOTES_COLLECTION_ID ? " selected" : ""}>${candidate.name}</option>`,
      )
      .join("");
    dom.deleteCollectionDestinationSelect.insertAdjacentHTML(
      "afterbegin",
      `<option value="">No collection</option>`,
    );
    openModal({ backdrop: dom.deleteCollectionModal });
  };

  function initProviderStatus() {
    const provider = dom.providerSetupSelect.value;
    const apiKey =
      provider === "openai"
        ? currentSettings.providers.openai.apiKey
        : provider === "gemini"
          ? currentSettings.providers.gemini.apiKey
          : currentSettings.providers.ollama.baseUrl;

    if (!apiKey || apiKey === "http://localhost:11434") {
      updateProviderStatus("disconnected");
    } else {
      updateProviderStatus("untested");
    }
  }
  initProviderStatus();

  collections = await listCollections();
  activeView = {
    kind: "collection",
    collectionId: getDefaultCollectionId(collections),
  };

  initCollectionController(dom, getSettings, {
    getCollections: () => collections,
    requestCreateCollection,
    refreshCollections,
    refreshGraph: () => notesGraph.refresh(),
    isGraphVisible: () => notesGraph.isVisible(),
    setGraphHoveredEntry: (entryId) => notesGraph.setHoveredEntry(entryId),
    focusGraphEntry: openGraphAndCenterEntry,
    applyRelatedToFilter,
  });

  initClipboardController(dom, getSettings, {
    getCollections: () => collections,
    requestCreateCollection,
    refreshGraph: () => clipboardGraph.refresh(),
    isGraphVisible: () => clipboardGraph.isVisible(),
    setGraphHoveredEntry: (entryId) => clipboardGraph.setHoveredEntry(entryId),
    focusGraphEntry: openGraphAndCenterEntry,
    applyRelatedToFilter,
  });

  renderSidebar();
  await switchView(activeView);

  dom.newCollectionBtn.addEventListener("click", () => {
    openCreateCollectionModal();
  });

  dom.createCollectionConfirmBtn.addEventListener("click", async () => {
    const name = dom.createCollectionInput.value.trim();
    if (!name) return;

    try {
      const collection = await createCollection(
        name,
        selectedCreateCollectionIcon,
        selectedCreateCollectionType,
        selectedCreateCollectionType === "filter"
          ? getActiveCollectionFilterQuery(dom)
          : null,
      );
      closeModal({ backdrop: dom.createCollectionModal });
      await refreshCollections();
      if (pendingCreateMoveIds.length > 0) {
        await moveEntriesToCollection(pendingCreateMoveIds, collection.id);
        pendingCreateMoveIds = [];
        await emit("entries-changed");
        showToast(`Items moved to ${collection.name}`, "success", 1200);
      }
      await switchView({ kind: "collection", collectionId: collection.id });
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Failed to create collection",
        "error",
      );
    }
  });

  dom.createCollectionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dom.createCollectionConfirmBtn.click();
    }
  });

  dom.renameCollectionConfirmBtn.addEventListener("click", async () => {
    await submitRenameCollection();
  });

  dom.renameCollectionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dom.renameCollectionConfirmBtn.click();
    }
  });

  dom.renameCollectionModal
    .querySelectorAll<HTMLElement>(".modal-btn-reject")
    .forEach((button) => {
      button.addEventListener("click", () => {
        resetRenameCollectionModal();
      });
    });

  dom.renameCollectionModal.addEventListener("click", (event) => {
    if (event.target === dom.renameCollectionModal) {
      resetRenameCollectionModal();
    }
  });

  dom.createCollectionIconSearchInput.addEventListener("input", () => {
    renderCreateCollectionIconOptions(dom);
  });

  dom.createCollectionTypeStandard.addEventListener("change", () => {
    if (!dom.createCollectionTypeStandard.checked) return;
    selectedCreateCollectionType = "standard";
  });

  dom.createCollectionTypeChecklist.addEventListener("change", () => {
    if (!dom.createCollectionTypeChecklist.checked) return;
    selectedCreateCollectionType = "checklist";
  });

  dom.createCollectionTypeFilter.addEventListener("change", () => {
    if (!dom.createCollectionTypeFilter.checked || dom.createCollectionTypeFilter.disabled) {
      return;
    }
    selectedCreateCollectionType = "filter";
  });

  dom.deleteCollectionConfirmBtn.addEventListener("click", async () => {
    if (!pendingDeleteCollectionId) return;

    try {
      const destinationCollectionId =
        dom.deleteCollectionDestinationSelect.value || null;
      const deletedCollectionId = pendingDeleteCollectionId;
      await deleteCollection(deletedCollectionId, destinationCollectionId);
      closeModal({ backdrop: dom.deleteCollectionModal });
      pendingDeleteCollectionId = null;
      await refreshCollections();
      if (
        activeView.kind === "collection" &&
        activeView.collectionId === deletedCollectionId
      ) {
        await switchView({
          kind: "collection",
          collectionId: getDefaultCollectionId(collections),
        });
      } else {
        await emit("entries-changed");
      }
      showToast("Collection deleted", "success", 1200);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Failed to delete collection",
        "error",
      );
    }
  });

  // Start clipboard monitoring if enabled
  if (currentSettings.clipboardMonitoring) {
    await invoke("start_clipboard_monitor").catch(console.error);
  }

  await registerOverlayShortcut(
    toGlobalShortcutAccelerator(
      resolveEffectiveShortcutBinding("global.showOverlay", currentSettings.shortcutOverrides),
    ),
  );

  getImportMetaHot()?.dispose(() => unregisterOverlayShortcut(overlayShortcutBinding));

  // ── Search ────────────────────────────────────────────────────────────────
  dom.searchInput.addEventListener("input", () => {
    handleCollectionSearchInput(dom.searchInput.value);
  });
  dom.searchClearBtn.addEventListener("click", () => {
    dom.searchInput.value = "";
    dom.searchClearBtn.hidden = true;
    void loadActiveCollection();
  });

  // ── Clipboard search ─────────────────────────────────────────────────────
  dom.clipboardSearchInput.addEventListener("input", () => {
    handleClipboardSearchInput(dom.clipboardSearchInput.value);
  });
  dom.clipboardSearchClearBtn.addEventListener("click", () => {
    dom.clipboardSearchInput.value = "";
    dom.clipboardSearchClearBtn.hidden = true;
    void loadClipboard();
  });

  // ── Quick add ─────────────────────────────────────────────────────────────
  let quickAddBadgeColor = QUICK_ADD_DEFAULT_BADGE_COLOR;

  const resetQuickAddBadgeColor = () => {
    quickAddBadgeColor = QUICK_ADD_DEFAULT_BADGE_COLOR;
    dom.quickAddBadgeColors
      .querySelectorAll<HTMLElement>(".badge-color-swatch")
      .forEach((swatch) => {
        swatch.classList.toggle(
          "is-selected",
          swatch.dataset.color === QUICK_ADD_DEFAULT_BADGE_COLOR,
        );
      });
  };

  const resetQuickAddForm = () => {
    dom.quickAddForm.hidden = true;
    dom.quickAddInput.value = "";
    dom.quickAddBadgesInput.value = "";
    resetQuickAddBadgeColor();
  };

  const setQuickAddBusy = (busy: boolean) => {
    dom.quickAddInput.disabled = busy;
    dom.quickAddBadgesInput.disabled = busy;
    dom.quickAddSaveBtn.disabled = busy;
    dom.quickAddCancelBtn.disabled = busy;
    dom.quickAddBadgeSuggestions
      .querySelectorAll<HTMLButtonElement>(".quick-add-badge-suggestion")
      .forEach((button) => {
        button.disabled = busy;
      });
    dom.quickAddBadgeColors
      .querySelectorAll<HTMLButtonElement>(".badge-color-swatch")
      .forEach((swatch) => {
        swatch.disabled = busy;
      });
  };

  dom.quickAddBadgeSuggestions.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      ".quick-add-badge-suggestion",
    );
    const badge = button?.dataset.badge;
    if (!button || !badge) return;

    dom.quickAddBadgesInput.value = appendBadgeToInputValue(
      dom.quickAddBadgesInput.value,
      badge,
    );
    dom.quickAddBadgesInput.focus();
  });

  dom.quickAddBadgeColors.addEventListener("click", (event) => {
    const swatch = (event.target as HTMLElement).closest<HTMLElement>(
      ".badge-color-swatch",
    );
    if (!swatch) return;

    quickAddBadgeColor = swatch.dataset.color || QUICK_ADD_DEFAULT_BADGE_COLOR;
    dom.quickAddBadgeColors
      .querySelectorAll<HTMLElement>(".badge-color-swatch")
      .forEach((candidate) => {
        candidate.classList.toggle("is-selected", candidate === swatch);
      });
  });

  dom.addNoteBtn.addEventListener("click", () => {
    openQuickAdd();
  });

  dom.quickAddCancelBtn.addEventListener("click", () => {
    resetQuickAddForm();
  });

  dom.quickAddSaveBtn.addEventListener("click", async () => {
    const content = dom.quickAddInput.value.trim();
    if (!content) return;
    const badges = parseBadgeInput(dom.quickAddBadgesInput.value);
    const badgeColor = quickAddBadgeColor;
    setQuickAddBusy(true);

    try {
      const id = await addNote(
        content,
        "manual",
        null,
        null,
        activeView.kind === "collection"
          ? activeView.collectionId
          : NOTES_COLLECTION_ID,
      );

      if (badges.length > 0) {
        try {
          for (const badge of badges) {
            await invoke("db_add_manual_badge", { id, badge, color: badgeColor });
          }
        } catch (error) {
          showToast(
            error instanceof Error
              ? `Item saved, but badges could not be applied: ${error.message}`
              : "Item saved, but badges could not be applied",
            "error",
          );
          return;
        }
        await loadActiveCollection(dom.searchInput.value.trim() || undefined);
        await emit("entries-changed");
      }

      resetQuickAddForm();
      showToast("Item saved", "success", 1200);
    } catch (error) {
      showToast(
        error instanceof Error
          ? `Failed to save item: ${error.message}`
          : "Failed to save item",
        "error",
      );
    } finally {
      setQuickAddBusy(false);
    }
  });

  // Ctrl+Enter / Cmd+Enter to save quick add
  dom.quickAddInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      dom.quickAddSaveBtn.click();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dom.quickAddCancelBtn.click();
    }
  });

  dom.quickAddInput.addEventListener("input", () => {
    void refreshQuickAddBadgeSuggestions();
  });

  dom.quickAddBadgesInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      dom.quickAddSaveBtn.click();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dom.quickAddCancelBtn.click();
    }
  });

  window.addEventListener("keydown", async (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;

    const activeSearchInput = getActiveSearchInput(dom);

    if (
      shouldFocusActiveSearchInput({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isTargetEditable: isEditableTarget(event.target),
        isTargetActiveSearchInput: event.target === activeSearchInput,
      }, getShortcutOverrides())
    ) {
      event.preventDefault();
      focusActiveSearchInput(dom);
      return;
    }

    if (matchesShortcut("main.clearSelection", {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    })) {
      event.preventDefault();
      void clearActiveSearch(dom).then((clearedSearch) => {
        if (clearedSearch) return;
        if (activeView.kind === "clipboard") clearClipboardSelection();
        else clearCollectionSelection();
      });
      return;
    }

    if (matchesShortcut("main.deleteSelection", {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    })) {
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      void (activeView.kind === "clipboard"
        ? deleteSelectedClipboardItem()
        : deleteSelectedCollectionEntries());
      return;
    }

    if (activeView.kind === "collection") {
      if (!isEditableTarget(event.target) && !event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const delta = event.key === "ArrowUp" ? -1 : 1;
          const selectedIds = getSelectedCollectionEntryIds();
          if (selectedIds.length > 0) {
            const moved = moveCollectionSelection(delta);
            if (moved) {
              event.preventDefault();
              return;
            }
          } else {
            const moved = await navigateCollections(delta);
            if (moved) {
              event.preventDefault();
              return;
            }
          }
        }
      }

      const reorderHandled = await handleCollectionReorderKeydown(event);
      if (reorderHandled) return;

      const handled = await handleCollectionSpaceKeydown(event);
      if (handled) return;
    }

    if (matchesShortcut("main.newItem", {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    }, getShortcutOverrides())) {
      event.preventDefault();
      openQuickAdd();
      return;
    }

    if (matchesShortcut("main.openImport", {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    }, getShortcutOverrides())) {
      event.preventDefault();
      openImportModal();
    }
  });

  // ── Note detail ──────────────────────────────────────────────────────────
  dom.noteDetailClose.addEventListener("click", () =>
    clearCollectionSelection(),
  );
  dom.noteDetailDelete.addEventListener("click", async () => {
    await deleteSelectedCollectionEntries();
  });

  // ── Clipboard detail ────────────────────────────────────────────────────
  dom.clipboardDetailClose.addEventListener("click", () =>
    clearClipboardSelection(),
  );
  dom.clipboardDetailDelete.addEventListener("click", async () => {
    await deleteSelectedClipboardItem();
  });

  // ── Clipboard listener ────────────────────────────────────────────────────
  await listen<{
    content: string;
    html_content: string | null;
    source_app: string | null;
  }>("clipboard-capture", async (event) => {
    debugLog("clipboard-capture event received", "INFO");
    const { content, html_content, source_app } = event.payload;
    try {
      const id = await invoke<string>("db_add_entry", {
        content,
        htmlContent: html_content,
        source: "clipboard",
        sourceApp: source_app,
        createdAt: Date.now(),
      });
      await loadClipboard();
      void processNoteBackground(id, content);
      debugLog("clipboard-capture processed successfully", "INFO");
    } catch (err) {
      debugLog(`clipboard-capture processing failed: ${err}`, "ERROR");
    }
  });

  await listen("entries-changed", async () => {
    await Promise.all([
      loadActiveCollection(dom.searchInput.value.trim() || undefined),
      loadClipboard(dom.clipboardSearchInput.value.trim() || undefined),
    ]);
  });

  // ── Settings changes ──────────────────────────────────────────────────────
  let liveRerankTimer: ReturnType<typeof setTimeout> | null = null;
  const rerankActiveSearches = (updated: Settings) => {
    if (liveRerankTimer !== null) clearTimeout(liveRerankTimer);

    previewSettings = updated;
    liveRerankTimer = setTimeout(() => {
      liveRerankTimer = null;
      const collectionQuery = dom.searchInput.value.trim();
      const clipboardQuery = dom.clipboardSearchInput.value.trim();

      if (!collectionQuery && !clipboardQuery) return;

      void Promise.all([
        collectionQuery
          ? loadActiveCollection(collectionQuery)
          : Promise.resolve(),
        clipboardQuery ? loadClipboard(clipboardQuery) : Promise.resolve(),
      ]).catch(console.error);
    }, 120);
  };

  const onSettingsChange = (delayMs = 600) => {
    scheduleAutosave(
      dom,
      currentSettings,
      async (updated) => {
        if (liveRerankTimer !== null) {
          clearTimeout(liveRerankTimer);
          liveRerankTimer = null;
        }
        const wasMonitoring = currentSettings.clipboardMonitoring;
        const previousDebugLoggingEnabled = currentSettings.debugLoggingEnabled;
        currentSettings = updated;
        previewSettings = null;
        configureDebugLogging(updated.debugLoggingEnabled);

        if (updated.debugLoggingEnabled !== previousDebugLoggingEnabled) {
          dom.noteDetailDebug.hidden = !updated.debugLoggingEnabled;
          dom.clipboardDetailDebug.hidden = !updated.debugLoggingEnabled;
          if (activeView.kind === "clipboard") {
            await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
          } else {
            await loadActiveCollection(dom.searchInput.value.trim() || undefined);
          }
        }

        // Toggle clipboard monitoring if changed
        if (updated.clipboardMonitoring !== wasMonitoring) {
          if (updated.clipboardMonitoring) {
            await invoke("start_clipboard_monitor").catch(console.error);
          } else {
            invoke("stop_clipboard_monitor");
          }
        }
      },
      delayMs,
      (updated) => {
        // Immediate UI feedback while typing
        updateEmbeddingVisibility(dom, updated.embeddingProvider);
        updateEmbeddingModelOptions(dom, updated);
        updateEnrichmentModelOptions(dom, updated);

        if (rankingChanged(updated, currentSettings)) {
          rerankActiveSearches(updated);
        }
      },
    );
  };

  dom.clipboardMonitoringCheckbox.addEventListener("change", () =>
    onSettingsChange(0),
  );

  // Provider Setup
  dom.providerSetupSelect.addEventListener("change", () => {
    updateProviderSetupSections(dom);
    updateProviderStatus("untested");
  });
  dom.openaiApiKey.addEventListener("input", () => {
    onSettingsChange();
    updateProviderStatus("untested");
  });
  dom.geminiApiKey.addEventListener("input", () => {
    onSettingsChange();
    updateProviderStatus("untested");
  });
  dom.ollamaBaseUrl.addEventListener("input", () => {
    onSettingsChange();
    updateProviderStatus("untested");
  });

  // Embeddings
  dom.embeddingUnifiedModelSelect.addEventListener("change", () =>
    onSettingsChange(0),
  );
  dom.embeddingModelInput.addEventListener("input", () => onSettingsChange());

  // Enrichment
  const syncEnrichmentToggles = () => {
    updateEnrichmentVisibility(
      dom,
      dom.enrichmentSummaryEnabledCheckbox.checked ||
        dom.enrichmentTaggingEnabledCheckbox.checked,
    );
    onSettingsChange(0);
  };
  dom.enrichmentSummaryEnabledCheckbox.addEventListener("change", syncEnrichmentToggles);
  dom.enrichmentTaggingEnabledCheckbox.addEventListener("change", syncEnrichmentToggles);
  dom.enrichmentUnifiedModelSelect.addEventListener("change", () =>
    onSettingsChange(0),
  );

  // Ranking
  [
    dom.shortKeywordWeightInput,
    dom.shortSemanticWeightInput,
    dom.mediumKeywordWeightInput,
    dom.mediumSemanticWeightInput,
    dom.longKeywordWeightInput,
    dom.longSemanticWeightInput,
    dom.semanticRelevanceThresholdInput,
    dom.recencyBoostMaxInput,
    dom.rrfKInput,
  ].forEach((input) => {
    input.addEventListener("input", () => onSettingsChange());
    input.addEventListener("change", () => onSettingsChange(0));
  });
  dom.resetRankingBtn.addEventListener("click", () => {
    resetRankingSettingsUI(dom);
    onSettingsChange(0);
  });

  // Debug
  dom.debugLoggingCheckbox.addEventListener("change", () =>
    onSettingsChange(0),
  );

  // TruffleHog
  dom.trufflehogPathInput.addEventListener("input", () => {
    resetTruffleHogCache();
    onSettingsChange();
  });

  // Secret Masker
  dom.secretMaskerEnabledCheckbox.addEventListener("change", () =>
    onSettingsChange(0),
  );
  dom.secretMaskerModelSelect.addEventListener("change", () =>
    onSettingsChange(0),
  );

  // TruffleHog download link (opens in the system browser)
  dom.trufflehogDownloadLink.addEventListener("click", (event) => {
    event.preventDefault();
    invoke("open_external_url", {
      url: "https://github.com/trufflesecurity/trufflehog/releases",
    }).catch((err) => {
      debugLog(`Failed to open TruffleHog releases page: ${err}`, "ERROR");
    });
  });

  // ── API key show/hide toggles ─────────────────────────────────────────────
  function toggleKeyVisibility(
    input: HTMLInputElement,
    btn: HTMLButtonElement,
  ) {
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    const icon = btn.querySelector("i");
    if (icon) icon.setAttribute("data-lucide", isHidden ? "eye-off" : "eye");
    applyIcons();
  }

  dom.toggleOpenaiKeyBtn.addEventListener("click", () =>
    toggleKeyVisibility(dom.openaiApiKey, dom.toggleOpenaiKeyBtn),
  );
  dom.toggleGeminiKeyBtn.addEventListener("click", () =>
    toggleKeyVisibility(dom.geminiApiKey, dom.toggleGeminiKeyBtn),
  );

  // ── Provider Status UI ────────────────────────────────────────────────────
  function updateProviderStatus(
    status: "connected" | "connecting" | "untested" | "disconnected" | "error",
    message?: string,
  ) {
    const statusText = dom.providerStatus.querySelector(
      ".status-text",
    ) as HTMLElement;
    if (!statusText) return;

    dom.providerStatus.className = "status-indicator";

    switch (status) {
      case "connected":
        dom.providerStatus.classList.add("connected");
        statusText.textContent = "Ready";
        break;
      case "connecting":
        dom.providerStatus.classList.add("disconnected");
        statusText.textContent = "Testing...";
        break;
      case "untested":
        dom.providerStatus.classList.add("untested");
        statusText.textContent = "Not tested";
        break;
      case "disconnected":
        dom.providerStatus.classList.add("disconnected");
        statusText.textContent = "Not configured";
        break;
      case "error":
        dom.providerStatus.classList.add("error");
        statusText.textContent = message || "Connection failed";
        break;
    }
  }

  // ── TruffleHog Status UI ──────────────────────────────────────────────────
  function updateTrufflehogStatus(
    status: "connected" | "connecting" | "untested" | "disconnected" | "error",
    message?: string,
  ) {
    const statusText = dom.trufflehogStatus.querySelector(
      ".status-text",
    ) as HTMLElement;
    if (!statusText) return;

    dom.trufflehogStatus.className = "status-indicator";

    switch (status) {
      case "connected":
        dom.trufflehogStatus.classList.add("connected");
        statusText.textContent = message || "Ready";
        break;
      case "connecting":
        dom.trufflehogStatus.classList.add("disconnected");
        statusText.textContent = "Testing...";
        break;
      case "untested":
        dom.trufflehogStatus.classList.add("untested");
        statusText.textContent = "Not tested";
        break;
      case "disconnected":
        dom.trufflehogStatus.classList.add("disconnected");
        statusText.textContent = "Not configured";
        break;
      case "error":
        dom.trufflehogStatus.classList.add("error");
        statusText.textContent = message || "Not found";
        break;
    }
  }

  // ── Test provider connection ─────────────────────────────────────────────
  dom.testProviderBtn.addEventListener("click", async () => {
    debugLog("testProviderBtn clicked", "INFO");
    try {
      const provider = dom.providerSetupSelect.value as
        | "openai"
        | "gemini"
        | "ollama";
      debugLog(`Testing connection for provider: ${provider}`, "INFO");

      // Get the currently entered API key explicitly
      let keyToCheck = "";
      let tempSettings: Settings = JSON.parse(JSON.stringify(currentSettings));

      if (provider === "openai") {
        keyToCheck = dom.openaiApiKey.value.trim();
        tempSettings.providers.openai.apiKey = keyToCheck;
      } else if (provider === "gemini") {
        keyToCheck = dom.geminiApiKey.value.trim();
        tempSettings.providers.gemini.apiKey = keyToCheck;
      } else if (provider === "ollama") {
        tempSettings.providers.ollama.baseUrl = dom.ollamaBaseUrl.value.trim();
      }

      if (provider !== "ollama" && !keyToCheck) {
        updateProviderStatus("error", "API key is required");
        showToast("API key is required", "error");
        return;
      }

      updateProviderStatus("connecting");
      dom.testProviderBtn.disabled = true;

      // 1. Discover models first to validate the API key
      if (provider === "openai" || provider === "gemini") {
        debugLog(
          "Triggering automatic model refresh to validate API key and discover models",
          "INFO",
        );
        await refreshModels(provider);
      }

      // 2. Re-read settings now that UI dropdowns are populated with valid models
      const updatedSettings = readSettingsFromForm(dom, currentSettings);

      let testModel = "";
      if (provider === "ollama") {
        testModel = updatedSettings.embeddingModel || "nomic-embed-text";
      } else {
        const cache = updatedSettings.providers[provider].modelCache;
        testModel =
          cache?.embeddingModels?.[0] ||
          (provider === "openai"
            ? "text-embedding-3-small"
            : "gemini-embedding-001");
      }

      if (!testModel) {
        throw new Error(`No embedding models found for provider ${provider}`);
      }

      debugLog(
        `Invoking testEmbeddingConnection with dynamically selected model: ${testModel}`,
        "INFO",
      );
      const result = await testEmbeddingConnection({
        ...updatedSettings,
        embeddingProvider: provider,
        embeddingModel: testModel,
      });

      debugLog(`testEmbeddingConnection result: ${result}`, "INFO");
      if (result === "ok") {
        updateProviderStatus("connected");
        showToast("Connection successful", "success");
      } else {
        updateProviderStatus("error", result);
        showToast("Connection failed", "error");
      }
    } catch (err) {
      console.error(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      debugLog(`testProviderBtn caught error: ${errMsg}`, "ERROR");
      updateProviderStatus("error", errMsg);
      showToast(`Error: ${errMsg}`, "error");
    } finally {
      dom.testProviderBtn.disabled = false;
      debugLog("testProviderBtn execution completed", "INFO");
    }
  });

  // ── Test TruffleHog ───────────────────────────────────────────────────────
  dom.testTrufflehogBtn.addEventListener("click", async () => {
    debugLog("testTrufflehogBtn clicked", "INFO");
    try {
      updateTrufflehogStatus("connecting");
      dom.testTrufflehogBtn.disabled = true;

      const customPath = dom.trufflehogPathInput.value.trim() || null;
      const status = await invoke<{
        available: boolean;
        path: string | null;
        version: string | null;
        supports_stdin: boolean;
      }>("trufflehog_check", { customPath });

      debugLog(
        `trufflehog_check result: available=${status.available}, path=${status.path}, version=${status.version}, stdin=${status.supports_stdin}`,
        "INFO",
      );

      if (status.available) {
        const versionStr = status.version ? ` v${status.version}` : "";
        const stdinStr = status.supports_stdin ? " (stdin)" : " (file mode)";
        updateTrufflehogStatus("connected", `Found${versionStr}${stdinStr}`);
        dom.trufflehogPathHint.textContent =
          status.path || "Auto-detected from PATH";
        showToast("TruffleHog detected", "success", 1500);
      } else {
        updateTrufflehogStatus("error", "Not found");
        dom.trufflehogPathHint.textContent =
          "TruffleHog binary not found. Install it or provide a custom path.";
        showToast("TruffleHog not found", "error");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      debugLog(`testTrufflehogBtn error: ${errMsg}`, "ERROR");
      updateTrufflehogStatus("error", errMsg);
      showToast(`Error: ${errMsg}`, "error");
    } finally {
      dom.testTrufflehogBtn.disabled = false;
    }
  });

  // ── Refresh models ────────────────────────────────────────────────────────
  async function refreshModels(provider: "openai" | "gemini"): Promise<void> {
    const btnEmbed = dom.refreshEmbeddingModelsBtn;
    const btnChat = dom.refreshEnrichmentModelsBtn;
    const hintEmbed = dom.embeddingModelHint;
    const hintChat = dom.enrichmentModelHint;

    btnEmbed.disabled = true;
    btnChat.disabled = true;
    hintEmbed.textContent = "Fetching models…";
    hintChat.textContent = "Fetching models…";

    try {
      const latestSettings = readSettingsFromForm(dom, currentSettings);
      const apiKey =
        provider === "openai"
          ? latestSettings.providers.openai.apiKey
          : latestSettings.providers.gemini.apiKey;
      if (!apiKey) throw new Error("API key is required");

      const embeddingModels = await fetchModelsFromApi(
        provider,
        "embedding",
        apiKey,
      );
      const chatModels = await fetchModelsFromApi(provider, "chat", apiKey);

      await saveProviderModelCache(provider, {
        apiKeyFingerprint: fingerprintApiKey(apiKey),
        fetchedAt: Date.now(),
        embeddingModels,
        chatModels,
      });

      // Reload settings and update UI
      currentSettings = await loadSettings();
      updateEmbeddingModelOptions(dom, currentSettings);
      updateEnrichmentModelOptions(dom, currentSettings);

      showToast("Models updated", "success", 1500);
    } catch (err) {
      hintEmbed.textContent = `Error: ${String(err)}`;
      hintChat.textContent = `Error: ${String(err)}`;
      showToast("Failed to fetch models", "error");
      throw err; // re-throw so the testProviderBtn can catch it
    } finally {
      btnEmbed.disabled = false;
      btnChat.disabled = false;
    }
  }

  dom.refreshEmbeddingModelsBtn.addEventListener("click", () => {
    const provider = currentSettings.embeddingProvider;
    if (provider === "openai" || provider === "gemini") {
      refreshModels(provider).catch(console.error);
    } else {
      showToast("Select OpenAI or Gemini to refresh models", "error");
    }
  });

  dom.refreshEnrichmentModelsBtn.addEventListener("click", () => {
    const provider =
      currentSettings.enrichmentProvider === "none"
        ? "openai"
        : currentSettings.enrichmentProvider;
    if (provider === "openai" || provider === "gemini") {
      refreshModels(provider).catch(console.error);
    }
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  window.addEventListener("beforeunload", () => {
    cancelAutosave();
    invoke("stop_clipboard_monitor");
    void unregisterOverlayShortcut(overlayShortcutBinding);
  });
}

init().catch((err) => console.error("Failed to initialise app:", err));

// ── Standalone utilities ────────────────────────────────────────────────────

async function fetchModelsFromApi(
  provider: "openai" | "gemini",
  type: "embedding" | "chat",
  apiKey: string,
): Promise<string[]> {
  debugLog(`fetchModelsFromApi: provider=${provider}, type=${type}`, "INFO");
  const url =
    provider === "openai"
      ? "https://api.openai.com/v1/models"
      : `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

  const headers: Record<string, string> = {};
  if (provider === "openai") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  debugLog(`fetchModelsFromApi sending GET to ${url.split("?")[0]}`, "INFO");
  const response: any = await invoke("http_fetch", {
    request: {
      url,
      method: "GET",
      headers,
      body: null,
    },
  });

  debugLog(`fetchModelsFromApi response status: ${response.status}`, "INFO");

  if (response.status !== 200) {
    debugLog(
      `fetchModelsFromApi API returned ${response.status}: ${response.body}`,
      "ERROR",
    );
    throw new Error(`API returned ${response.status}: ${response.body}`);
  }

  try {
    const data = JSON.parse(response.body);
    let models: string[] = [];
    if (provider === "openai") {
      models = data.data.map((m: any) => m.id);
      if (type === "embedding") {
        models = models.filter((id: string) => id.includes("embed")).sort();
      } else {
        models = models.filter((id: string) => id.includes("gpt")).sort();
      }
    } else {
      models = data.models.map((m: any) => m.name.replace("models/", ""));
      if (type === "embedding") {
        models = models.filter((id: string) => id.includes("embed")).sort();
      } else {
        models = models.filter((id: string) => !id.includes("embed")).sort();
      }
    }
    debugLog(`fetchModelsFromApi found ${models.length} models`, "INFO");
    return models;
  } catch (err) {
    debugLog(`fetchModelsFromApi parsing error: ${err}`, "ERROR");
    throw err;
  }
}
