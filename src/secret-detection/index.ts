import type { 
  SecretDetectionResult, 
  SecretDetectionContext, 
  SecretVerdict, 
  SecretSource, 
  SecretType 
} from "./types";
import { runTruffleHog, maskSecret } from "./trufflehog";
import { runPasswordModel } from "./password-model";

/**
 * Main secret detection entry point.
 * Uses a two-stage hybrid approach:
 * 1. TruffleHog (Primary - known patterns)
 * 2. SAP/password-model (Fallback - suspicious text)
 */
export async function scan(text: string, context?: SecretDetectionContext): Promise<SecretDetectionResult> {
  const normalizedText = text.trim();
  
  // Stage 1: TruffleHog
  const truffleHogMatch = runTruffleHog(normalizedText);
  if (truffleHogMatch) {
    // TruffleHog is positive
    // For now we assume high-confidence if it matches a regex. 
    // TruffleHog v3 verified matches are 'secret', unverified are 'likely_secret'.
    // Here we treat it as 'secret' if it's a known provider key.
    return {
      verdict: "secret",
      source: "trufflehog",
      secret_type: truffleHogMatch.type,
      confidence: truffleHogMatch.confidence,
      reason: `Flagged by TruffleHog: ${truffleHogMatch.detector}`,
      evidence: {
        trufflehog_detector: truffleHogMatch.detector,
      }
    };
  }

  // Stage 2: Fallback to password model
  const modelResult = runPasswordModel(normalizedText);
  if (modelResult.is_secret) {
    return {
      verdict: "likely_secret",
      source: "sap_password_model",
      secret_type: "password",
      confidence: modelResult.score,
      reason: "Classified as a likely password or high-entropy string",
      evidence: {
        model_score: modelResult.score,
      }
    };
  }

  // Final fallback: Not a secret
  return {
    verdict: "not_secret",
    source: "both",
    secret_type: "unknown",
    confidence: 1.0 - modelResult.score,
    reason: "No secret patterns detected",
    evidence: {
      model_score: modelResult.score,
    }
  };
}

// Re-export maskSecret for safe handling
export { maskSecret };
