import { applyIcons, showToast } from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { register } from "@tauri-apps/plugin-global-shortcut";
import { createDom } from "./main/dom";
import { setupShell } from "./main/shell-controller";
import {
  populateSettingsUI,
  updateProviderSetupSections,
  updateEmbeddingVisibility,
  updateEnrichmentVisibility,
  updateEmbeddingModelOptions,
  updateEnrichmentModelOptions,
  scheduleAutosave,
  cancelAutosave,
  readSettingsFromForm,
} from "./main/settings-controller";
import {
  initNotesController,
  loadNotes,
  handleSearchInput,
  addNote,
  deleteSelectedNote,
  clearSelection,
  processNoteBackground,
} from "./main/notes-controller";
import {
  initClipboardController,
  loadClipboard,
  handleClipboardSearchInput,
  deleteSelectedClipboardItem,
  clearClipboardSelection,
} from "./main/clipboard-controller";
import {
  configureDebugLogging,
  debugLog,
} from "./logger";
import {
  loadSettings,
  saveProviderModelCache,
  fingerprintApiKey,
  type Settings,
} from "./settings";
import { testEmbeddingConnection } from "./embedding";

// ── App state ──────────────────────────────────────────────────────────────

let currentSettings: Settings;

function getSettings(): Settings {
  return currentSettings;
}

function setSettings(next: Settings): void {
  currentSettings = next;
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

  const dom = createDom();

  const shell = setupShell({ dom, getSettings, setSettings });
  await shell.applySettingsToUI(currentSettings);

  populateSettingsUI(dom, currentSettings);

  function initProviderStatus() {
    const provider = dom.providerSetupSelect.value;
    if (provider === "local") {
      updateProviderStatus("connected");
      return;
    }
    const apiKey = provider === "openai" ? currentSettings.providers.openai.apiKey :
                   provider === "gemini" ? currentSettings.providers.gemini.apiKey :
                   currentSettings.providers.ollama.baseUrl;

    if (!apiKey || apiKey === "http://localhost:11434") {
      updateProviderStatus("disconnected");
    } else {
      updateProviderStatus("untested");
    }
  }
  initProviderStatus();

  // Init notes controller and load first page
  initNotesController(dom, () => currentSettings);
  await loadNotes();

  // Init clipboard controller and load first page
  initClipboardController(dom, () => currentSettings);
  await loadClipboard();

  // Start clipboard monitoring if enabled
  if (currentSettings.clipboardMonitoring) {
    await invoke("start_clipboard_monitor").catch(console.error);
  }

  // Register global shortcut for paste workflow
  try {
    await register("Control+Alt+V", async (event) => {
      if (event.state === "Pressed") {
        debugLog("Global shortcut Ctrl+Alt+V pressed", "INFO");
        try {
          const [x, y] = await invoke<[number, number]>("get_cursor_position");
          debugLog(`Cursor position for overlay: ${x}, ${y}`, "INFO");
          await emit("show-overlay", { x, y });
        } catch (err) {
          debugLog(`Failed to get cursor pos or emit show-overlay: ${err}`, "ERROR");
        }
      }
    });
    debugLog("Global shortcut Ctrl+Alt+V registered", "INFO");
  } catch (err) {
    debugLog(`Failed to register global shortcut: ${err}`, "ERROR");
    console.error("Failed to register global shortcut:", err);
  }

  // ── Search ────────────────────────────────────────────────────────────────
  dom.searchInput.addEventListener("input", () => {
    handleSearchInput(dom.searchInput.value);
  });
  dom.searchClearBtn.addEventListener("click", () => {
    dom.searchInput.value = "";
    dom.searchClearBtn.hidden = true;
    void loadNotes();
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
  dom.addNoteBtn.addEventListener("click", () => {
    dom.quickAddForm.hidden = false;
    dom.quickAddInput.focus();
  });

  dom.quickAddCancelBtn.addEventListener("click", () => {
    dom.quickAddForm.hidden = true;
    dom.quickAddInput.value = "";
  });

  dom.quickAddSaveBtn.addEventListener("click", async () => {
    const content = dom.quickAddInput.value.trim();
    if (!content) return;
    dom.quickAddForm.hidden = true;
    dom.quickAddInput.value = "";
    await addNote(content, "manual");
    showToast("Note saved", "success", 1200);
  });

  // Ctrl+Enter / Cmd+Enter to save quick add
  dom.quickAddInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      dom.quickAddSaveBtn.click();
    }
    if (e.key === "Escape") {
      dom.quickAddCancelBtn.click();
    }
  });

  // ── Note detail ──────────────────────────────────────────────────────────
  dom.noteDetailClose.addEventListener("click", () => clearSelection());
  dom.noteDetailDelete.addEventListener("click", async () => {
    await deleteSelectedNote();
  });

  // ── Clipboard detail ────────────────────────────────────────────────────
  dom.clipboardDetailClose.addEventListener("click", () => clearClipboardSelection());
  dom.clipboardDetailDelete.addEventListener("click", async () => {
    await deleteSelectedClipboardItem();
  });

  // ── Clipboard listener ────────────────────────────────────────────────────
  await listen<{content: string, html_content: string | null, source_app: string | null}>("clipboard-capture", async (event) => {
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
      await loadNotes();
      void processNoteBackground(id, content);
      debugLog("clipboard-capture processed successfully", "INFO");
    } catch (err) {
      debugLog(`clipboard-capture processing failed: ${err}`, "ERROR");
    }
  });

  await listen("entries-changed", async () => {
    await Promise.all([
      loadNotes(dom.searchInput.value.trim() || undefined),
      loadClipboard(dom.clipboardSearchInput.value.trim() || undefined),
    ]);
  });

  // ── Settings changes ──────────────────────────────────────────────────────
  const onSettingsChange = (delayMs = 600) => {
    scheduleAutosave(dom, currentSettings, async (updated) => {
      const wasMonitoring = currentSettings.clipboardMonitoring;
      currentSettings = updated;
      configureDebugLogging(updated.debugLoggingEnabled);

      // Toggle clipboard monitoring if changed
      if (updated.clipboardMonitoring !== wasMonitoring) {
        if (updated.clipboardMonitoring) {
          await invoke("start_clipboard_monitor").catch(console.error);
        } else {
          invoke("stop_clipboard_monitor");
        }
      }
    }, delayMs, (updated) => {
      // Immediate UI feedback while typing
      updateEmbeddingVisibility(dom, updated.embeddingProvider);
      updateEmbeddingModelOptions(dom, updated);
      updateEnrichmentModelOptions(dom, updated);
    });
  };

  dom.clipboardMonitoringCheckbox.addEventListener("change", () => onSettingsChange(0));

  // Provider Setup
  dom.providerSetupSelect.addEventListener("change", () => {
    updateProviderSetupSections(dom);
    if (dom.providerSetupSelect.value === "local") {
      updateProviderStatus("connected");
    } else {
      updateProviderStatus("untested");
    }
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
  dom.embeddingUnifiedModelSelect.addEventListener("change", () => onSettingsChange(0));
  dom.embeddingModelInput.addEventListener("input", () => onSettingsChange());

  // Enrichment
  dom.enrichmentEnabledCheckbox.addEventListener("change", () => {
    updateEnrichmentVisibility(dom, dom.enrichmentEnabledCheckbox.checked);
    onSettingsChange(0);
  });
  dom.enrichmentUnifiedModelSelect.addEventListener("change", () => onSettingsChange(0));

  // Debug
  dom.debugLoggingCheckbox.addEventListener("change", () => onSettingsChange(0));

  // TruffleHog
  dom.trufflehogPathInput.addEventListener("input", () => onSettingsChange());

  // ── API key show/hide toggles ─────────────────────────────────────────────
  function toggleKeyVisibility(input: HTMLInputElement, btn: HTMLButtonElement) {
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    const icon = btn.querySelector("i");
    if (icon) icon.setAttribute("data-lucide", isHidden ? "eye-off" : "eye");
    applyIcons();
  }

  dom.toggleOpenaiKeyBtn.addEventListener("click", () =>
    toggleKeyVisibility(dom.openaiApiKey, dom.toggleOpenaiKeyBtn)
  );
  dom.toggleGeminiKeyBtn.addEventListener("click", () =>
    toggleKeyVisibility(dom.geminiApiKey, dom.toggleGeminiKeyBtn)
  );

  // ── Provider Status UI ────────────────────────────────────────────────────
  function updateProviderStatus(status: "connected" | "connecting" | "untested" | "disconnected" | "error", message?: string) {
    const statusText = dom.providerStatus.querySelector(".status-text") as HTMLElement;
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
  function updateTrufflehogStatus(status: "connected" | "connecting" | "untested" | "disconnected" | "error", message?: string) {
    const statusText = dom.trufflehogStatus.querySelector(".status-text") as HTMLElement;
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
      const provider = dom.providerSetupSelect.value as "openai" | "gemini" | "ollama" | "local";
      debugLog(`Testing connection for provider: ${provider}`, "INFO");

      if (provider === "local") {
        updateProviderStatus("connected");
        showToast("Local classifier is ready", "success");
        return;
      }

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
        debugLog("Triggering automatic model refresh to validate API key and discover models", "INFO");
        await refreshModels(provider);
      }

      // 2. Re-read settings now that UI dropdowns are populated with valid models
      const updatedSettings = readSettingsFromForm(dom, currentSettings);

      let testModel = "";
      if (provider === "ollama") {
        testModel = updatedSettings.embeddingModel || "nomic-embed-text";
      } else {
        const cache = updatedSettings.providers[provider].modelCache;
        testModel = cache?.embeddingModels?.[0] || (provider === "openai" ? "text-embedding-3-small" : "gemini-embedding-001");
      }

      if (!testModel) {
         throw new Error(`No embedding models found for provider ${provider}`);
      }

      debugLog(`Invoking testEmbeddingConnection with dynamically selected model: ${testModel}`, "INFO");
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

      debugLog(`trufflehog_check result: available=${status.available}, path=${status.path}, version=${status.version}, stdin=${status.supports_stdin}`, "INFO");

      if (status.available) {
        const versionStr = status.version ? ` v${status.version}` : "";
        const stdinStr = status.supports_stdin ? " (stdin)" : " (file mode)";
        updateTrufflehogStatus("connected", `Found${versionStr}${stdinStr}`);
        dom.trufflehogPathHint.textContent = status.path || "Auto-detected from PATH";
        showToast("TruffleHog detected", "success", 1500);
      } else {
        updateTrufflehogStatus("error", "Not found");
        dom.trufflehogPathHint.textContent = "TruffleHog binary not found. Install it or provide a custom path.";
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
      const apiKey = provider === "openai" ? latestSettings.providers.openai.apiKey : latestSettings.providers.gemini.apiKey;
      if (!apiKey) throw new Error("API key is required");

      const embeddingModels = await fetchModelsFromApi(provider, "embedding", apiKey);
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
    const provider = currentSettings.enrichmentProvider === "none" ? "openai" : currentSettings.enrichmentProvider;
    if (provider === "openai" || provider === "gemini") {
      refreshModels(provider).catch(console.error);
    }
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  window.addEventListener("beforeunload", () => {
    cancelAutosave();
    invoke("stop_clipboard_monitor");
  });
}

init().catch((err) => console.error("Failed to initialise app:", err));

// ── Standalone utilities ────────────────────────────────────────────────────

async function fetchModelsFromApi(provider: "openai" | "gemini", type: "embedding" | "chat", apiKey: string): Promise<string[]> {
  debugLog(`fetchModelsFromApi: provider=${provider}, type=${type}`, "INFO");
  const url = provider === "openai"
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
    debugLog(`fetchModelsFromApi API returned ${response.status}: ${response.body}`, "ERROR");
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
