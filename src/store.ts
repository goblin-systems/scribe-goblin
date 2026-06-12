export interface EntryRow {
  id: string; // UUID
  content: string;
  html_content: string | null;
  source: string;
  source_app: string | null;
  created_at: number;
  pinned: boolean;
  label: string | null;
  label_score: number | null;
  summary: string | null;
  tags_json: string | null;
  enrichment_tags: string | null;
  processing_diagnostics: string | null;
  manual_badges: string | null;
  secret_verdict: string | null;
  secret_type: string | null;
  secret_source: string | null;
  collection_id: string | null;
  checklist_completed: boolean;
  is_note: boolean;
  import_origin: string | null;
  import_name: string | null;
  content_type: string | null;
  attachment_rel_path: string | null;
  attachment_size_bytes: number | null;
  attachment_sha256: string | null;
  collection_sort_order: number | null;
}

export type EntryTagSource = "manual" | "ai" | "heuristic" | "trufflehog";
export type EntryTagKind = "manual" | "classification" | "enrichment" | "detector";

export interface EntryTagRecord {
  id: string;
  name: string;
  source: EntryTagSource;
  kind: EntryTagKind;
  created_at: number;
  confidence: number | null;
  provider: string | null;
  model: string | null;
  color: string | null;
}

export interface ProcessingHeuristicMatch {
  label: string;
  reason: string;
}

export interface ProcessingHeuristicDiagnostics {
  status: "completed" | "failed";
  matches: ProcessingHeuristicMatch[];
  error: string | null;
}

export interface ProcessingEnrichmentDiagnostics {
  status: "completed" | "fallback" | "unavailable" | "skipped" | "failed";
  provider: string;
  model: string | null;
  summary_present: boolean;
  tags_returned: string[];
  source: "provider" | "heuristic" | "none";
  reason: string | null;
  error: string | null;
}

export interface ProcessingSecretStageDiagnostics {
  status: string;
  enabled?: boolean;
  available?: boolean;
  matched: boolean;
  verified: boolean | null;
  detector: string | null;
  model: string | null;
  top_score: number | null;
  span_count: number | null;
}

export interface ProcessingSecretDiagnostics {
  final_verdict: string;
  final_type: string;
  final_source: string;
  trufflehog: ProcessingSecretStageDiagnostics;
  secret_masker: ProcessingSecretStageDiagnostics;
}

export interface ProcessingDiagnostics {
  version: 2;
  heuristic: ProcessingHeuristicDiagnostics;
  enrichment: ProcessingEnrichmentDiagnostics;
  secret_detection: ProcessingSecretDiagnostics;
}

export type CollectionType = "standard" | "checklist" | "filter";

export interface CollectionRow {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  collection_type: CollectionType;
  filter_query?: string | null;
  kind: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface SearchFilters {
  scope?: string | null;
  source?: string | null;
  collection_id?: string | null;
  source_app?: string | null;
  tag?: string | null;
  related_to?: string | null;
  date_from?: number | null;
  date_to?: number | null;
  is_note?: boolean | null;
}

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface SearchDiagnostics {
  query_text: string | null;
  fts_query: string | null;
  applied_filters: string[];
  bm25: number | null;
  search_mode?: SearchMode | null;
  cosine_similarity?: number | null;
  semantic_fallback_reason?: string | null;
  keyword_rank?: number | null;
  semantic_rank?: number | null;
  keyword_weight?: number | null;
  semantic_weight?: number | null;
  keyword_rrf_score?: number | null;
  semantic_rrf_score?: number | null;
  recency_max_boost?: number | null;
  rrf_k?: number | null;
  recency_boost?: number | null;
  fused_score?: number | null;
}

export interface SearchDiagnosticsPayload {
  query_text?: string | null;
  queryText?: string | null;
  fts_query?: string | null;
  ftsQuery?: string | null;
  applied_filters?: readonly string[] | string[] | null;
  appliedFilters?: readonly string[] | string[] | null;
  bm25?: number | null;
  search_mode?: SearchMode | null;
  searchMode?: SearchMode | null;
  cosine_similarity?: number | null;
  cosineSimilarity?: number | null;
  semantic_fallback_reason?: string | null;
  semanticFallbackReason?: string | null;
  keyword_rank?: number | null;
  keywordRank?: number | null;
  semantic_rank?: number | null;
  semanticRank?: number | null;
  keyword_weight?: number | null;
  keywordWeight?: number | null;
  semantic_weight?: number | null;
  semanticWeight?: number | null;
  keyword_rrf_score?: number | null;
  keywordRrfScore?: number | null;
  semantic_rrf_score?: number | null;
  semanticRrfScore?: number | null;
  recency_max_boost?: number | null;
  recencyMaxBoost?: number | null;
  rrf_k?: number | null;
  rrfK?: number | null;
  recency_boost?: number | null;
  recencyBoost?: number | null;
  fused_score?: number | null;
  fusedScore?: number | null;
}

export interface SearchEntryResult {
  entry: EntryRow;
  rank: number;
  match_type: string;
  match_reasons: string[];
  matched_terms: string[];
  matched_tags: string[];
  diagnostics: SearchDiagnostics;
}

export interface SearchEntryResultPayload {
  entry: EntryRow;
  rank: number;
  match_type?: string | null;
  matchType?: string | null;
  match_reasons?: readonly string[] | string[] | null;
  matchReasons?: readonly string[] | string[] | null;
  matched_terms?: readonly string[] | string[] | null;
  matchedTerms?: readonly string[] | string[] | null;
  matched_tags?: readonly string[] | string[] | null;
  matchedTags?: readonly string[] | string[] | null;
  diagnostics?: SearchDiagnostics | SearchDiagnosticsPayload | null;
}

export type SearchDiagnosticsLike = SearchDiagnostics | SearchDiagnosticsPayload | null | undefined;
export type SearchEntryResultLike = SearchEntryResult | SearchEntryResultPayload;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function readAliasedField<T>(value: unknown, snake_case_key: string, camelCaseKey: string): T | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (snake_case_key in record) return record[snake_case_key] as T;
  if (camelCaseKey in record) return record[camelCaseKey] as T;
  return undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string");
}

function normalizeSearchModeValue(value: unknown): SearchMode | null {
  if (typeof value !== "string") return null;

  switch (value.trim().toLowerCase()) {
    case "keyword":
    case "semantic":
    case "hybrid":
      return value.trim().toLowerCase() as SearchMode;
    default:
      return null;
  }
}

export function normalizeSearchDiagnostics(diagnostics: SearchDiagnosticsLike): SearchDiagnostics {
  return {
    query_text: normalizeOptionalString(readAliasedField(diagnostics, "query_text", "queryText")),
    fts_query: normalizeOptionalString(readAliasedField(diagnostics, "fts_query", "ftsQuery")),
    applied_filters: normalizeStringList(readAliasedField(diagnostics, "applied_filters", "appliedFilters")),
    bm25: normalizeOptionalNumber(readAliasedField(diagnostics, "bm25", "bm25")),
    search_mode: normalizeSearchModeValue(readAliasedField(diagnostics, "search_mode", "searchMode")),
    cosine_similarity: normalizeOptionalNumber(readAliasedField(diagnostics, "cosine_similarity", "cosineSimilarity")),
    semantic_fallback_reason: normalizeOptionalString(readAliasedField(diagnostics, "semantic_fallback_reason", "semanticFallbackReason")),
    keyword_rank: normalizeOptionalNumber(readAliasedField(diagnostics, "keyword_rank", "keywordRank")),
    semantic_rank: normalizeOptionalNumber(readAliasedField(diagnostics, "semantic_rank", "semanticRank")),
    keyword_weight: normalizeOptionalNumber(readAliasedField(diagnostics, "keyword_weight", "keywordWeight")),
    semantic_weight: normalizeOptionalNumber(readAliasedField(diagnostics, "semantic_weight", "semanticWeight")),
    keyword_rrf_score: normalizeOptionalNumber(readAliasedField(diagnostics, "keyword_rrf_score", "keywordRrfScore")),
    semantic_rrf_score: normalizeOptionalNumber(readAliasedField(diagnostics, "semantic_rrf_score", "semanticRrfScore")),
    recency_max_boost: normalizeOptionalNumber(readAliasedField(diagnostics, "recency_max_boost", "recencyMaxBoost")),
    rrf_k: normalizeOptionalNumber(readAliasedField(diagnostics, "rrf_k", "rrfK")),
    recency_boost: normalizeOptionalNumber(readAliasedField(diagnostics, "recency_boost", "recencyBoost")),
    fused_score: normalizeOptionalNumber(readAliasedField(diagnostics, "fused_score", "fusedScore")),
  };
}

export function normalizeSearchEntryResult(result: SearchEntryResultLike): SearchEntryResult {
  return {
    entry: readAliasedField<EntryRow>(result, "entry", "entry") as EntryRow,
    rank: normalizeOptionalNumber(readAliasedField(result, "rank", "rank")) ?? 0,
    match_type: normalizeOptionalString(readAliasedField(result, "match_type", "matchType")) ?? "",
    match_reasons: normalizeStringList(readAliasedField(result, "match_reasons", "matchReasons")),
    matched_terms: normalizeStringList(readAliasedField(result, "matched_terms", "matchedTerms")),
    matched_tags: normalizeStringList(readAliasedField(result, "matched_tags", "matchedTags")),
    diagnostics: normalizeSearchDiagnostics(readAliasedField(result, "diagnostics", "diagnostics")),
  };
}

export function normalizeSearchEntryResults(results: SearchEntryResultLike[] | unknown): SearchEntryResult[] {
  if (!Array.isArray(results)) return [];
  return results.map((result) => normalizeSearchEntryResult(result as SearchEntryResultLike));
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

export function parseEntryTags(raw: string | null): EntryTagRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is EntryTagRecord => {
      return Boolean(
        item &&
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          typeof item.source === "string" &&
          typeof item.kind === "string",
      );
    });
  } catch {
    return [];
  }
}

export function parseProcessingDiagnostics(
  raw: string | null,
): ProcessingDiagnostics | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ProcessingDiagnostics>;
    if (parsed?.version !== 2) return null;
    if (!parsed.heuristic || !parsed.enrichment || !parsed.secret_detection) {
      return null;
    }
    return parsed as ProcessingDiagnostics;
  } catch {
    return null;
  }
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
    case "import": return "file-up";
    default: return "file-text";
  }
}

export function sourceLabel(source: string): string {
  switch (source) {
    case "manual": return "Manual";
    case "clipboard": return "Clipboard";
    case "import": return "Import";
    default: return source;
  }
}

export function formatImportOrigin(origin: string | null): string | null {
  if (!origin) return null;

  switch (origin) {
    case "pasted-text": return "pasted text";
    case "file-picker": return "file picker";
    case "drag-drop": return "drag & drop";
    default: return origin.replace(/[-_]+/g, " ");
  }
}

export function isAttachmentOnlyEntry(entry: Pick<EntryRow, "attachment_rel_path">): boolean {
  return Boolean(entry.attachment_rel_path);
}

export function overlayFooterHintText(entry: Pick<EntryRow, "attachment_rel_path"> | null | undefined): string {
  return entry && isAttachmentOnlyEntry(entry)
    ? "Attachment-only import selected — paste is blocked"
    : "Paste";
}

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;

  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}
