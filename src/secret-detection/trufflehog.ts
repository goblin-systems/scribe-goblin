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

interface CachedTruffleHogStatus {
  customPath: string | null;
  status: TruffleHogStatus;
}

interface TruffleHogFinding {
  detector_name: string;
  verified: boolean;
  raw_redacted: string;
  decoder: string;
}

// --- Native TruffleHog CLI backend ---

let cachedStatus: CachedTruffleHogStatus | null = null;

export async function checkTruffleHogAvailability(
  customPath?: string,
): Promise<TruffleHogStatus> {
  const normalizedPath = customPath?.trim() || null;
  if (cachedStatus !== null && cachedStatus.customPath === normalizedPath) return cachedStatus.status;
  try {
    const status = await invoke<TruffleHogStatus>("trufflehog_check", {
      customPath,
    });
    cachedStatus = { customPath: normalizedPath, status };
  } catch {
    cachedStatus = {
      customPath: normalizedPath,
      status: {
        available: false,
        path: null,
        version: null,
        supports_stdin: false,
      },
    };
  }
  return cachedStatus.status;
}

/** Reset the cached status (useful when settings change). */
export function resetTruffleHogCache(): void {
  cachedStatus = null;
}

function mapDetectorNameToSecretType(detectorName: string): SecretType {
  const normalized = detectorName.toLowerCase().replace(/[^a-z0-9]/g, "");

  switch (normalized) {
    case "aws":
    case "awsiam":
    case "openai":
    case "stripe":
    case "google":
    case "gcp":
      return "api_key";
    case "github":
    case "githubapp":
    case "jwt":
    case "slack":
    case "slackwebhook":
      return "token";
    case "privatekey":
      return "private_key";
    default:
      return "unknown";
  }
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
  customPath?: string,
): Promise<TruffleHogMatch | null> {
  return runTruffleHogNative(text, customPath);
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  const prefix = secret.substring(0, 8);
  const suffix = secret.substring(secret.length - 4);
  return `${prefix}****${suffix}`;
}
