/**
 * Secret masker integration via Tauri invoke.
 * Calls the Rust-side DistilBERT ONNX model for NER-based secret detection.
 */
import { invoke } from "@tauri-apps/api/core";

export interface SecretSpan {
  start: number;
  end: number;
  text: string;
  confidence: number;
  label: string;
}

export interface SecretMaskerResult {
  spans: SecretSpan[];
  has_secrets: boolean;
  top_score: number;
}

/**
 * Run the secret masker ML model on the given text.
 * Returns the result if secrets are found, or null if none detected.
 * Returns null on error (model not initialized is a valid state).
 */
export async function runSecretMasker(
  text: string,
  modelPath?: string,
): Promise<SecretMaskerResult | null> {
  try {
    const result = await invoke<SecretMaskerResult>("secret_masker_scan", {
      text,
      modelPath: modelPath?.trim() || null,
    });
    return result.has_secrets ? result : null;
  } catch {
    return null;
  }
}

export async function getSecretMaskerScanResult(
  text: string,
  modelPath?: string,
): Promise<SecretMaskerResult | null> {
  try {
    return await invoke<SecretMaskerResult>("secret_masker_scan", {
      text,
      modelPath: modelPath?.trim() || null,
    });
  } catch {
    return null;
  }
}
