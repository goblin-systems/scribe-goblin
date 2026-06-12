import type {
  SecretDetectionResult,
  SecretDetectionContext,
  SecretVerdict,
} from "./types";
import { checkTruffleHogAvailability, runTruffleHog, maskSecret } from "./trufflehog";
import { getSecretMaskerScanResult } from "./password-model";

export interface ScanOptions {
  secretMaskerEnabled?: boolean;
  trufflehogPath?: string;
}

/**
 * Main secret detection entry point.
 * Uses a two-stage hybrid approach:
 * 1. TruffleHog (Primary - native CLI)
 * 2. Secret masker ML model (Fallback - DistilBERT NER via ONNX, skipped when secretMaskerEnabled is false)
 */
export async function scan(text: string, context?: SecretDetectionContext, options?: ScanOptions): Promise<SecretDetectionResult> {
  const normalizedText = text.trim();
  const trufflehogStatus = await checkTruffleHogAvailability(options?.trufflehogPath);
  const baseTrufflehog = {
    available: trufflehogStatus.available,
    matched: false,
    verified: null,
    detector: null,
    status: trufflehogStatus.available ? "no_match" : "unavailable",
  } as const;

  const secretMaskerEnabled = options?.secretMaskerEnabled !== false;
  const baseMasker = {
    enabled: secretMaskerEnabled,
    matched: false,
    model: secretMaskerEnabled ? "distilbert-secret-masker" : null,
    top_score: null,
    span_count: null,
    status: secretMaskerEnabled ? "no_match" : "disabled",
  } as const;

  // Stage 1: TruffleHog (native CLI only)
  const truffleHogMatch = trufflehogStatus.available
    ? await runTruffleHog(normalizedText, options?.trufflehogPath)
    : null;
  if (truffleHogMatch) {
    // Native verified → "secret", native unverified → "likely_secret"
    const verdict: SecretVerdict =
      truffleHogMatch.verified === false ? "likely_secret" : "secret";

    return {
      verdict,
      source: "trufflehog",
      secret_type: truffleHogMatch.type,
      confidence: truffleHogMatch.confidence,
      reason: `Flagged by TruffleHog: ${truffleHogMatch.detector}`,
      evidence: {
        trufflehog_detector: truffleHogMatch.detector,
        trufflehog_verified: truffleHogMatch.verified,
      },
      diagnostics: {
        trufflehog: {
          available: true,
          matched: true,
          verified: truffleHogMatch.verified ?? null,
          detector: truffleHogMatch.detector,
          status: "matched",
        },
        secret_masker: baseMasker,
      },
    };
  }

  // Stage 2: Secret masker ML model (if enabled)
  if (secretMaskerEnabled) {
    const maskerResult = await getSecretMaskerScanResult(normalizedText);
    if (maskerResult?.has_secrets) {
      return {
        verdict: "likely_secret",
        source: "secret_masker",
        secret_type: "unknown",
        confidence: maskerResult.top_score,
        reason: `Secret masker detected ${maskerResult.spans.length} secret span(s)`,
        evidence: {
          ml_model: "distilbert-secret-masker",
          ml_span_count: maskerResult.spans.length,
          ml_top_score: maskerResult.top_score,
        },
        diagnostics: {
          trufflehog: baseTrufflehog,
          secret_masker: {
            enabled: true,
            matched: true,
            model: "distilbert-secret-masker",
            top_score: maskerResult.top_score,
            span_count: maskerResult.spans.length,
            status: "matched",
          },
        },
      };
    }

    return {
      verdict: "not_secret",
      source: "both",
      secret_type: "unknown",
      confidence: 1.0,
      reason: "No secret patterns detected",
      evidence: {},
      diagnostics: {
        trufflehog: baseTrufflehog,
        secret_masker: {
          enabled: true,
          matched: false,
          model: "distilbert-secret-masker",
          top_score: maskerResult?.top_score ?? null,
          span_count: maskerResult?.spans.length ?? 0,
          status: maskerResult ? "no_match" : "error",
        },
      },
    };
  }

  // Final fallback: Not a secret
  return {
    verdict: "not_secret",
    source: "both",
    secret_type: "unknown",
    confidence: 1.0,
    reason: "No secret patterns detected",
    evidence: {},
    diagnostics: {
      trufflehog: baseTrufflehog,
      secret_masker: baseMasker,
    },
  };
}

// Re-export maskSecret for safe handling
export { maskSecret };
