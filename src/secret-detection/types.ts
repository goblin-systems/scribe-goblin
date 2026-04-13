export type SecretVerdict = "secret" | "likely_secret" | "not_secret";
export type SecretSource = "trufflehog" | "sap_password_model" | "classifier" | "both";
export type SecretType = "api_key" | "password" | "token" | "private_key" | "unknown";

export interface SecretDetectionEvidence {
  trufflehog_detector?: string;
  model_score?: number;
}

export interface SecretDetectionResult {
  verdict: SecretVerdict;
  source: SecretSource;
  secret_type: SecretType;
  confidence: number;
  reason: string;
  evidence: SecretDetectionEvidence;
}

export interface SecretDetectionContext {
  surroundingText?: string;
  sourceApp?: string;
  sourceUrl?: string;
}
