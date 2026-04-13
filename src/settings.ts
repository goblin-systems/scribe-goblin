import { load, Store } from "@tauri-apps/plugin-store";

export type EmbeddingProvider = "none" | "openai" | "gemini" | "ollama" | "local";
export type EnrichmentProvider = "none" | "openai" | "gemini";

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

  // AI enrichment (summary + tags)
  enrichmentEnabled: boolean;
  enrichmentProvider: EnrichmentProvider;
  enrichmentModel: string;

  // Debug
  debugLoggingEnabled: boolean;
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
  enrichmentEnabled: false,
  enrichmentProvider: "none",
  enrichmentModel: "gpt-4o-mini",
  debugLoggingEnabled: false,
};

export function getDefaultSettings(): Settings {
  return JSON.parse(JSON.stringify(DEFAULTS));
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
  
  settings.enrichmentEnabled = (await read<boolean>("enrichmentEnabled")) ?? settings.enrichmentEnabled;
  settings.enrichmentProvider = (await read<EnrichmentProvider>("enrichmentProvider")) ?? settings.enrichmentProvider;
  settings.enrichmentModel = (await read<string>("enrichmentModel")) ?? settings.enrichmentModel;

  settings.debugLoggingEnabled = (await read<boolean>("debugLoggingEnabled")) ?? settings.debugLoggingEnabled;

  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const s = await getStore();
  await s.set("clipboardMonitoring", settings.clipboardMonitoring);
  await s.set("providers", settings.providers);
  await s.set("embeddingProvider", settings.embeddingProvider);
  await s.set("embeddingModel", settings.embeddingModel);
  await s.set("enrichmentEnabled", settings.enrichmentEnabled);
  await s.set("enrichmentProvider", settings.enrichmentProvider);
  await s.set("enrichmentModel", settings.enrichmentModel);
  await s.set("debugLoggingEnabled", settings.debugLoggingEnabled);
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
