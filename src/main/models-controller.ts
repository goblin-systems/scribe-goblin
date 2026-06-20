import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyIcons, showToast } from "@goblin-systems/goblin-design-system";
import type { ScribeDom } from "./dom";
import type { Settings } from "../settings";
import { debugLog } from "../logger";
import {
  setInstalledLlmModels,
  setInstalledEmbeddingModels,
  setInstalledMaskerModels,
  updateEnrichmentModelOptions,
  updateEmbeddingModelOptions,
  updateSecretMaskerModelOptions,
  updateAutocompleteModelOptions,
  type LocalLlmModelOption,
} from "./settings-controller";

export interface ModelInfo {
  id: string;
  kind: string;
  label: string;
  repo: string | null;
  file: string | null;
  approx_size_bytes: number | null;
  installed: boolean;
  path: string | null;
  source: string;
}

export interface EngineStatus {
  name: string;
  engine: string;
  backend: string;
  loaded: boolean;
  model_path: string;
  model_exists: boolean;
  error: string | null;
}

export interface AiStatusReport {
  resources_dir: string;
  models_dir: string;
  embedding: EngineStatus;
  secret_masker: EngineStatus;
  llm: EngineStatus;
}

interface DownloadProgress {
  id: string;
  downloaded: number;
  total: number | null;
  status: "downloading" | "done" | "error" | "cancelled";
  error: string | null;
  path: string | null;
}

export interface AiModelsController {
  refresh: () => Promise<void>;
}

const downloadingIds = new Set<string>();

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "?";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function statusRow(status: EngineStatus): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "ai-status-row";
  row.style.cssText = "display:flex;flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px solid var(--border-color, rgba(128,128,128,0.2));";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;";

  const dot = document.createElement("span");
  const ok = status.model_exists && !status.error;
  dot.textContent = ok ? (status.loaded ? "●" : "◐") : "○";
  dot.title = ok ? (status.loaded ? "Loaded" : "Available (loads on first use)") : "Unavailable";
  dot.style.color = ok ? "var(--success-color, #3ba55d)" : "var(--danger-color, #d9534f)";

  const name = document.createElement("strong");
  name.textContent = status.name;

  const engine = document.createElement("span");
  engine.className = "hint";
  engine.style.margin = "0";
  engine.textContent = `${status.engine} · ${status.backend}`;

  head.append(dot, name, engine);
  row.appendChild(head);

  const pathLine = document.createElement("p");
  pathLine.className = "hint";
  pathLine.style.margin = "0";
  pathLine.textContent = status.model_exists
    ? status.model_path
    : `Model file missing: ${status.model_path}`;
  row.appendChild(pathLine);

  if (status.error) {
    const errLine = document.createElement("p");
    errLine.className = "hint";
    errLine.style.cssText = "margin:0;color:var(--danger-color, #d9534f);";
    errLine.textContent = `Init error: ${status.error}`;
    row.appendChild(errLine);
  }

  return row;
}

function renderStatus(dom: ScribeDom, report: AiStatusReport): void {
  dom.aiStatusList.replaceChildren(
    statusRow(report.embedding),
    statusRow(report.secret_masker),
    statusRow(report.llm),
  );

  const dirs = document.createElement("p");
  dirs.className = "hint";
  dirs.style.marginTop = "6px";
  dirs.textContent = `Bundled resources: ${report.resources_dir} · Downloaded models: ${report.models_dir}`;
  dom.aiStatusList.appendChild(dirs);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "llm-gguf":
      return "LLM (GGUF)";
    case "llm-safetensors":
      return "LLM (safetensors)";
    case "embedding-onnx":
      return "Embedding (ONNX)";
    case "embedding-safetensors":
      return "Embedding (safetensors)";
    case "secret-masker-onnx":
      return "Secret masker (ONNX)";
    case "secret-masker-safetensors":
      return "Secret masker (safetensors)";
    default:
      return kind;
  }
}

function modelRow(
  model: ModelInfo,
  onDownload: (model: ModelInfo) => void,
  onCancel: (model: ModelInfo) => void,
  onDelete: (model: ModelInfo) => void,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "ai-model-row";
  row.dataset.modelId = model.id;
  row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-color, rgba(128,128,128,0.2));";

  const info = document.createElement("div");
  info.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;";

  const title = document.createElement("span");
  title.textContent = model.label;
  info.appendChild(title);

  const meta = document.createElement("span");
  meta.className = "hint";
  meta.style.margin = "0";
  const parts = [kindLabel(model.kind)];
  if (model.approx_size_bytes) parts.push(`~${formatBytes(model.approx_size_bytes)}`);
  if (model.installed && model.path) parts.push(model.path);
  else if (model.repo) parts.push(`hf.co/${model.repo}`);
  meta.textContent = parts.join(" · ");
  info.appendChild(meta);

  const progress = document.createElement("span");
  progress.className = "hint ai-model-progress";
  progress.style.margin = "0";
  progress.hidden = true;
  info.appendChild(progress);

  row.appendChild(info);

  if (model.installed) {
    const badge = document.createElement("span");
    badge.className = "hint";
    badge.style.margin = "0";
    badge.textContent = "Installed";
    row.appendChild(badge);
    if (model.source === "downloaded" || model.source === "custom") {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "icon-btn icon-btn-sm ai-model-action-btn";
      deleteBtn.title = `Delete ${model.label}`;
      deleteBtn.setAttribute("aria-label", `Delete ${model.label}`);
      deleteBtn.innerHTML = `<i data-lucide="trash-2"></i>`;
      deleteBtn.addEventListener("click", () => onDelete(model));
      row.appendChild(deleteBtn);
    }
  } else if (downloadingIds.has(model.id)) {
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "icon-btn icon-btn-sm ai-model-action-btn";
    cancelBtn.title = `Cancel ${model.label} download`;
    cancelBtn.setAttribute("aria-label", `Cancel ${model.label} download`);
    cancelBtn.innerHTML = `<i data-lucide="x"></i>`;
    cancelBtn.addEventListener("click", () => onCancel(model));
    row.appendChild(cancelBtn);
    progress.hidden = false;
    progress.textContent = "Downloading…";
  } else if (model.repo && model.file) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn icon-btn-sm ai-model-action-btn";
    btn.title = `Download ${model.label}`;
    btn.setAttribute("aria-label", `Download ${model.label}`);
    btn.innerHTML = `<i data-lucide="download"></i>`;
    btn.addEventListener("click", () => onDownload(model));
    row.appendChild(btn);
  } else {
    const note = document.createElement("span");
    note.className = "hint";
    note.style.margin = "0";
    note.textContent = "No public source — use custom download";
    row.appendChild(note);
  }

  return row;
}

function updateProgressRow(dom: ScribeDom, progress: DownloadProgress): void {
  const row = dom.aiModelsSettingsModal.querySelector<HTMLDivElement>(
    `[data-model-id="${CSS.escape(progress.id)}"]`,
  );
  const label = row?.querySelector<HTMLSpanElement>(".ai-model-progress");
  if (!label) return;
  label.hidden = false;
  if (progress.total) {
    const pct = Math.round((progress.downloaded / progress.total) * 100);
    label.textContent = `Downloading… ${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)} (${pct}%)`;
  } else {
    label.textContent = `Downloading… ${formatBytes(progress.downloaded)}`;
  }
}

export function initAiModelsController(
  dom: ScribeDom,
  getSettings: () => Settings,
): AiModelsController {
  async function refresh(): Promise<void> {
    try {
      const settings = getSettings();
      const [status, models] = await Promise.all([
        invoke<AiStatusReport>("ai_status", {
          llmModelPath: settings.localLlmModelPath?.trim() || null,
          llmEngine: settings.inferenceEngine,
          embeddingModelPath: settings.localEmbeddingModelPath?.trim() || null,
          secretMaskerModelPath: settings.secretMaskerModelPath?.trim() || null,
        }),
        invoke<ModelInfo[]>("models_list"),
      ]);

      renderStatus(dom, status);

      const renderInto = (host: HTMLDivElement, kinds: (kind: string) => boolean) => {
        const rows = models
          .filter((m) => kinds(m.kind))
          .map((model) => modelRow(model, startDownload, cancelDownload, deleteModel));
        if (rows.length === 0) {
          const empty = document.createElement("p");
          empty.className = "hint";
          empty.textContent = "Nothing available.";
          host.replaceChildren(empty);
        } else {
          host.replaceChildren(...rows);
          applyIcons();
        }
      };
      renderInto(dom.aiModelsLlmList, (kind) => kind.startsWith("llm-"));
      renderInto(dom.aiModelsEmbeddingList, (kind) => kind.startsWith("embedding-"));
      renderInto(dom.aiModelsMaskerList, (kind) => kind.startsWith("secret-masker-"));

      const installedOf = (match: (kind: string) => boolean): LocalLlmModelOption[] =>
        models
          .filter((m) => match(m.kind) && m.installed && m.path)
          .map((m) => ({ id: m.id, label: m.label, path: m.path as string }));
      setInstalledLlmModels(installedOf((kind) => kind.startsWith("llm-")));
      setInstalledEmbeddingModels(installedOf((kind) => kind.startsWith("embedding-")));
      setInstalledMaskerModels(installedOf((kind) => kind.startsWith("secret-masker-")));
      updateEnrichmentModelOptions(dom, getSettings());
      updateEmbeddingModelOptions(dom, getSettings());
      updateSecretMaskerModelOptions(dom, getSettings());
      updateAutocompleteModelOptions(dom, getSettings());
    } catch (err) {
      debugLog(`ai-models refresh failed: ${err}`, "ERROR");
      const error = document.createElement("p");
      error.className = "hint";
      error.textContent = `Failed to load AI status: ${err instanceof Error ? err.message : String(err)}`;
      dom.aiStatusList.replaceChildren(error);
    }
  }

  function startDownload(model: ModelInfo): void {
    void runDownload(model.id, model.repo ?? undefined, model.file ?? undefined);
  }

  async function runDownload(id: string, repo?: string, file?: string): Promise<void> {
    if (downloadingIds.has(id)) return;
    downloadingIds.add(id);
    await refresh();
    try {
      await invoke("models_download", { id, repo: repo ?? null, file: file ?? null });
      showToast("Model downloaded.", "success", 2000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== "cancelled") {
        debugLog(`models_download failed for ${id}: ${message}`, "ERROR");
        showToast(`Download failed: ${message}`, "error", 5000);
      }
    } finally {
      downloadingIds.delete(id);
      await refresh();
    }
  }

  function cancelDownload(model: ModelInfo): void {
    invoke("models_cancel_download", { id: model.id }).catch((err) => {
      debugLog(`models_cancel_download failed: ${err}`, "WARN");
    });
  }

  async function deleteModel(model: ModelInfo): Promise<void> {
    try {
      await invoke("models_delete", { id: model.id });
      showToast("Model deleted.", "success", 2000);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`models_delete failed for ${model.id}: ${message}`, "ERROR");
      showToast(`Delete failed: ${message}`, "error", 5000);
    }
  }

  dom.aiModelsRefreshBtn.addEventListener("click", () => void refresh());

  dom.customModelDownloadBtn.addEventListener("click", () => {
    const repo = dom.customModelRepoInput.value.trim();
    const file = dom.customModelFileInput.value.trim();
    const kind = dom.customModelKindSelect.value;
    if (!repo || !file) {
      dom.customModelHint.textContent = "Enter both a Hugging Face repo and a file name.";
      return;
    }
    const id =
      kind === "secret-masker-onnx"
        ? "secret-masker-onnx"
        : `custom-${file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "model"}`;
    dom.customModelHint.textContent = `Downloading ${file} from ${repo}…`;
    void runDownload(id, repo, file).then(() => {
      dom.customModelHint.textContent = "";
    });
  });

  void listen<DownloadProgress>("model-download-progress", (event) => {
    const progress = event.payload;
    if (progress.status === "downloading") {
      updateProgressRow(dom, progress);
    }
  }).catch((err) => {
    debugLog(`Failed to listen for model download progress: ${err}`, "WARN");
  });

  // Initial load: populate the model picker cache and surface a clear warning
  // when the configured local LLM is missing (the old behavior failed silently
  // on every capture).
  void refresh().then(async () => {
    const settings = getSettings();
    const localLlmActive =
      settings.enrichmentProvider === "local-qwen" &&
      (settings.enrichmentTaggingEnabled || settings.enrichmentSummaryEnabled);
    if (!localLlmActive) return;
    try {
      const status = await invoke<AiStatusReport>("ai_status", {
        llmModelPath: settings.localLlmModelPath?.trim() || null,
        llmEngine: settings.inferenceEngine,
        embeddingModelPath: settings.localEmbeddingModelPath?.trim() || null,
        secretMaskerModelPath: settings.secretMaskerModelPath?.trim() || null,
      });
      if (!status.llm.model_exists) {
        showToast(
          "Local AI model is not installed — tagging will be skipped. Open Settings → Local AI Models to download one.",
          "error",
          8000,
        );
      }
    } catch (err) {
      debugLog(`startup ai_status check failed: ${err}`, "WARN");
    }
  });

  return { refresh };
}
