import { load, Store } from "@tauri-apps/plugin-store";
import { sanitizeShortcutOverrides, type ShortcutOverrides } from "./shortcuts";

export type EmbeddingProvider = "none" | "openai" | "gemini" | "ollama" | "local";
export type EnrichmentProvider = "none" | "openai" | "gemini" | "local-qwen";
/** Autocomplete always uses a real model when enabled (enable/disable is a
 *  separate toggle), so unlike enrichment there is no "none" provider. */
export type AutocompleteProvider = "openai" | "gemini" | "local-qwen";

export const LOCAL_QWEN_MODEL_ID = "qwen2.5-0.5b-instruct";

export interface ProviderModelCache {
  apiKeyFingerprint: string;
  fetchedAt: number;
  embeddingModels: string[];
  chatModels: string[];
}

export interface OpenAIProviderSettings {
  apiKey: string;
  modelCache: ProviderModelCache | null;
}

export interface GeminiProviderSettings {
  apiKey: string;
  modelCache: ProviderModelCache | null;
}

export interface OllamaProviderSettings {
  baseUrl: string;
}

export interface RankingSettings {
  shortKeywordWeight: number;
  shortSemanticWeight: number;
  mediumKeywordWeight: number;
  mediumSemanticWeight: number;
  longKeywordWeight: number;
  longSemanticWeight: number;
  semanticRelevanceThreshold: number;
  recencyBoostMax: number;
  rrfK: number;
}

export interface Settings {
  // Capture
  clipboardMonitoring: boolean;

  // Providers
  providers: {
    openai: OpenAIProviderSettings;
    gemini: GeminiProviderSettings;
    ollama: OllamaProviderSettings;
  };

  // Embeddings
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string;
  /** Absolute path of the local ONNX embedding model used when
   *  embeddingProvider is "local". Empty string = legacy bundled location. */
  localEmbeddingModelPath: string;

  // Ranking
  ranking: RankingSettings;

  // AI enrichment
  enrichmentSummaryEnabled: boolean;
  enrichmentTaggingEnabled: boolean;
  enrichmentProvider: EnrichmentProvider;
  enrichmentModel: string;
  /** Absolute path of the local GGUF used when enrichmentProvider is "local-qwen".
   *  Empty string means "use the legacy bundled location". */
  localLlmModelPath: string;

  // Debug
  debugLoggingEnabled: boolean;

  // TruffleHog
  trufflehogPath: string;

  // Secret masker ML model
  secretMaskerEnabled: boolean;
  /** Absolute path of the secret-masker ONNX model. Empty string = legacy
   *  bundled location. */
  secretMaskerModelPath: string;

  // Search autocomplete (inline ghost-text suggestions)
  autocompleteEnabled: boolean;
  autocompleteProvider: AutocompleteProvider;
  autocompleteModel: string;
  /** Absolute path of the local LLM used when autocompleteProvider is
   *  "local-qwen". Empty string = the default/bundled LLM location. */
  autocompleteModelPath: string;

  // Editable shortcut overrides
  shortcutOverrides: ShortcutOverrides;
}

const DEFAULTS: Settings = {
  clipboardMonitoring: true,
  providers: {
    openai: {
      apiKey: "",
      modelCache: null,
    },
    gemini: {
      apiKey: "",
      modelCache: null,
    },
    ollama: {
      baseUrl: "http://localhost:11434",
    },
  },
  embeddingProvider: "none",
  embeddingModel: "text-embedding-3-small",
  localEmbeddingModelPath: "",
  ranking: {
    shortKeywordWeight: 1.35,
    shortSemanticWeight: 2,
    mediumKeywordWeight: 1.15,
    mediumSemanticWeight: 2.85,
    longKeywordWeight: 1.0,
    longSemanticWeight: 2,
    semanticRelevanceThreshold: 0.385,
    recencyBoostMax: 0.02,
    rrfK: 10,
  },
  enrichmentSummaryEnabled: false,
  enrichmentTaggingEnabled: true,
  enrichmentProvider: "local-qwen",
  enrichmentModel: LOCAL_QWEN_MODEL_ID,
  localLlmModelPath: "",
  debugLoggingEnabled: false,
  trufflehogPath: "",
  secretMaskerEnabled: true,
  secretMaskerModelPath: "",
  autocompleteEnabled: false,
  autocompleteProvider: "local-qwen",
  autocompleteModel: LOCAL_QWEN_MODEL_ID,
  autocompleteModelPath: "",
  shortcutOverrides: {},
};

export function getDefaultSettings(): Settings {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

export function getDefaultRankingSettings(): RankingSettings {
  return JSON.parse(JSON.stringify(DEFAULTS.ranking));
}

let store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await load("settings.json", { autoSave: true, defaults: {} });
  }
  return store;
}

export async function loadSettings(): Promise<Settings> {
  const s = await getStore();
  const settings: Settings = getDefaultSettings();

  const read = async <T>(key: string): Promise<T | undefined> =>
    s.get<T>(key);

  settings.clipboardMonitoring = (await read<boolean>("clipboardMonitoring")) ?? settings.clipboardMonitoring;
  
  const providers = await read<Settings["providers"]>("providers");
  if (providers) {
    settings.providers = { ...settings.providers, ...providers };
  } else {
    // Migration from old flat structure if exists
    const oldOpenAiKey = await read<string>("embeddingOpenAiKey");
    if (oldOpenAiKey) settings.providers.openai.apiKey = oldOpenAiKey;
    const oldGeminiKey = await read<string>("embeddingGeminiKey");
    if (oldGeminiKey) settings.providers.gemini.apiKey = oldGeminiKey;
    const oldOllamaUrl = await read<string>("embeddingOllamaUrl");
    if (oldOllamaUrl) settings.providers.ollama.baseUrl = oldOllamaUrl;
  }

  settings.embeddingProvider = (await read<EmbeddingProvider>("embeddingProvider")) ?? settings.embeddingProvider;
  settings.embeddingModel = (await read<string>("embeddingModel")) ?? (await read<string>("embeddingOpenAiModel")) ?? settings.embeddingModel;
  settings.localEmbeddingModelPath = (await read<string>("localEmbeddingModelPath")) ?? settings.localEmbeddingModelPath;
  const ranking = await read<Partial<RankingSettings>>("ranking");
  if (ranking) {
    settings.ranking = { ...settings.ranking, ...ranking };
  }
  
  const legacyEnrichmentEnabled = await read<boolean>("enrichmentEnabled");
  settings.enrichmentSummaryEnabled =
    (await read<boolean>("enrichmentSummaryEnabled")) ??
    legacyEnrichmentEnabled ??
    settings.enrichmentSummaryEnabled;
  settings.enrichmentTaggingEnabled =
    (await read<boolean>("enrichmentTaggingEnabled")) ??
    legacyEnrichmentEnabled ??
    settings.enrichmentTaggingEnabled;
  settings.enrichmentProvider = (await read<EnrichmentProvider>("enrichmentProvider")) ?? settings.enrichmentProvider;
  settings.enrichmentModel = (await read<string>("enrichmentModel")) ?? settings.enrichmentModel;
  settings.localLlmModelPath = (await read<string>("localLlmModelPath")) ?? settings.localLlmModelPath;

  settings.debugLoggingEnabled = (await read<boolean>("debugLoggingEnabled")) ?? settings.debugLoggingEnabled;

  settings.trufflehogPath = (await read<string>("trufflehogPath")) ?? settings.trufflehogPath;

  settings.secretMaskerEnabled = (await read<boolean>("secretMaskerEnabled")) ?? settings.secretMaskerEnabled;
  settings.secretMaskerModelPath = (await read<string>("secretMaskerModelPath")) ?? settings.secretMaskerModelPath;

  settings.autocompleteEnabled = (await read<boolean>("autocompleteEnabled")) ?? settings.autocompleteEnabled;
  settings.autocompleteProvider = (await read<AutocompleteProvider>("autocompleteProvider")) ?? settings.autocompleteProvider;
  settings.autocompleteModel = (await read<string>("autocompleteModel")) ?? settings.autocompleteModel;
  settings.autocompleteModelPath = (await read<string>("autocompleteModelPath")) ?? settings.autocompleteModelPath;

  settings.shortcutOverrides = sanitizeShortcutOverrides(
    await read<Record<string, unknown>>("shortcutOverrides"),
  );

  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const s = await getStore();
  await s.set("clipboardMonitoring", settings.clipboardMonitoring);
  await s.set("providers", settings.providers);
  await s.set("embeddingProvider", settings.embeddingProvider);
  await s.set("embeddingModel", settings.embeddingModel);
  await s.set("localEmbeddingModelPath", settings.localEmbeddingModelPath);
  await s.set("ranking", settings.ranking);
  await s.set("enrichmentEnabled", settings.enrichmentSummaryEnabled || settings.enrichmentTaggingEnabled);
  await s.set("enrichmentSummaryEnabled", settings.enrichmentSummaryEnabled);
  await s.set("enrichmentTaggingEnabled", settings.enrichmentTaggingEnabled);
  await s.set("enrichmentProvider", settings.enrichmentProvider);
  await s.set("enrichmentModel", settings.enrichmentModel);
  await s.set("localLlmModelPath", settings.localLlmModelPath);
  await s.set("debugLoggingEnabled", settings.debugLoggingEnabled);
  await s.set("trufflehogPath", settings.trufflehogPath);
  await s.set("secretMaskerEnabled", settings.secretMaskerEnabled);
  await s.set("secretMaskerModelPath", settings.secretMaskerModelPath);
  await s.set("autocompleteEnabled", settings.autocompleteEnabled);
  await s.set("autocompleteProvider", settings.autocompleteProvider);
  await s.set("autocompleteModel", settings.autocompleteModel);
  await s.set("autocompleteModelPath", settings.autocompleteModelPath);
  await s.set("shortcutOverrides", sanitizeShortcutOverrides(settings.shortcutOverrides));
  await s.save();
}

export function fingerprintApiKey(apiKey: string): string {
  if (!apiKey) return "";
  // Simple "fingerprint" - last 4 chars and length
  return `${apiKey.length}_${apiKey.slice(-4)}`;
}

export function getProviderModelCache(settings: Settings, provider: "openai" | "gemini"): ProviderModelCache | null {
  return settings.providers[provider].modelCache;
}

export async function saveProviderModelCache(
  provider: "openai" | "gemini",
  cache: ProviderModelCache
): Promise<void> {
  const settings = await loadSettings();
  settings.providers[provider].modelCache = cache;
  await saveSettings(settings);
}
