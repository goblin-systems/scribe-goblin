/**
 * Fallback classification for passwords and generic credentials.
 * Ideally, this should use SAP/password-model (TinyBERT) via transformers.js or a similar local inference engine.
 * For now, it uses high-entropy and pattern-based heuristics as a lightweight substitute.
 */

export interface PasswordModelResult {
  is_secret: boolean;
  score: number;
  type: string;
}

export function runPasswordModel(text: string): PasswordModelResult {
  const score = calculateHeuristicScore(text);
  
  // Use a more conservative threshold of 0.85+
  return {
    is_secret: score >= 0.85,
    score: score,
    type: "password",
  };
}

function calculateHeuristicScore(text: string): number {
  if (text.length < 8) return 0.1;
  if (text.length > 128) return 0.2; // Too long for a typical password

  // Check for common password indicators
  const hasDigit = /\d/.test(text);
  const hasLower = /[a-z]/.test(text);
  const hasUpper = /[A-Z]/.test(text);
  const hasSpecial = /[^A-Za-z0-9]/.test(text);

  let score = 0;
  if (hasDigit) score += 0.2;
  if (hasLower) score += 0.1;
  if (hasUpper) score += 0.2;
  if (hasSpecial) score += 0.3;

  // Entropy check
  const entropy = calculateEntropy(text);
  if (entropy > 3.5) score += 0.2;
  
  // Bonus for "typical" password length
  if (text.length >= 12 && text.length <= 24) score += 0.1;

  // Penalize for very common patterns or low diversity
  const uniqueChars = new Set(text).size;
  if (uniqueChars < text.length / 2) score -= 0.3;

  return Math.min(1.0, Math.max(0.0, score));
}

function calculateEntropy(str: string): number {
  const len = str.length;
  if (len === 0) return 0;
  const frequencies: Record<string, number> = {};
  for (const char of str) {
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in frequencies) {
    const p = frequencies[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
