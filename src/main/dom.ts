export interface ScribeDom {
  // Tabs
  tabEntries: HTMLButtonElement;
  tabSettings: HTMLButtonElement;
  panelEntries: HTMLDivElement;
  panelSettings: HTMLDivElement;

  // Window controls
  minimizeBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;

  // Entries panel
  searchInput: HTMLInputElement;
  searchClearBtn: HTMLButtonElement;
  addEntryBtn: HTMLButtonElement;
  quickAddForm: HTMLDivElement;
  quickAddInput: HTMLTextAreaElement;
  quickAddSaveBtn: HTMLButtonElement;
  quickAddCancelBtn: HTMLButtonElement;
  entriesList: HTMLDivElement;
  entriesEmpty: HTMLDivElement;
  entryDetail: HTMLDivElement;
  entryDetailContent: HTMLDivElement;
  entryDetailSecretActions: HTMLDivElement;
  entryDetailMeta: HTMLDivElement;
  entryDetailClose: HTMLButtonElement;
  entryDetailDelete: HTMLButtonElement;

  // Settings — capture
  clipboardMonitoringCheckbox: HTMLInputElement;

  // Settings — AI Providers
  providerSetupSelect: HTMLSelectElement;
  setupOpenAiSection: HTMLDivElement;
  openaiApiKey: HTMLInputElement;
  toggleOpenAiKeyBtn: HTMLButtonElement;
  setupGeminiSection: HTMLDivElement;
  geminiApiKey: HTMLInputElement;
  toggleGeminiKeyBtn: HTMLButtonElement;
  setupOllamaSection: HTMLDivElement;
  setupLocalSection: HTMLDivElement;
  ollamaBaseUrl: HTMLInputElement;
  testProviderBtn: HTMLButtonElement;
  providerStatus: HTMLSpanElement;

  // Settings — Embeddings
  embeddingUnifiedModelSelect: HTMLSelectElement;
  embeddingModelInput: HTMLInputElement;
  refreshEmbeddingModelsBtn: HTMLButtonElement;
  embeddingModelHint: HTMLParagraphElement;

  // Settings — Enrichment
  enrichmentEnabledCheckbox: HTMLInputElement;
  enrichmentConfig: HTMLDivElement;
  enrichmentUnifiedModelSelect: HTMLSelectElement;
  refreshEnrichmentModelsBtn: HTMLButtonElement;
  enrichmentModelHint: HTMLParagraphElement;

  // Settings — Debug
  debugLoggingCheckbox: HTMLInputElement;
  debugLogPath: HTMLParagraphElement;
  openDebugFolderBtn: HTMLButtonElement;
}

function el<T extends HTMLElement>(id: string): T {
  const elem = document.getElementById(id);
  if (!elem) throw new Error(`Element #${id} not found`);
  return elem as T;
}

export function getDom(): ScribeDom {
  return {
    tabEntries: el("tab-entries"),
    tabSettings: el("tab-settings"),
    panelEntries: el("panel-entries"),
    panelSettings: el("panel-settings"),

    minimizeBtn: el("minimize-btn"),
    closeBtn: el("close-btn"),

    searchInput: el("search-input"),
    searchClearBtn: el("search-clear-btn"),
    addEntryBtn: el("add-entry-btn"),
    quickAddForm: el("quick-add-form"),
    quickAddInput: el("quick-add-input"),
    quickAddSaveBtn: el("quick-add-save-btn"),
    quickAddCancelBtn: el("quick-add-cancel-btn"),
    entriesList: el("entries-list"),
    entriesEmpty: el("entries-empty"),
    entryDetail: el("entry-detail"),
    entryDetailContent: el("entry-detail-content"),
    entryDetailSecretActions: el("entry-detail-secret-actions"),
    entryDetailMeta: el("entry-detail-meta"),
    entryDetailClose: el("entry-detail-close"),
    entryDetailDelete: el("entry-detail-delete"),

    clipboardMonitoringCheckbox: el("clipboard-monitoring-checkbox"),

    providerSetupSelect: el("provider-setup-select"),
    setupOpenAiSection: el("setup-openai-section"),
    openaiApiKey: el("openai-api-key"),
    toggleOpenAiKeyBtn: el("toggle-openai-key-btn"),
    setupGeminiSection: el("setup-gemini-section"),
    geminiApiKey: el("gemini-api-key"),
    toggleGeminiKeyBtn: el("toggle-gemini-key-btn"),
    setupOllamaSection: el("setup-ollama-section"),
    setupLocalSection: el("setup-local-section"),
    ollamaBaseUrl: el("ollama-base-url"),
    testProviderBtn: el("test-provider-btn"),
    providerStatus: el("provider-status"),

    embeddingUnifiedModelSelect: el("embedding-unified-model-select"),
    embeddingModelInput: el("embedding-model-input"),
    refreshEmbeddingModelsBtn: el("refresh-embedding-models-btn"),
    embeddingModelHint: el("embedding-model-hint"),

    enrichmentEnabledCheckbox: el("enrichment-enabled-checkbox"),
    enrichmentConfig: el("enrichment-config"),
    enrichmentUnifiedModelSelect: el("enrichment-unified-model-select"),
    refreshEnrichmentModelsBtn: el("refresh-enrichment-models-btn"),
    enrichmentModelHint: el("enrichment-model-hint"),

    debugLoggingCheckbox: el("debug-logging-checkbox"),
    debugLogPath: el("debug-log-path"),
    openDebugFolderBtn: el("open-debug-folder-btn"),
  };
}
