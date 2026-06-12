export type SecretVerdict = "secret" | "likely_secret" | "not_secret";
export type SecretSource = "trufflehog" | "secret_masker" | "classifier" | "both" | "manual";
export type SecretType = "api_key" | "password" | "token" | "private_key" | "unknown";

export interface TruffleHogDiagnostics {
  available: boolean;
  matched: boolean;
  verified: boolean | null;
  detector: string | null;
  status: "matched" | "no_match" | "unavailable";
}

export interface SecretMaskerDiagnostics {
  enabled: boolean;
  matched: boolean;
  model: string | null;
  top_score: number | null;
  span_count: number | null;
  status: "matched" | "no_match" | "disabled" | "error";
}

export interface SecretDetectionEvidence {
  trufflehog_detector?: string;
  trufflehog_verified?: boolean;
  model_score?: number;
  ml_model?: string;
  ml_span_count?: number;
  ml_top_score?: number;
}

export interface SecretDetectionResult {
  verdict: SecretVerdict;
  source: SecretSource;
  secret_type: SecretType;
  confidence: number;
  reason: string;
  evidence: SecretDetectionEvidence;
  diagnostics: {
    trufflehog: TruffleHogDiagnostics;
    secret_masker: SecretMaskerDiagnostics;
  };
}

export interface SecretDetectionContext {
  surroundingText?: string;
  sourceApp?: string;
  sourceUrl?: string;
}
