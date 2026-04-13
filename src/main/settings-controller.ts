import type { ScribeDom } from "./dom";
import type { Settings, EmbeddingProvider, EnrichmentProvider } from "../settings";
import { saveSettings } from "../settings";

export function populateSettingsUI(dom: ScribeDom, settings: Settings): void {
  dom.clipboardMonitoringCheckbox.checked = settings.clipboardMonitoring;

  // Providers setup section
  dom.openaiApiKey.value = settings.providers.openai.apiKey;
  dom.geminiApiKey.value = settings.providers.gemini.apiKey;
  dom.ollamaBaseUrl.value = settings.providers.ollama.baseUrl;

  // Embeddings section
  updateEmbeddingModelOptions(dom, settings);

  // Enrichment section
  dom.enrichmentEnabledCheckbox.checked = settings.enrichmentEnabled;
  updateEnrichmentModelOptions(dom, settings);

  // Debug section
  dom.debugLoggingCheckbox.checked = settings.debugLoggingEnabled;

  // TruffleHog
  dom.trufflehogPathInput.value = settings.trufflehogPath;

  updateProviderSetupSections(dom);
  updateEmbeddingVisibility(dom, settings.embeddingProvider);
  updateEnrichmentVisibility(dom, settings.enrichmentEnabled);
}
export function updateProviderSetupSections(dom: ScribeDom): void {
  const provider = dom.providerSetupSelect.value;
  dom.setupOpenaiSection.hidden = provider !== "openai";
  dom.setupGeminiSection.hidden = provider !== "gemini";
  dom.setupOllamaSection.hidden = provider !== "ollama";
  dom.setupLocalSection.hidden = provider !== "local";
}

export function updateEmbeddingVisibility(
  dom: ScribeDom,
  provider: EmbeddingProvider
): void {
  const isOllama = provider === "ollama";
  const isLocal = provider === "local";
  dom.embeddingModelInput.hidden = !isOllama;
  dom.refreshEmbeddingModelsBtn.hidden = isOllama || isLocal || provider === "none";
}

export function updateEnrichmentVisibility(dom: ScribeDom, enabled: boolean): void {
  dom.enrichmentConfig.hidden = !enabled;
}

export function updateEmbeddingModelOptions(dom: ScribeDom, settings: Settings): void {
  const select = dom.embeddingUnifiedModelSelect;
  select.innerHTML = "";

  // None option
  const noneOpt = document.createElement("option");
  noneOpt.value = "none|";
  noneOpt.textContent = "None (keyword search only)";
  if (settings.embeddingProvider === "none") noneOpt.selected = true;
  select.appendChild(noneOpt);

  // Local (MiniLM)
  const localGroup = document.createElement("optgroup");
  localGroup.label = "Local Inference";
  const localOpt = document.createElement("option");
  localOpt.value = "local|MiniLM-L6-v2";
  localOpt.textContent = "MiniLM-L6-v2 (Built-in)";
  if (settings.embeddingProvider === "local") localOpt.selected = true;
  localGroup.appendChild(localOpt);
  select.appendChild(localGroup);

  // OpenAI
  const openaiGroup = document.createElement("optgroup");
  openaiGroup.label = "OpenAI";
  const openaiModels = settings.providers.openai.modelCache?.embeddingModels || getFallbackModels("openai", "embedding");
  openaiModels.forEach(model => {
    const opt = document.createElement("option");
    opt.value = `openai|${model}`;
    opt.textContent = model;
    if (settings.embeddingProvider === "openai" && settings.embeddingModel === model) opt.selected = true;
    openaiGroup.appendChild(opt);
  });
  select.appendChild(openaiGroup);

  // Gemini
  const geminiGroup = document.createElement("optgroup");
  geminiGroup.label = "Google Gemini";
  const geminiModels = settings.providers.gemini.modelCache?.embeddingModels || getFallbackModels("gemini", "embedding");
  geminiModels.forEach(model => {
    const opt = document.createElement("option");
    opt.value = `gemini|${model}`;
    opt.textContent = model;
    if (settings.embeddingProvider === "gemini" && settings.embeddingModel === model) opt.selected = true;
    geminiGroup.appendChild(opt);
  });
  select.appendChild(geminiGroup);

  // Ollama
  const ollamaGroup = document.createElement("optgroup");
  ollamaGroup.label = "Local (Ollama)";
  const ollamaOpt = document.createElement("option");
  ollamaOpt.value = "ollama|custom";
  ollamaOpt.textContent = "Custom local model...";
  if (settings.embeddingProvider === "ollama") {
    ollamaOpt.selected = true;
    dom.embeddingModelInput.value = settings.embeddingModel;
  }
  ollamaGroup.appendChild(ollamaOpt);
  select.appendChild(ollamaGroup);

  const openaiFetchedAt = settings.providers.openai.modelCache?.fetchedAt;
  const geminiFetchedAt = settings.providers.gemini.modelCache?.fetchedAt;
  if (!openaiFetchedAt && !geminiFetchedAt) {
    dom.embeddingModelHint.textContent = "Click refresh to fetch latest models.";
  } else {
    dom.embeddingModelHint.textContent = "Models discovered and cached.";
  }
}

export function updateEnrichmentModelOptions(dom: ScribeDom, settings: Settings): void {
  const select = dom.enrichmentUnifiedModelSelect;
  select.innerHTML = "";

  // None option
  const noneOpt = document.createElement("option");
  noneOpt.value = "none|";
  noneOpt.textContent = "None (disable AI enrichment)";
  if (settings.enrichmentProvider === "none") noneOpt.selected = true;
  select.appendChild(noneOpt);

  // OpenAI
  const openaiGroup = document.createElement("optgroup");
  openaiGroup.label = "OpenAI";
  const openaiModels = settings.providers.openai.modelCache?.chatModels || getFallbackModels("openai", "chat");
  openaiModels.forEach(model => {
    const opt = document.createElement("option");
    opt.value = `openai|${model}`;
    opt.textContent = model;
    if (settings.enrichmentProvider === "openai" && settings.enrichmentModel === model) opt.selected = true;
    openaiGroup.appendChild(opt);
  });
  select.appendChild(openaiGroup);

  // Gemini
  const geminiGroup = document.createElement("optgroup");
  geminiGroup.label = "Google Gemini";
  const geminiModels = settings.providers.gemini.modelCache?.chatModels || getFallbackModels("gemini", "chat");
  geminiModels.forEach(model => {
    const opt = document.createElement("option");
    opt.value = `gemini|${model}`;
    opt.textContent = model;
    if (settings.enrichmentProvider === "gemini" && settings.enrichmentModel === model) opt.selected = true;
    geminiGroup.appendChild(opt);
  });
  select.appendChild(geminiGroup);

  const openaiFetchedAt = settings.providers.openai.modelCache?.fetchedAt;
  const geminiFetchedAt = settings.providers.gemini.modelCache?.fetchedAt;
  if (!openaiFetchedAt && !geminiFetchedAt) {
    dom.enrichmentModelHint.textContent = "Click refresh to fetch latest models.";
  } else {
    dom.enrichmentModelHint.textContent = "Models discovered and cached.";
  }
  dom.refreshEnrichmentModelsBtn.hidden = settings.enrichmentProvider === "none";
}

function getFallbackModels(provider: "openai" | "gemini", type: "embedding" | "chat"): string[] {
  if (provider === "openai") {
    return type === "embedding" 
      ? ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"]
      : ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"];
  } else {
    return type === "embedding"
      ? ["gemini-embedding-001"]
      : ["gemini-2.5-flash", "gemini-2.5-pro"];
  }
}

export function readSettingsFromForm(dom: ScribeDom, current: Settings): Settings {
  const [embeddingProviderStr, embeddingModelValue] = dom.embeddingUnifiedModelSelect.value.split("|");
  const embeddingProvider = embeddingProviderStr as EmbeddingProvider;
  
  const [enrichmentProviderStr, enrichmentModelValue] = dom.enrichmentUnifiedModelSelect.value.split("|");
  const enrichmentProvider = enrichmentProviderStr as EnrichmentProvider;

  return {
    ...current,
    clipboardMonitoring: dom.clipboardMonitoringCheckbox.checked,
    providers: {
      openai: {
        ...current.providers.openai,
        apiKey: dom.openaiApiKey.value.trim(),
      },
      gemini: {
        ...current.providers.gemini,
        apiKey: dom.geminiApiKey.value.trim(),
      },
      ollama: {
        baseUrl: dom.ollamaBaseUrl.value.trim(),
      },
    },
    embeddingProvider,
    embeddingModel: embeddingProvider === "ollama" ? dom.embeddingModelInput.value.trim() : (embeddingModelValue || ""),
    enrichmentEnabled: dom.enrichmentEnabledCheckbox.checked,
    enrichmentProvider,
    enrichmentModel: enrichmentModelValue || "",
    debugLoggingEnabled: dom.debugLoggingCheckbox.checked,
    trufflehogPath: dom.trufflehogPathInput.value.trim(),
  };
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleAutosave(
  dom: ScribeDom,
  current: Settings,
  onSaved: (updated: Settings) => void,
  delayMs = 600,
  onInput?: (updated: Settings) => void
): void {
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  
  const updated = readSettingsFromForm(dom, current);
  if (onInput) onInput(updated);

  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    await saveSettings(updated);
    onSaved(updated);
  }, delayMs);
}

export function cancelAutosave(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}
