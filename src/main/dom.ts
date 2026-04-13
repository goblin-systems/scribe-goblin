export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`Missing required element: #${id}`);
  return el;
}

export interface ScribeDom {
  // Shell
  toggleSidebarNav: HTMLButtonElement;
  toggleSidebarNavLabel: HTMLElement;
  appSidebar: HTMLElement;
  showOverlayBtn: HTMLButtonElement;
  showOverlayStatusBtn: HTMLButtonElement;

  // Clipboard
  clipboardSearchInput: HTMLInputElement;
  clipboardSearchClearBtn: HTMLButtonElement;
  clipboardList: HTMLDivElement;
  clipboardEmpty: HTMLDivElement;
  clipboardDetail: HTMLDivElement;
  clipboardDetailContent: HTMLDivElement;
  clipboardDetailSecretActions: HTMLDivElement;
  clipboardDetailMeta: HTMLDivElement;
  clipboardDetailClose: HTMLButtonElement;
  clipboardDetailDelete: HTMLButtonElement;
  clipboardDetailPlaceholder: HTMLDivElement;
  clipboardStatusLeft: HTMLSpanElement;

  // Notes
  searchInput: HTMLInputElement;
  searchClearBtn: HTMLButtonElement;
  addNoteBtn: HTMLButtonElement;
  quickAddForm: HTMLDivElement;
  quickAddInput: HTMLTextAreaElement;
  quickAddSaveBtn: HTMLButtonElement;
  quickAddCancelBtn: HTMLButtonElement;
  notesList: HTMLDivElement;
  notesEmpty: HTMLDivElement;
  noteDetail: HTMLDivElement;
  noteDetailContent: HTMLDivElement;
  noteDetailSecretActions: HTMLDivElement;
  noteDetailMeta: HTMLDivElement;
  noteDetailClose: HTMLButtonElement;
  noteDetailDelete: HTMLButtonElement;
  noteDetailPlaceholder: HTMLDivElement;
  notesStatusLeft: HTMLSpanElement;

  // Modals (backdrops)
  captureSettingsModal: HTMLElement;
  providersSettingsModal: HTMLElement;
  embeddingsSettingsModal: HTMLElement;
  enrichmentSettingsModal: HTMLElement;
  debugSettingsModal: HTMLElement;
  aboutModal: HTMLElement;
  addBadgeModal: HTMLElement;
  addBadgeInput: HTMLInputElement;
  addBadgeConfirmBtn: HTMLButtonElement;

  // Settings - Capture
  clipboardMonitoringCheckbox: HTMLInputElement;

  // Settings - Providers
  providerSetupSelect: HTMLSelectElement;
  setupOpenaiSection: HTMLDivElement;
  openaiApiKey: HTMLInputElement;
  toggleOpenaiKeyBtn: HTMLButtonElement;
  setupGeminiSection: HTMLDivElement;
  geminiApiKey: HTMLInputElement;
  toggleGeminiKeyBtn: HTMLButtonElement;
  setupOllamaSection: HTMLDivElement;
  setupLocalSection: HTMLDivElement;
  ollamaBaseUrl: HTMLInputElement;
  testProviderBtn: HTMLButtonElement;
  providerStatus: HTMLSpanElement;

  // Settings - Embeddings
  embeddingUnifiedModelSelect: HTMLSelectElement;
  embeddingModelInput: HTMLInputElement;
  refreshEmbeddingModelsBtn: HTMLButtonElement;
  embeddingModelHint: HTMLParagraphElement;

  // Settings - Enrichment
  enrichmentEnabledCheckbox: HTMLInputElement;
  enrichmentConfig: HTMLDivElement;
  enrichmentUnifiedModelSelect: HTMLSelectElement;
  refreshEnrichmentModelsBtn: HTMLButtonElement;
  enrichmentModelHint: HTMLParagraphElement;

  // Settings - Debug
  debugLoggingCheckbox: HTMLInputElement;
  debugLogPath: HTMLParagraphElement;
  openDebugFolderBtn: HTMLButtonElement;

  // Settings - TruffleHog
  trufflehogSettingsModal: HTMLElement;
  trufflehogPathInput: HTMLInputElement;
  trufflehogPathHint: HTMLParagraphElement;
  trufflehogStatus: HTMLSpanElement;
  testTrufflehogBtn: HTMLButtonElement;
}

export function createDom(): ScribeDom {
  return {
    // Shell
    toggleSidebarNav: byId("toggle-sidebar-nav"),
    toggleSidebarNavLabel: byId("toggle-sidebar-nav-label"),
    appSidebar: byId("app-sidebar"),
    showOverlayBtn: byId("show-overlay-btn"),
    showOverlayStatusBtn: byId("show-overlay-status-btn"),

    // Clipboard
    clipboardSearchInput: byId("clipboard-search-input"),
    clipboardSearchClearBtn: byId("clipboard-search-clear-btn"),
    clipboardList: byId("clipboard-list"),
    clipboardEmpty: byId("clipboard-empty"),
    clipboardDetail: byId("clipboard-detail"),
    clipboardDetailContent: byId("clipboard-detail-content"),
    clipboardDetailSecretActions: byId("clipboard-detail-secret-actions"),
    clipboardDetailMeta: byId("clipboard-detail-meta"),
    clipboardDetailClose: byId("clipboard-detail-close"),
    clipboardDetailDelete: byId("clipboard-detail-delete"),
    clipboardDetailPlaceholder: byId("clipboard-detail-placeholder"),
    clipboardStatusLeft: byId("clipboard-status-left"),

    // Notes
    searchInput: byId("search-input"),
    searchClearBtn: byId("search-clear-btn"),
    addNoteBtn: byId("add-note-btn"),
    quickAddForm: byId("quick-add-form"),
    quickAddInput: byId("quick-add-input"),
    quickAddSaveBtn: byId("quick-add-save-btn"),
    quickAddCancelBtn: byId("quick-add-cancel-btn"),
    notesList: byId("notes-list"),
    notesEmpty: byId("notes-empty"),
    noteDetail: byId("note-detail"),
    noteDetailContent: byId("note-detail-content"),
    noteDetailSecretActions: byId("note-detail-secret-actions"),
    noteDetailMeta: byId("note-detail-meta"),
    noteDetailClose: byId("note-detail-close"),
    noteDetailDelete: byId("note-detail-delete"),
    noteDetailPlaceholder: byId("note-detail-placeholder"),
    notesStatusLeft: byId("notes-status-left"),

    // Modals (backdrops)
    captureSettingsModal: byId("capture-settings-modal"),
    providersSettingsModal: byId("providers-settings-modal"),
    embeddingsSettingsModal: byId("embeddings-settings-modal"),
    enrichmentSettingsModal: byId("enrichment-settings-modal"),
    debugSettingsModal: byId("debug-settings-modal"),
    aboutModal: byId("about-modal"),
    addBadgeModal: byId("add-badge-modal"),
    addBadgeInput: byId("add-badge-input"),
    addBadgeConfirmBtn: byId("add-badge-confirm-btn"),

    // Settings - Capture
    clipboardMonitoringCheckbox: byId("clipboard-monitoring-checkbox"),

    // Settings - Providers
    providerSetupSelect: byId("provider-setup-select"),
    setupOpenaiSection: byId("setup-openai-section"),
    openaiApiKey: byId("openai-api-key"),
    toggleOpenaiKeyBtn: byId("toggle-openai-key-btn"),
    setupGeminiSection: byId("setup-gemini-section"),
    geminiApiKey: byId("gemini-api-key"),
    toggleGeminiKeyBtn: byId("toggle-gemini-key-btn"),
    setupOllamaSection: byId("setup-ollama-section"),
    setupLocalSection: byId("setup-local-section"),
    ollamaBaseUrl: byId("ollama-base-url"),
    testProviderBtn: byId("test-provider-btn"),
    providerStatus: byId("provider-status"),

    // Settings - Embeddings
    embeddingUnifiedModelSelect: byId("embedding-unified-model-select"),
    embeddingModelInput: byId("embedding-model-input"),
    refreshEmbeddingModelsBtn: byId("refresh-embedding-models-btn"),
    embeddingModelHint: byId("embedding-model-hint"),

    // Settings - Enrichment
    enrichmentEnabledCheckbox: byId("enrichment-enabled-checkbox"),
    enrichmentConfig: byId("enrichment-config"),
    enrichmentUnifiedModelSelect: byId("enrichment-unified-model-select"),
    refreshEnrichmentModelsBtn: byId("refresh-enrichment-models-btn"),
    enrichmentModelHint: byId("enrichment-model-hint"),

    // Settings - Debug
    debugLoggingCheckbox: byId("debug-logging-checkbox"),
    debugLogPath: byId("debug-log-path"),
    openDebugFolderBtn: byId("open-debug-folder-btn"),

    // Settings - TruffleHog
    trufflehogSettingsModal: byId("trufflehog-settings-modal"),
    trufflehogPathInput: byId("trufflehog-path-input"),
    trufflehogPathHint: byId("trufflehog-path-hint"),
    trufflehogStatus: byId("trufflehog-status"),
    testTrufflehogBtn: byId("test-trufflehog-btn"),
  };
}
