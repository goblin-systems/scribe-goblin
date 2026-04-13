export interface EntryRow {
  id: string; // UUID
  content: string;
  html_content: string | null;
  source: string;
  source_app: string | null;
  created_at: number;
  label: string | null;
  label_score: number | null;
  manual_badges: string | null;
  embedding: string | null;  // JSON number[]
  secret_verdict: string | null;
  secret_type: string | null;
  secret_source: string | null;
  is_note: boolean;
}

export interface ManualBadge {
  name: string;
  color: string;
}

export function parseManualBadges(manual_badges: string | null): ManualBadge[] {
  if (!manual_badges) return [];
  try {
    const parsed = JSON.parse(manual_badges);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item): ManualBadge => {
      if (typeof item === "string") return { name: item, color: "default" };
      if (typeof item === "object" && item !== null && typeof item.name === "string") {
        return { name: item.name, color: typeof item.color === "string" ? item.color : "default" };
      }
      return { name: String(item), color: "default" };
    });
  } catch {
    return [];
  }
}

export function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseEmbedding(embedding: string | null): number[] | null {
  if (!embedding) return null;
  try {
    const parsed = JSON.parse(embedding);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function formatRelativeTime(timestampMs: number): string {
  const diff = Date.now() - timestampMs;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(timestampMs).toLocaleDateString();
}

export function sourceIcon(source: string): string {
  switch (source) {
    case "manual": return "pencil";
    case "clipboard": return "clipboard";
    default: return "file-text";
  }
}
