import { invoke } from "@tauri-apps/api/core";
import type { SecretType } from "./types";

export interface TruffleHogMatch {
  detector: string;
  type: SecretType;
  confidence: number;
  verified?: boolean;
}

// --- Rust backend types (mirrors src-tauri/src/trufflehog.rs) ---

interface TruffleHogStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  supports_stdin: boolean;
}

interface TruffleHogFinding {
  detector_name: string;
  verified: boolean;
  raw_redacted: string;
  decoder: string;
}

// --- Regex-based fallback (original detectors) ---

const DETECTORS: Array<{ name: string; type: SecretType; regex: RegExp }> = [
  {
    name: "jwt_token",
    type: "token",
    regex: /\beyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+\b/,
  },
  {
    name: "private_key",
    type: "private_key",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: "openai_api_key",
    type: "api_key",
    regex: /\bsk-[a-zA-Z0-9]{48}\b/,
  },
  {
    name: "aws_access_key",
    type: "api_key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: "google_api_key",
    type: "api_key",
    regex: /\bAIza[0-9A-Za-z-_]{35}\b/,
  },
  {
    name: "github_pat",
    type: "token",
    regex: /\bgh[p|o|u|s|r]_[A-Za-z0-9_]{36,255}\b/,
  },
  {
    name: "slack_token",
    type: "token",
    regex: /\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/,
  },
  {
    name: "stripe_api_key",
    type: "api_key",
    regex: /\bsk_(?:live|test)_[0-9a-zA-Z]{24}\b/,
  },
];

export function runTruffleHogRegex(text: string): TruffleHogMatch | null {
  for (const detector of DETECTORS) {
    if (detector.regex.test(text)) {
      return {
        detector: detector.name,
        type: detector.type,
        confidence: 0.9,
      };
    }
  }
  return null;
}

// --- Native TruffleHog CLI backend ---

let cachedStatus: TruffleHogStatus | null = null;

export async function checkTruffleHogAvailability(
  customPath?: string,
): Promise<TruffleHogStatus> {
  if (cachedStatus !== null) return cachedStatus;
  try {
    cachedStatus = await invoke<TruffleHogStatus>("trufflehog_check", {
      customPath,
    });
  } catch {
    cachedStatus = {
      available: false,
      path: null,
      version: null,
      supports_stdin: false,
    };
  }
  return cachedStatus;
}

/** Reset the cached status (useful when settings change). */
export function resetTruffleHogCache(): void {
  cachedStatus = null;
}

function mapDetectorNameToSecretType(detectorName: string): SecretType {
  const name = detectorName.toLowerCase();

  // Exact-prefix matches first
  if (name === "aws" || name === "awsiam") return "api_key";
  if (name === "github" || name === "githubapp") return "token";
  if (name === "slack" || name === "slackwebhook") return "token";
  if (name === "openai") return "api_key";
  if (name === "stripe") return "api_key";
  if (name === "privatekey") return "private_key";

  // Fuzzy keyword matches
  if (name.includes("key") || name.includes("api")) return "api_key";
  if (name.includes("token") || name.includes("webhook")) return "token";
  if (name.includes("password") || name.includes("secret")) return "password";

  return "unknown";
}

function mapFindingToMatch(finding: TruffleHogFinding): TruffleHogMatch {
  return {
    detector: finding.detector_name,
    type: mapDetectorNameToSecretType(finding.detector_name),
    confidence: finding.verified ? 0.95 : 0.85,
    verified: finding.verified,
  };
}

export async function runTruffleHogNative(
  text: string,
  customPath?: string,
): Promise<TruffleHogMatch | null> {
  const status = await checkTruffleHogAvailability(customPath);
  if (!status.available) return null;

  const findings = await invoke<TruffleHogFinding[]>("trufflehog_scan", {
    text,
    customPath,
  });

  if (!findings || findings.length === 0) return null;

  // Return the highest-confidence finding (verified wins over unverified)
  let best = mapFindingToMatch(findings[0]);
  for (let i = 1; i < findings.length; i++) {
    const mapped = mapFindingToMatch(findings[i]);
    if (mapped.confidence > best.confidence) {
      best = mapped;
    }
  }
  return best;
}

// --- Main entry point ---

export async function runTruffleHog(
  text: string,
): Promise<TruffleHogMatch | null> {
  // Try native CLI first
  try {
    const nativeResult = await runTruffleHogNative(text);
    if (nativeResult) return nativeResult;
  } catch {
    // Native unavailable or errored — fall through to regex
  }

  // Fallback to regex detectors
  return runTruffleHogRegex(text);
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  const prefix = secret.substring(0, 8);
  const suffix = secret.substring(secret.length - 4);
  return `${prefix}****${suffix}`;
}
