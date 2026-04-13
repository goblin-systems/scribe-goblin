import type { SecretDetectionResult, SecretType } from "./types";

interface TruffleHogMatch {
  detector: string;
  type: SecretType;
  confidence: number;
}

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

export function runTruffleHog(text: string): TruffleHogMatch | null {
  for (const detector of DETECTORS) {
    if (detector.regex.test(text)) {
      // Basic match
      return {
        detector: detector.name,
        type: detector.type,
        confidence: 0.9, // Default for regex matches
      };
    }
  }
  return null;
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  const prefix = secret.substring(0, 8);
  const suffix = secret.substring(secret.length - 4);
  return `${prefix}****${suffix}`;
}
