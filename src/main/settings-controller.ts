import { invoke } from "@tauri-apps/api/core";
import type { ScribeDom } from "./dom";
import type { Settings, EmbeddingProvider, EnrichmentProvider } from "../settings";
import { getDefaultRankingSettings } from "../settings";
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
  dom.enrichmentSummaryEnabledCheckbox.checked = settings.enrichmentSummaryEnabled;
  dom.enrichmentTaggingEnabledCheckbox.checked = settings.enrichmentTaggingEnabled;
  updateEnrichmentModelOptions(dom, settings);

  // Ranking section
  populateRankingSettingsUI(dom, settings);

  // Debug section
  dom.debugLoggingCheckbox.checked = settings.debugLoggingEnabled;

  // TruffleHog
  dom.trufflehogPathInput.value = settings.trufflehogPath;

  // Secret Masker
  dom.secretMaskerEnabledCheckbox.checked = settings.secretMaskerEnabled;

  updateProviderSetupSections(dom);
  updateEmbeddingVisibility(dom, settings.embeddingProvider);
  updateEnrichmentVisibility(
    dom,
    settings.enrichmentSummaryEnabled || settings.enrichmentTaggingEnabled,
  );
}

export function populateRankingSettingsUI(dom: ScribeDom, settings: Pick<Settings, "ranking">): void {
  dom.shortKeywordWeightInput.value = String(settings.ranking.shortKeywordWeight);
  dom.shortSemanticWeightInput.value = String(settings.ranking.shortSemanticWeight);
  dom.mediumKeywordWeightInput.value = String(settings.ranking.mediumKeywordWeight);
  dom.mediumSemanticWeightInput.value = String(settings.ranking.mediumSemanticWeight);
  dom.longKeywordWeightInput.value = String(settings.ranking.longKeywordWeight);
  dom.longSemanticWeightInput.value = String(settings.ranking.longSemanticWeight);
  dom.semanticRelevanceThresholdInput.value = String(settings.ranking.semanticRelevanceThreshold);
  dom.recencyBoostMaxInput.value = String(settings.ranking.recencyBoostMax);
  dom.rrfKInput.value = String(settings.ranking.rrfK);
}

export function resetRankingSettingsUI(dom: ScribeDom): void {
  populateRankingSettingsUI(dom, { ranking: getDefaultRankingSettings() });
}

function readNumberInput(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
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

  // Local Qwen
  const localGroup = document.createElement("optgroup");
  localGroup.label = "Local Inference";
  const qwenOpt = document.createElement("option");
  qwenOpt.value = "local-qwen|qwen2.5-0.5b-instruct";
  qwenOpt.textContent = "Qwen2.5-0.5B (Built-in, offline)";
  if (settings.enrichmentProvider === "local-qwen") qwenOpt.selected = true;
  localGroup.appendChild(qwenOpt);
  select.appendChild(localGroup);

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
  dom.refreshEnrichmentModelsBtn.hidden =
    settings.enrichmentProvider === "none" ||
    settings.enrichmentProvider === "local-qwen";
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
    ranking: {
      shortKeywordWeight: readNumberInput(dom.shortKeywordWeightInput, current.ranking.shortKeywordWeight),
      shortSemanticWeight: readNumberInput(dom.shortSemanticWeightInput, current.ranking.shortSemanticWeight),
      mediumKeywordWeight: readNumberInput(dom.mediumKeywordWeightInput, current.ranking.mediumKeywordWeight),
      mediumSemanticWeight: readNumberInput(dom.mediumSemanticWeightInput, current.ranking.mediumSemanticWeight),
      longKeywordWeight: readNumberInput(dom.longKeywordWeightInput, current.ranking.longKeywordWeight),
      longSemanticWeight: readNumberInput(dom.longSemanticWeightInput, current.ranking.longSemanticWeight),
      semanticRelevanceThreshold: readNumberInput(dom.semanticRelevanceThresholdInput, current.ranking.semanticRelevanceThreshold),
      recencyBoostMax: readNumberInput(dom.recencyBoostMaxInput, current.ranking.recencyBoostMax),
      rrfK: readNumberInput(dom.rrfKInput, current.ranking.rrfK),
    },
    enrichmentSummaryEnabled: dom.enrichmentSummaryEnabledCheckbox.checked,
    enrichmentTaggingEnabled: dom.enrichmentTaggingEnabledCheckbox.checked,
    enrichmentProvider,
    enrichmentModel: enrichmentModelValue || "",
    debugLoggingEnabled: dom.debugLoggingCheckbox.checked,
    trufflehogPath: dom.trufflehogPathInput.value.trim(),
    secretMaskerEnabled: dom.secretMaskerEnabledCheckbox.checked,
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

export function wireReembedAllButton(dom: ScribeDom): void {
  dom.reembedAllBtn.addEventListener("click", async () => {
    const btn = dom.reembedAllBtn;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Regenerating...";

    try {
      await invoke("reembed_all_entries");
      btn.textContent = "Done!";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
    } catch (err) {
      btn.textContent = originalText;
      btn.disabled = false;
      console.error("reembed_all_entries failed:", err);
      dom.embeddingModelHint.textContent = `Re-embed failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
}
