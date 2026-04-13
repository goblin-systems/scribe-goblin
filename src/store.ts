export interface EntryRow {
  id: string; // UUID
  content: string;
  html_content: string | null;
  source: string;
  source_app: string | null;
  created_at: number;
  label: string | null;
  label_score: number | null;
  embedding: string | null;  // JSON number[]
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
