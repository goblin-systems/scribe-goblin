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
  sidebarNav: HTMLElement;
  collectionsNav: HTMLElement;
  newCollectionBtn: HTMLButtonElement;

  // Clipboard
  clipboardSearchInput: HTMLInputElement;
  clipboardSearchClearBtn: HTMLButtonElement;
  clipboardBadgeFilterBtn: HTMLButtonElement;
  clipboardList: HTMLDivElement;
  clipboardEmpty: HTMLDivElement;
  clipboardDetail: HTMLDivElement;
  clipboardDetailContent: HTMLDivElement;
  clipboardDetailSecretActions: HTMLDivElement;
  clipboardDetailMeta: HTMLDivElement;
  clipboardDetailRelated: HTMLDivElement;
  clipboardDetailDebug: HTMLDivElement;
  clipboardDetailClose: HTMLButtonElement;
  clipboardDetailDelete: HTMLButtonElement;
  clipboardDetailPlaceholder: HTMLDivElement;
  clipboardStatusBar: HTMLDivElement;
  clipboardStatusLeft: HTMLSpanElement;
  clipboardStatusMeta: HTMLDivElement;

  // Notes
  searchInput: HTMLInputElement;
  searchClearBtn: HTMLButtonElement;
  notesBadgeFilterBtn: HTMLButtonElement;
  addNoteBtn: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  quickAddForm: HTMLDivElement;
  quickAddInput: HTMLTextAreaElement;
  quickAddBadgesInput: HTMLInputElement;
  quickAddBadgeSuggestions: HTMLDivElement;
  quickAddBadgeColors: HTMLDivElement;
  quickAddSaveBtn: HTMLButtonElement;
  quickAddCancelBtn: HTMLButtonElement;
  notesList: HTMLDivElement;
  notesEmpty: HTMLDivElement;
  noteDetail: HTMLDivElement;
  noteDetailContent: HTMLDivElement;
  noteDetailSecretActions: HTMLDivElement;
  noteDetailMeta: HTMLDivElement;
  noteDetailRelated: HTMLDivElement;
  noteDetailDebug: HTMLDivElement;
  noteDetailClose: HTMLButtonElement;
  noteDetailDelete: HTMLButtonElement;
  noteDetailPlaceholder: HTMLDivElement;
  notesStatusBar: HTMLDivElement;
  notesStatusLeft: HTMLSpanElement;
  notesStatusMeta: HTMLDivElement;

  // Modals (backdrops)
  captureSettingsModal: HTMLElement;
  shortcutsSettingsModal: HTMLElement;
  providersSettingsModal: HTMLElement;
  embeddingsSettingsModal: HTMLElement;
  enrichmentSettingsModal: HTMLElement;
  rankingSettingsModal: HTMLElement;
  debugSettingsModal: HTMLElement;
  aboutModal: HTMLElement;
  addBadgeModal: HTMLElement;
  importModal: HTMLElement;
  createCollectionModal: HTMLElement;
  createCollectionInput: HTMLInputElement;
  createCollectionTypeStandard: HTMLInputElement;
  createCollectionTypeChecklist: HTMLInputElement;
  createCollectionTypeFilter: HTMLInputElement;
  createCollectionTypeHint: HTMLParagraphElement;
  createCollectionIconPreview: HTMLDivElement;
  createCollectionIconPreviewLabel: HTMLSpanElement;
  createCollectionIconSearchInput: HTMLInputElement;
  createCollectionIconOptions: HTMLDivElement;
  createCollectionIconHint: HTMLParagraphElement;
  createCollectionConfirmBtn: HTMLButtonElement;
  renameCollectionModal: HTMLElement;
  renameCollectionInput: HTMLInputElement;
  renameCollectionConfirmBtn: HTMLButtonElement;
  deleteCollectionModal: HTMLElement;
  deleteCollectionMessage: HTMLParagraphElement;
  deleteCollectionDestinationSelect: HTMLSelectElement;
  deleteCollectionConfirmBtn: HTMLButtonElement;
  addBadgeInput: HTMLInputElement;
  addBadgeConfirmBtn: HTMLButtonElement;
  importTextInput: HTMLTextAreaElement;
  importFileInput: HTMLInputElement;
  importChooseFilesBtn: HTMLButtonElement;
  importClearFilesBtn: HTMLButtonElement;
  importDropZone: HTMLDivElement;
  importSelectedFiles: HTMLDivElement;
  importSelectedFilesEmpty: HTMLParagraphElement;
  importSummary: HTMLParagraphElement;
  importConfirmBtn: HTMLButtonElement;
  shortcutsEditableList: HTMLDivElement;
  shortcutsFixedList: HTMLDivElement;
  shortcutsCaptureHint: HTMLParagraphElement;
  shortcutsResetAllBtn: HTMLButtonElement;

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
  ollamaBaseUrl: HTMLInputElement;
  testProviderBtn: HTMLButtonElement;
  providerStatus: HTMLSpanElement;

  // Settings - Embeddings
  embeddingUnifiedModelSelect: HTMLSelectElement;
  embeddingModelInput: HTMLInputElement;
  refreshEmbeddingModelsBtn: HTMLButtonElement;
  embeddingModelHint: HTMLParagraphElement;
  reembedAllBtn: HTMLButtonElement;
  reembedProgressHost: HTMLDivElement;

  // Settings - Enrichment
  enrichmentSummaryEnabledCheckbox: HTMLInputElement;
  enrichmentTaggingEnabledCheckbox: HTMLInputElement;
  enrichmentConfig: HTMLDivElement;
  enrichmentUnifiedModelSelect: HTMLSelectElement;
  refreshEnrichmentModelsBtn: HTMLButtonElement;
  enrichmentModelHint: HTMLParagraphElement;
  retagAllEnrichmentBtn: HTMLButtonElement;
  retagProgressHost: HTMLDivElement;

  // Settings - Ranking
  shortKeywordWeightInput: HTMLInputElement;
  shortSemanticWeightInput: HTMLInputElement;
  mediumKeywordWeightInput: HTMLInputElement;
  mediumSemanticWeightInput: HTMLInputElement;
  longKeywordWeightInput: HTMLInputElement;
  longSemanticWeightInput: HTMLInputElement;
  semanticRelevanceThresholdInput: HTMLInputElement;
  recencyBoostMaxInput: HTMLInputElement;
  rrfKInput: HTMLInputElement;
  resetRankingBtn: HTMLButtonElement;

  // Settings - Debug
  debugLoggingCheckbox: HTMLInputElement;
  debugLogPath: HTMLParagraphElement;
  openDebugFolderBtn: HTMLButtonElement;

  // Settings - Secret Detection (TruffleHog CLI controls live in the merged modal)
  trufflehogPathInput: HTMLInputElement;
  trufflehogPathHint: HTMLParagraphElement;
  trufflehogStatus: HTMLSpanElement;
  testTrufflehogBtn: HTMLButtonElement;
  trufflehogDownloadLink: HTMLAnchorElement;

  // Settings - Secret Detection (merged modal)
  secretMaskerSettingsModal: HTMLElement;
  secretMaskerEnabledCheckbox: HTMLInputElement;
  secretMaskerModelSelect: HTMLSelectElement;
  secretMaskerStatusHint: HTMLParagraphElement;

  // Settings - Search Autocomplete
  autocompleteSettingsModal: HTMLElement;
  autocompleteEnabledCheckbox: HTMLInputElement;
  autocompleteConfig: HTMLElement;
  autocompleteModelSelect: HTMLSelectElement;
  autocompleteModelHint: HTMLParagraphElement;

  // Settings - Inference Engine
  inferenceSettingsModal: HTMLElement;
  inferenceEngineSelect: HTMLSelectElement;
  inferenceBackendHint: HTMLParagraphElement;
  inferenceGpuLayersRow: HTMLElement;
  inferenceGpuLayersInput: HTMLInputElement;
  inferenceTestBtn: HTMLButtonElement;
  inferenceTestResult: HTMLElement;

  // Settings - Local AI Models
  aiModelsSettingsModal: HTMLElement;
  aiStatusList: HTMLDivElement;
  aiModelsLlmList: HTMLDivElement;
  aiModelsEmbeddingList: HTMLDivElement;
  aiModelsMaskerList: HTMLDivElement;
  aiModelsRefreshBtn: HTMLButtonElement;
  customModelRepoInput: HTMLInputElement;
  customModelFileInput: HTMLInputElement;
  customModelKindSelect: HTMLSelectElement;
  customModelDownloadBtn: HTMLButtonElement;
  customModelHint: HTMLParagraphElement;
}

export function createDom(): ScribeDom {
  return {
    // Shell
    toggleSidebarNav: byId("toggle-sidebar-nav"),
    toggleSidebarNavLabel: byId("toggle-sidebar-nav-label"),
    appSidebar: byId("app-sidebar"),
    sidebarNav: byId("sidebar-nav"),
    collectionsNav: byId("collections-nav"),
    newCollectionBtn: byId("new-collection-btn"),

    // Clipboard
    clipboardSearchInput: byId("clipboard-search-input"),
    clipboardSearchClearBtn: byId("clipboard-search-clear-btn"),
    clipboardBadgeFilterBtn: byId("clipboard-badge-filter-btn"),
    clipboardList: byId("clipboard-list"),
    clipboardEmpty: byId("clipboard-empty"),
    clipboardDetail: byId("clipboard-detail"),
    clipboardDetailContent: byId("clipboard-detail-content"),
    clipboardDetailSecretActions: byId("clipboard-detail-secret-actions"),
    clipboardDetailMeta: byId("clipboard-detail-meta"),
    clipboardDetailRelated: byId("clipboard-detail-related"),
    clipboardDetailDebug: byId("clipboard-detail-debug"),
    clipboardDetailClose: byId("clipboard-detail-close"),
    clipboardDetailDelete: byId("clipboard-detail-delete"),
    clipboardDetailPlaceholder: byId("clipboard-detail-placeholder"),
    clipboardStatusBar: byId("clipboard-status-bar"),
    clipboardStatusLeft: byId("clipboard-status-left"),
    clipboardStatusMeta: byId("clipboard-status-meta"),

    // Notes
    searchInput: byId("search-input"),
    searchClearBtn: byId("search-clear-btn"),
    notesBadgeFilterBtn: byId("notes-badge-filter-btn"),
    addNoteBtn: byId("add-note-btn"),
    importBtn: byId("import-btn"),
    quickAddForm: byId("quick-add-form"),
    quickAddInput: byId("quick-add-input"),
    quickAddBadgesInput: byId("quick-add-badges-input"),
    quickAddBadgeSuggestions: byId("quick-add-badge-suggestions"),
    quickAddBadgeColors: byId("quick-add-badge-colors"),
    quickAddSaveBtn: byId("quick-add-save-btn"),
    quickAddCancelBtn: byId("quick-add-cancel-btn"),
    notesList: byId("notes-list"),
    notesEmpty: byId("notes-empty"),
    noteDetail: byId("note-detail"),
    noteDetailContent: byId("note-detail-content"),
    noteDetailSecretActions: byId("note-detail-secret-actions"),
    noteDetailMeta: byId("note-detail-meta"),
    noteDetailRelated: byId("note-detail-related"),
    noteDetailDebug: byId("note-detail-debug"),
    noteDetailClose: byId("note-detail-close"),
    noteDetailDelete: byId("note-detail-delete"),
    noteDetailPlaceholder: byId("note-detail-placeholder"),
    notesStatusBar: byId("notes-status-bar"),
    notesStatusLeft: byId("notes-status-left"),
    notesStatusMeta: byId("notes-status-meta"),

    // Modals (backdrops)
    captureSettingsModal: byId("capture-settings-modal"),
    shortcutsSettingsModal: byId("shortcuts-settings-modal"),
    providersSettingsModal: byId("providers-settings-modal"),
    embeddingsSettingsModal: byId("embeddings-settings-modal"),
    enrichmentSettingsModal: byId("enrichment-settings-modal"),
    rankingSettingsModal: byId("ranking-settings-modal"),
    debugSettingsModal: byId("debug-settings-modal"),
    aboutModal: byId("about-modal"),
    addBadgeModal: byId("add-badge-modal"),
    importModal: byId("import-modal"),
    createCollectionModal: byId("create-collection-modal"),
    createCollectionInput: byId("create-collection-input"),
    createCollectionTypeStandard: byId("create-collection-type-standard"),
    createCollectionTypeChecklist: byId("create-collection-type-checklist"),
    createCollectionTypeFilter: byId("create-collection-type-filter"),
    createCollectionTypeHint: byId("create-collection-type-hint"),
    createCollectionIconPreview: byId("create-collection-icon-preview"),
    createCollectionIconPreviewLabel: byId(
      "create-collection-icon-preview-label",
    ),
    createCollectionIconSearchInput: byId("create-collection-icon-search-input"),
    createCollectionIconOptions: byId("create-collection-icon-options"),
    createCollectionIconHint: byId("create-collection-icon-hint"),
    createCollectionConfirmBtn: byId("create-collection-confirm-btn"),
    renameCollectionModal: byId("rename-collection-modal"),
    renameCollectionInput: byId("rename-collection-input"),
    renameCollectionConfirmBtn: byId("rename-collection-confirm-btn"),
    deleteCollectionModal: byId("delete-collection-modal"),
    deleteCollectionMessage: byId("delete-collection-message"),
    deleteCollectionDestinationSelect: byId("delete-collection-destination-select"),
    deleteCollectionConfirmBtn: byId("delete-collection-confirm-btn"),
    addBadgeInput: byId("add-badge-input"),
    addBadgeConfirmBtn: byId("add-badge-confirm-btn"),
    importTextInput: byId("import-text-input"),
    importFileInput: byId("import-file-input"),
    importChooseFilesBtn: byId("import-choose-files-btn"),
    importClearFilesBtn: byId("import-clear-files-btn"),
    importDropZone: byId("import-drop-zone"),
    importSelectedFiles: byId("import-selected-files"),
    importSelectedFilesEmpty: byId("import-selected-files-empty"),
    importSummary: byId("import-summary"),
    importConfirmBtn: byId("import-confirm-btn"),
    shortcutsEditableList: byId("shortcuts-editable-list"),
    shortcutsFixedList: byId("shortcuts-fixed-list"),
    shortcutsCaptureHint: byId("shortcuts-capture-hint"),
    shortcutsResetAllBtn: byId("shortcuts-reset-all-btn"),

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
    ollamaBaseUrl: byId("ollama-base-url"),
    testProviderBtn: byId("test-provider-btn"),
    providerStatus: byId("provider-status"),

    // Settings - Embeddings
    embeddingUnifiedModelSelect: byId("embedding-unified-model-select"),
    embeddingModelInput: byId("embedding-model-input"),
    refreshEmbeddingModelsBtn: byId("refresh-embedding-models-btn"),
    embeddingModelHint: byId("embedding-model-hint"),
    reembedAllBtn: byId("reembed-all-btn"),
    reembedProgressHost: byId("reembed-progress-host"),

    // Settings - Enrichment
    enrichmentSummaryEnabledCheckbox: byId("enrichment-summary-enabled-checkbox"),
    enrichmentTaggingEnabledCheckbox: byId("enrichment-tagging-enabled-checkbox"),
    enrichmentConfig: byId("enrichment-config"),
    enrichmentUnifiedModelSelect: byId("enrichment-unified-model-select"),
    refreshEnrichmentModelsBtn: byId("refresh-enrichment-models-btn"),
    enrichmentModelHint: byId("enrichment-model-hint"),
    retagAllEnrichmentBtn: byId("retag-all-enrichment-btn"),
    retagProgressHost: byId("retag-progress-host"),

    // Settings - Ranking
    shortKeywordWeightInput: byId("short-keyword-weight-input"),
    shortSemanticWeightInput: byId("short-semantic-weight-input"),
    mediumKeywordWeightInput: byId("medium-keyword-weight-input"),
    mediumSemanticWeightInput: byId("medium-semantic-weight-input"),
    longKeywordWeightInput: byId("long-keyword-weight-input"),
    longSemanticWeightInput: byId("long-semantic-weight-input"),
    semanticRelevanceThresholdInput: byId("semantic-relevance-threshold-input"),
    recencyBoostMaxInput: byId("recency-boost-max-input"),
    rrfKInput: byId("rrf-k-input"),
    resetRankingBtn: byId("reset-ranking-btn"),

    // Settings - Debug
    debugLoggingCheckbox: byId("debug-logging-checkbox"),
    debugLogPath: byId("debug-log-path"),
    openDebugFolderBtn: byId("open-debug-folder-btn"),

    // Settings - Secret Detection (TruffleHog CLI controls live in the merged modal)
    trufflehogPathInput: byId("trufflehog-path-input"),
    trufflehogPathHint: byId("trufflehog-path-hint"),
    trufflehogStatus: byId("trufflehog-status"),
    testTrufflehogBtn: byId("test-trufflehog-btn"),
    trufflehogDownloadLink: byId("trufflehog-download-link"),

    // Settings - Secret Detection (merged modal)
    secretMaskerSettingsModal: byId("secret-masker-settings-modal"),
    secretMaskerEnabledCheckbox: byId("secret-masker-enabled-checkbox"),
    secretMaskerModelSelect: byId("secret-masker-model-select"),
    secretMaskerStatusHint: byId("secret-masker-status-hint"),
    autocompleteSettingsModal: byId("autocomplete-settings-modal"),
    autocompleteEnabledCheckbox: byId("autocomplete-enabled-checkbox"),
    autocompleteConfig: byId("autocomplete-config"),
    autocompleteModelSelect: byId("autocomplete-model-select"),
    autocompleteModelHint: byId("autocomplete-model-hint"),
    inferenceSettingsModal: byId("inference-settings-modal"),
    inferenceEngineSelect: byId("inference-engine-select"),
    inferenceBackendHint: byId("inference-backend-hint"),
    inferenceGpuLayersRow: byId("inference-gpu-layers-row"),
    inferenceGpuLayersInput: byId("inference-gpu-layers-input"),
    inferenceTestBtn: byId("inference-test-btn"),
    inferenceTestResult: byId("inference-test-result"),

    // Settings - Local AI Models
    aiModelsSettingsModal: byId("ai-models-settings-modal"),
    aiStatusList: byId("ai-status-list"),
    aiModelsLlmList: byId("ai-models-llm-list"),
    aiModelsEmbeddingList: byId("ai-models-embedding-list"),
    aiModelsMaskerList: byId("ai-models-masker-list"),
    aiModelsRefreshBtn: byId("ai-models-refresh-btn"),
    customModelRepoInput: byId("custom-model-repo-input"),
    customModelFileInput: byId("custom-model-file-input"),
    customModelKindSelect: byId("custom-model-kind-select"),
    customModelDownloadBtn: byId("custom-model-download-btn"),
    customModelHint: byId("custom-model-hint"),
  };
}
