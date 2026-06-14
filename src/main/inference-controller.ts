import { invoke } from "@tauri-apps/api/core";
import type { ScribeDom } from "./dom";
import type { Settings } from "../settings";
import { debugLog } from "../logger";

export interface InferenceCapabilities {
  engines: string[];
  llamacpp_backend: string | null;
  mistralrs_backend: string;
}

interface InferenceTestResult {
  ok: boolean;
  engine: string;
  backend: string;
  gpu_layers: number;
  tokens_per_sec: number;
  elapsed_ms: number;
  sample: string;
  error: string | null;
}

export interface InferenceController {
  /** Re-fetch capabilities (if needed) and repopulate from current settings. */
  refresh: () => Promise<void>;
}

export function initInferenceController(
  dom: ScribeDom,
  getSettings: () => Settings,
  onChange: () => void,
): InferenceController {
  let capabilities: InferenceCapabilities | null = null;

  function populate(): void {
    if (!capabilities) return;
    const settings = getSettings();
    const select = dom.inferenceEngineSelect;
    select.innerHTML = "";

    const mistral = document.createElement("option");
    mistral.value = "mistralrs";
    mistral.textContent = `mistral.rs (candle) — ${capabilities.mistralrs_backend}`;
    select.appendChild(mistral);

    const llamaAvailable = capabilities.engines.includes("llamacpp");
    const llama = document.createElement("option");
    llama.value = "llamacpp";
    llama.textContent = llamaAvailable
      ? `llama.cpp — ${capabilities.llamacpp_backend}`
      : "llama.cpp — not in this build (download the GPU build)";
    llama.disabled = !llamaAvailable;
    select.appendChild(llama);

    // Select the saved engine, falling back to mistral.rs when llama.cpp isn't
    // compiled into this binary.
    select.value =
      settings.inferenceEngine === "llamacpp" && llamaAvailable ? "llamacpp" : "mistralrs";

    dom.inferenceGpuLayersInput.value = String(settings.inferenceGpuLayers ?? 0);
    syncVisibility();
  }

  function syncVisibility(): void {
    const isLlama = dom.inferenceEngineSelect.value === "llamacpp";
    dom.inferenceGpuLayersRow.hidden = !isLlama;
    if (!capabilities) return;
    if (isLlama) {
      dom.inferenceBackendHint.textContent = `Compiled backend: ${capabilities.llamacpp_backend ?? "n/a"}. GPU offload applies only to llama.cpp.`;
    } else {
      dom.inferenceBackendHint.textContent = `mistral.rs runs on ${capabilities.mistralrs_backend}. For AMD GPU acceleration, switch to llama.cpp (GPU build).`;
    }
  }

  async function refresh(): Promise<void> {
    if (!capabilities) {
      try {
        capabilities = await invoke<InferenceCapabilities>("inference_capabilities");
      } catch (err) {
        debugLog(`inference_capabilities failed: ${err}`, "WARN");
        return;
      }
    }
    populate();
  }

  dom.inferenceEngineSelect.addEventListener("change", () => {
    syncVisibility();
    onChange();
  });
  dom.inferenceGpuLayersInput.addEventListener("change", () => onChange());

  dom.inferenceTestBtn.addEventListener("click", async () => {
    const settings = getSettings();
    const modelPath =
      settings.localLlmModelPath?.trim() ||
      settings.autocompleteModelPath?.trim() ||
      null;
    dom.inferenceTestResult.textContent = "Testing…";
    dom.inferenceTestBtn.disabled = true;
    try {
      const res = await invoke<InferenceTestResult>("inference_test", {
        engine: dom.inferenceEngineSelect.value,
        modelPath,
        gpuLayers: Math.max(0, Math.floor(Number(dom.inferenceGpuLayersInput.value) || 0)),
      });
      if (res.ok) {
        dom.inferenceTestResult.textContent =
          `✓ ${res.engine} on ${res.backend} — ${res.tokens_per_sec.toFixed(1)} tok/s ` +
          `(${res.elapsed_ms} ms)${res.sample ? ` · "${res.sample}"` : ""}`;
      } else {
        dom.inferenceTestResult.textContent = `✗ ${res.error ?? "Test failed"}`;
      }
    } catch (err) {
      dom.inferenceTestResult.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      dom.inferenceTestBtn.disabled = false;
    }
  });

  return { refresh };
}
