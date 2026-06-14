import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ScribeDom } from "./dom";
import type { Settings, EmbeddingProvider, EnrichmentProvider } from "../settings";
import { getDefaultRankingSettings, LOCAL_QWEN_MODEL_ID } from "../settings";
import { saveSettings } from "../settings";
import { createProgressBar } from "./progress-bar";

// ── Installed local LLM models (populated by models-controller) ─────────────

export interface LocalLlmModelOption {
  id: string;
  label: string;
  path: string;
}

/** Registry id of the legacy bundled model; old settings stored the bare
 *  model name, which maps onto this entry. */
const LEGACY_LOCAL_LLM_ID = "qwen2.5-0.5b-instruct-q4_0";

/** Registry id matching the legacy "MiniLM-L6-v2" embedding model value. */
const LEGACY_LOCAL_EMBEDDING_ID = "minilm-l6-v2-onnx";

let installedLlmModels: LocalLlmModelOption[] = [];
let installedEmbeddingModels: LocalLlmModelOption[] = [];
let installedMaskerModels: LocalLlmModelOption[] = [];

export function setInstalledLlmModels(models: LocalLlmModelOption[]): void {
  installedLlmModels = models;
}

export function getInstalledLlmModels(): LocalLlmModelOption[] {
  return installedLlmModels;
}

export function setInstalledEmbeddingModels(models: LocalLlmModelOption[]): void {
  installedEmbeddingModels = models;
}

export function setInstalledMaskerModels(models: LocalLlmModelOption[]): void {
  installedMaskerModels = models;
}

function selectedLocalLlmId(settings: Settings): string {
  return settings.enrichmentModel === LOCAL_QWEN_MODEL_ID || !settings.enrichmentModel
    ? LEGACY_LOCAL_LLM_ID
    : settings.enrichmentModel;
}

function selectedLocalEmbeddingId(settings: Settings): string {
  return settings.embeddingModel === "MiniLM-L6-v2" || !settings.embeddingModel
    ? LEGACY_LOCAL_EMBEDDING_ID
    : settings.embeddingModel;
}

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
  updateSecretMaskerModelOptions(dom, settings);

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

  // Local models (installed ONNX embedders discovered by the model manager)
  const localGroup = document.createElement("optgroup");
  localGroup.label = "Local Inference (offline)";
  const isLocalEmbeddingProvider = settings.embeddingProvider === "local";
  const selectedEmbeddingId = selectedLocalEmbeddingId(settings);
  let matchedLocalEmbedding = false;
  for (const model of installedEmbeddingModels) {
    const opt = document.createElement("option");
    opt.value = `local|${model.id}`;
    opt.textContent = model.label;
    if (isLocalEmbeddingProvider && model.id === selectedEmbeddingId) {
      opt.selected = true;
      matchedLocalEmbedding = true;
    }
    localGroup.appendChild(opt);
  }
  if (isLocalEmbeddingProvider && !matchedLocalEmbedding) {
    const opt = document.createElement("option");
    opt.value = `local|${selectedEmbeddingId}`;
    opt.textContent = `${selectedEmbeddingId} (not installed)`;
    opt.selected = true;
    localGroup.appendChild(opt);
  } else if (installedEmbeddingModels.length === 0) {
    const opt = document.createElement("option");
    opt.value = `local|${LEGACY_LOCAL_EMBEDDING_ID}`;
    opt.textContent = "Local model (none installed — see Local AI Models)";
    localGroup.appendChild(opt);
  }
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

  if (isLocalEmbeddingProvider && !matchedLocalEmbedding) {
    dom.embeddingModelHint.textContent =
      "Selected local model is not installed — open Settings → Local AI Models to download one.";
  } else if (isLocalEmbeddingProvider) {
    dom.embeddingModelHint.textContent =
      "Runs fully offline. After switching models, regenerate all embeddings.";
  } else {
    const openaiFetchedAt = settings.providers.openai.modelCache?.fetchedAt;
    const geminiFetchedAt = settings.providers.gemini.modelCache?.fetchedAt;
    if (!openaiFetchedAt && !geminiFetchedAt) {
      dom.embeddingModelHint.textContent = "Click refresh to fetch latest models.";
    } else {
      dom.embeddingModelHint.textContent = "Models discovered and cached.";
    }
  }
}

export function updateSecretMaskerModelOptions(dom: ScribeDom, settings: Settings): void {
  const select = dom.secretMaskerModelSelect;
  select.innerHTML = "";

  const selectedPath = settings.secretMaskerModelPath?.trim() ?? "";
  let matched = false;

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Default (bundled / downloaded slot)";
  if (!selectedPath) {
    defaultOpt.selected = true;
    matched = true;
  }
  select.appendChild(defaultOpt);

  for (const model of installedMaskerModels) {
    const opt = document.createElement("option");
    opt.value = model.path;
    opt.textContent = model.label;
    if (selectedPath && model.path === selectedPath) {
      opt.selected = true;
      matched = true;
    }
    select.appendChild(opt);
  }

  if (!matched && selectedPath) {
    const opt = document.createElement("option");
    opt.value = selectedPath;
    opt.textContent = `${selectedPath} (missing)`;
    opt.selected = true;
    select.appendChild(opt);
  }

  if (installedMaskerModels.length === 0) {
    dom.secretMaskerStatusHint.textContent =
      "⚠ No secret masker model installed — ML-based masking is inactive (TruffleHog still runs). Open Settings → Local AI Models to download one.";
  } else {
    dom.secretMaskerStatusHint.textContent = "";
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

  // Local models (installed GGUFs discovered by the model manager)
  const localGroup = document.createElement("optgroup");
  localGroup.label = "Local Inference (offline)";
  const isLocalProvider = settings.enrichmentProvider === "local-qwen";
  const selectedId = selectedLocalLlmId(settings);
  let matchedSelection = false;
  for (const model of installedLlmModels) {
    const opt = document.createElement("option");
    opt.value = `local-qwen|${model.id}`;
    opt.textContent = model.label;
    if (isLocalProvider && model.id === selectedId) {
      opt.selected = true;
      matchedSelection = true;
    }
    localGroup.appendChild(opt);
  }
  if (isLocalProvider && !matchedSelection) {
    const opt = document.createElement("option");
    opt.value = `local-qwen|${selectedId}`;
    opt.textContent = `${selectedId} (not installed)`;
    opt.selected = true;
    localGroup.appendChild(opt);
  } else if (installedLlmModels.length === 0) {
    const opt = document.createElement("option");
    opt.value = `local-qwen|${LEGACY_LOCAL_LLM_ID}`;
    opt.textContent = "Local model (none installed — see Local AI Models)";
    localGroup.appendChild(opt);
  }
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

  if (isLocalProvider && !matchedSelection) {
    dom.enrichmentModelHint.textContent =
      "Selected local model is not installed — open Settings → Local AI Models to download one.";
  } else if (isLocalProvider) {
    dom.enrichmentModelHint.textContent = "Runs fully offline via the local LLM engine.";
  } else {
    const openaiFetchedAt = settings.providers.openai.modelCache?.fetchedAt;
    const geminiFetchedAt = settings.providers.gemini.modelCache?.fetchedAt;
    if (!openaiFetchedAt && !geminiFetchedAt) {
      dom.enrichmentModelHint.textContent = "Click refresh to fetch latest models.";
    } else {
      dom.enrichmentModelHint.textContent = "Models discovered and cached.";
    }
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

  // Resolve the on-disk path for a locally selected model; empty string falls
  // back to the legacy bundled location (and fails fast with a clear error).
  const localLlmModelPath =
    enrichmentProvider === "local-qwen"
      ? installedLlmModels.find((m) => m.id === (enrichmentModelValue || ""))?.path ?? ""
      : current.localLlmModelPath;
  const localEmbeddingModelPath =
    embeddingProvider === "local"
      ? installedEmbeddingModels.find((m) => m.id === (embeddingModelValue || ""))?.path ?? ""
      : current.localEmbeddingModelPath;

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
    localEmbeddingModelPath,
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
    localLlmModelPath,
    debugLoggingEnabled: dom.debugLoggingCheckbox.checked,
    trufflehogPath: dom.trufflehogPathInput.value.trim(),
    secretMaskerEnabled: dom.secretMaskerEnabledCheckbox.checked,
    secretMaskerModelPath: dom.secretMaskerModelSelect.value,
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

interface ReembedProgress {
  done: number;
  total: number;
  failed: number;
  elapsed_ms: number;
  finished: boolean;
}

export function wireReembedAllButton(dom: ScribeDom, getSettings: () => Settings): void {
  dom.reembedAllBtn.addEventListener("click", async () => {
    const btn = dom.reembedAllBtn;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Regenerating…";

    const progress = createProgressBar(dom.reembedProgressHost);
    // The backend drives progress via events; the bar's own timer is only a
    // fallback, so feed it the backend's authoritative counts directly.
    const unlisten = await listen<ReembedProgress>("reembed-progress", (event) => {
      const p = event.payload;
      if (p.finished) {
        progress.finish(
          p.failed > 0 ? `Done · ${p.failed} failed` : "Done",
        );
      } else {
        progress.update(p.done, p.total);
      }
    });

    try {
      await invoke("reembed_all_entries", {
        modelPath: getSettings().localEmbeddingModelPath?.trim() || null,
      });
      btn.textContent = "Done!";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
        progress.reset();
      }, 2500);
    } catch (err) {
      btn.textContent = originalText;
      btn.disabled = false;
      progress.reset();
      console.error("reembed_all_entries failed:", err);
      dom.embeddingModelHint.textContent = `Re-embed failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      unlisten();
    }
  });
}
