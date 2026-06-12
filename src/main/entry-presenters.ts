import type {
  EntryRow,
  ProcessingDiagnostics,
  SearchEntryResult,
  SearchEntryResultLike,
} from "../store";
import {
  parseEntryTags,
  formatBytes,
  formatImportOrigin,
  isAttachmentOnlyEntry,
  parseTags,
  parseProcessingDiagnostics,
  normalizeSearchDiagnostics,
  normalizeSearchEntryResult,
  sourceLabel,
} from "../store";

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizePresentString(value: unknown, fallback = "—"): string {
  const normalized = normalizeOptionalString(value);
  return normalized && normalized.length > 0 ? normalized : fallback;
}

export function escapeHtml(str: unknown): string {
  const value = normalizeOptionalString(str) ?? (str == null ? "" : String(str));
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getEntryPreviewText(entry: EntryRow): string {
  const basis = entry.import_name?.trim() || entry.content;
  return basis.length > 140
    ? basis.slice(0, 140).trimEnd() + "…"
    : basis;
}

export function buildEntryPreview(entry: EntryRow): string {
  return escapeHtml(getEntryPreviewText(entry));
}

export function buildMaskedSecretPreview(entry: EntryRow, maskedLength = 32): string {
  return "•".repeat(Math.min(getEntryPreviewText(entry).length, maskedLength));
}

export function isSecretEntry(entry: EntryRow): boolean {
  return Boolean(entry.secret_verdict && entry.secret_verdict !== "not_secret");
}

export function buildDisplayEntryPreview(
  entry: EntryRow,
  options: {
    revealSecrets?: boolean;
    maskedLength?: number;
  } = {},
): string {
  if (isSecretEntry(entry) && !options.revealSecrets) {
    return buildMaskedSecretPreview(entry, options.maskedLength);
  }

  return buildEntryPreview(entry);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLexicalHighlightTerms(result: SearchEntryResultLike | null | undefined): string[] {
  if (!result) return [];

  const normalizedResult = normalizeSearchEntryResult(result);
  const matchReasons = normalizeStringList(normalizedResult.match_reasons);
  if (!matchReasons.includes("keyword")) return [];

  const uniqueTerms = new Map<string, string>();
  for (const rawTerm of normalizeStringList(normalizedResult.matched_terms)) {
    const separatorIndex = rawTerm.indexOf(":");
    const term = (separatorIndex >= 0 ? rawTerm.slice(separatorIndex + 1) : rawTerm).trim();
    if (!term) continue;
    const key = term.toLocaleLowerCase();
    if (!uniqueTerms.has(key)) uniqueTerms.set(key, term);
  }

  return [...uniqueTerms.values()].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function buildHighlightedHtml(text: string, terms: readonly string[]): string {
  if (!text || terms.length === 0) return escapeHtml(text);

  const lowerText = text.toLocaleLowerCase();
  const matches: Array<{ start: number; end: number }> = [];

  for (const term of terms) {
    if (!term) continue;
    const regex = new RegExp(escapeRegExp(term), "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const matchedText = match[0];
      if (!matchedText) {
        regex.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + matchedText.length;
      if (lowerText.slice(start, end) === matchedText.toLocaleLowerCase()) {
        matches.push({ start, end });
      }
    }
  }

  if (matches.length === 0) return escapeHtml(text);

  matches.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));

  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (cursor < match.start) {
      parts.push(escapeHtml(text.slice(cursor, match.start)));
    }
    parts.push(`<mark class="search-highlight">${escapeHtml(text.slice(match.start, match.end))}</mark>`);
    cursor = match.end;
  }

  if (cursor < text.length) {
    parts.push(escapeHtml(text.slice(cursor)));
  }

  return parts.join("");
}

export function buildSearchHighlightedPreview(
  entry: EntryRow,
  result: SearchEntryResultLike | null | undefined,
  options: {
    revealSecrets?: boolean;
    maskedLength?: number;
  } = {},
): string {
  if (isSecretEntry(entry) && !options.revealSecrets) {
    return buildMaskedSecretPreview(entry, options.maskedLength);
  }

  return buildHighlightedHtml(getEntryPreviewText(entry), getLexicalHighlightTerms(result));
}

export function renderImportMetaBadges(entry: EntryRow): string {
  if (entry.source !== "import") return "";

  const parts: string[] = [];

  const origin = formatImportOrigin(entry.import_origin);
  if (origin) {
    parts.push(`<span class="badge badge-muted">${escapeHtml(origin)}</span>`);
  }

  if (entry.content_type) {
    parts.push(`<span class="badge badge-muted">${escapeHtml(entry.content_type)}</span>`);
  }

  if (isAttachmentOnlyEntry(entry)) {
    const size = formatBytes(entry.attachment_size_bytes);
    parts.push(`<span class="badge badge-muted">attachment${size ? ` · ${escapeHtml(size)}` : ""}</span>`);
  }

  return parts.join(" ");
}

export function buildEntryDetailMeta(entry: EntryRow): string[] {
  const parts = [sourceLabel(entry.source)];

  if (entry.source_app) {
    parts.push(`via ${entry.source_app}`);
  }

  if (entry.source === "import") {
    const origin = formatImportOrigin(entry.import_origin);
    if (origin) parts.push(origin);
    if (entry.import_name) parts.push(entry.import_name);
    if (entry.content_type) parts.push(entry.content_type);
    if (entry.attachment_size_bytes !== null) {
      const size = formatBytes(entry.attachment_size_bytes);
      if (size) parts.push(size);
    }
  }

  return parts;
}

export function renderEntryDetailContent(entry: EntryRow): string | null {
  if (!isAttachmentOnlyEntry(entry)) return null;

  const importName = entry.import_name?.trim() || "Imported attachment";
  const metadata: string[] = [];

  if (entry.content_type) metadata.push(entry.content_type);
  const size = formatBytes(entry.attachment_size_bytes);
  if (size) metadata.push(size);
  if (entry.import_origin) {
    const origin = formatImportOrigin(entry.import_origin);
    if (origin) metadata.push(origin);
  }

  return `
    <div class="attachment-card">
      <div class="attachment-card-icon"><i data-lucide="paperclip"></i></div>
      <div class="attachment-card-body">
        <div class="attachment-card-title">${escapeHtml(importName)}</div>
        <div class="attachment-card-subtitle">Attachment-only import</div>
        ${metadata.length > 0 ? `<div class="attachment-card-meta">${metadata.map((part) => escapeHtml(part)).join(" · ")}</div>` : ""}
        <p class="hint attachment-card-hint">This entry stores an imported file without extracted text content.</p>
      </div>
    </div>
  `;
}

export function renderEntryDetailText(
  entry: EntryRow,
  result: SearchEntryResultLike | null | undefined,
): string | null {
  if (isAttachmentOnlyEntry(entry)) return null;
  return buildHighlightedHtml(entry.content, getLexicalHighlightTerms(result));
}

function badgeColorClass(color: string): string {
  switch (color) {
    case "blue":
      return "badge beta";
    case "green":
      return "badge success";
    case "red":
      return "badge error";
    case "orange":
      return "badge warning";
    default:
      return "badge badge-muted";
  }
}

export function renderEntryBadges(
  entry: EntryRow,
  options: { includePinned?: boolean; includeScoreHint?: boolean } = {},
): string {
  const parts: string[] = [];
  const tags = parseEntryTags(entry.tags_json);

  if (options.includePinned && entry.pinned) {
    parts.push(`<span class="badge badge-muted">Pinned</span>`);
  }

  for (const tag of tags) {
    const badgeClass =
      tag.source === "heuristic"
        ? "badge beta"
        : tag.source === "trufflehog"
          ? "badge error"
          : tag.source === "ai"
            ? "badge ai"
            : badgeColorClass(tag.color ?? "default");
    parts.push(
      `<span class="${badgeClass}">${escapeHtml(tag.name)}<button class="badge-remove-btn" data-entry-id="${entry.id}" data-tag-id="${escapeHtml(tag.id)}" type="button" aria-label="Remove tag">x</button></span>`,
    );
    if (options.includeScoreHint && tag.kind === "classification" && typeof tag.confidence === "number") {
      parts.push(`<span class="hint">(${Math.round(tag.confidence * 100)}%)</span>`);
    }
  }

  return parts.join(" ");
}

function humanizeMatchReason(reason: unknown): string {
  const normalized = normalizeOptionalString(reason);
  if (!normalized) return "unknown";

  switch (normalized) {
    case "keyword": return "keyword";
    case "semantic": return "semantic";
    case "recent": return "recent";
    case "related-via-tag": return "related via tag";
    default: return normalized.replace(/[-_]+/g, " ");
  }
}

function normalizeStringList(values: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string");
}

function normalizeSearchDebugData(result: SearchEntryResultLike) {
  const normalizedResult = normalizeSearchEntryResult(result);
  return {
    result: normalizedResult,
    matchReasons: normalizeStringList(normalizedResult.match_reasons),
    matchedTerms: normalizeStringList(normalizedResult.matched_terms),
    matchedTags: normalizeStringList(normalizedResult.matched_tags),
    diagnostics: normalizeSearchDiagnostics(normalizedResult.diagnostics),
  };
}

export function renderSearchSummary(resultCount: number, query: string, scopeLabel: string): string {
  if (resultCount === 0) return `No ${scopeLabel} for "${query}"`;
  return `${resultCount} ${scopeLabel}${resultCount === 1 ? "" : "s"} for "${query}"`;
}

export function renderSearchExplanation(result: SearchEntryResultLike): string {
  const { matchReasons, matchedTags, matchedTerms } = normalizeSearchDebugData(result);
  const reasons = matchReasons.map(humanizeMatchReason);
  const tagReasons = matchedTags.slice(0, 2).map((tag) => `tag:${tag}`);
  const terms = matchedTerms.slice(0, 2);
  const parts = [...reasons, ...tagReasons, ...terms];
  return parts.length > 0 ? parts.join(" | ") : "matched by filters";
}

export function renderSearchDiagnostics(result: SearchEntryResultLike): string {
  const parts: string[] = [];
  const { diagnostics } = normalizeSearchDebugData(result);
  const mode = diagnostics.search_mode;
  if (mode) parts.push(mode);
  if (typeof diagnostics.keyword_rank === "number") parts.push(`kw #${diagnostics.keyword_rank}`);
  if (typeof diagnostics.semantic_rank === "number") parts.push(`sem #${diagnostics.semantic_rank}`);
  const bucket = inferRankingBucket(diagnostics);
  if (bucket) parts.push(`${bucket} weights`);
  if (typeof diagnostics.cosine_similarity === "number") parts.push(`cos ${diagnostics.cosine_similarity.toFixed(3)}`);
  if (typeof diagnostics.bm25 === "number") parts.push(`bm25 ${diagnostics.bm25.toFixed(3)}`);
  if (typeof diagnostics.recency_boost === "number" && diagnostics.recency_boost > 0) {
    parts.push(`recency +${diagnostics.recency_boost.toFixed(3)}`);
  }
  if (diagnostics.semantic_fallback_reason) parts.push(`fallback ${diagnostics.semantic_fallback_reason}`);
  return parts.join(" | ");
}

function formatDebugNumber(value: number | null | undefined, digits = 3): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : null;
}

function formatDebugNumberPrecise(value: number | null | undefined, digits = 4): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : null;
}

function formatFormulaNumber(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function inferRankingBucket(diagnostics: ReturnType<typeof normalizeSearchDiagnostics>): string | null {
  const query = diagnostics.query_text?.trim();
  if (!query) return null;

  const queryLength = query.length;
  const termCount = query.split(/\s+/).filter(Boolean).length;

  if (termCount <= 2 || queryLength <= 18) return "short";
  if (termCount >= 4 || queryLength >= 36) return "long";
  return "medium";
}

function buildScoreBreakdownParts(diagnostics: ReturnType<typeof normalizeSearchDiagnostics>): string[] {
  const parts: string[] = [];

  if (typeof diagnostics.keyword_rrf_score === "number") {
    const score = formatDebugNumberPrecise(diagnostics.keyword_rrf_score) ?? String(diagnostics.keyword_rrf_score);
    const weight = formatDebugNumber(diagnostics.keyword_weight);
    const rank = typeof diagnostics.keyword_rank === "number" ? `#${diagnostics.keyword_rank}` : "—";
    parts.push(`kw ${score}${weight ? ` (w=${weight}, ${rank})` : ` (${rank})`}`);
  }

  if (typeof diagnostics.semantic_rrf_score === "number") {
    const score = formatDebugNumberPrecise(diagnostics.semantic_rrf_score) ?? String(diagnostics.semantic_rrf_score);
    const weight = formatDebugNumber(diagnostics.semantic_weight);
    const rank = typeof diagnostics.semantic_rank === "number" ? `#${diagnostics.semantic_rank}` : "—";
    parts.push(`sem ${score}${weight ? ` (w=${weight}, ${rank})` : ` (${rank})`}`);
  }

  if (typeof diagnostics.recency_boost === "number" && diagnostics.recency_boost > 0) {
    const score = formatDebugNumberPrecise(diagnostics.recency_boost) ?? String(diagnostics.recency_boost);
    const max = formatDebugNumber(diagnostics.recency_max_boost);
    parts.push(`recent ${score}${max ? ` (max=${max})` : ""}`);
  }

  return parts;
}

function hasFullHybridBreakdown(diagnostics: ReturnType<typeof normalizeSearchDiagnostics>): boolean {
  return typeof diagnostics.fused_score === "number"
    && (
      typeof diagnostics.keyword_rrf_score === "number"
      || typeof diagnostics.semantic_rrf_score === "number"
      || typeof diagnostics.recency_boost === "number"
    );
}

function renderCompactScoreBreakdown(diagnostics: ReturnType<typeof normalizeSearchDiagnostics>): string | null {
  if (!hasFullHybridBreakdown(diagnostics)) return null;

  const keyword = formatDebugNumberPrecise(diagnostics.keyword_rrf_score) ?? "0.0000";
  const semantic = formatDebugNumberPrecise(diagnostics.semantic_rrf_score) ?? "0.0000";
  const recency = formatDebugNumberPrecise(diagnostics.recency_boost) ?? "0.0000";
  const fused = formatDebugNumberPrecise(diagnostics.fused_score) ?? "0.0000";
  return `kw_rrf=${keyword} + sem_rrf=${semantic} + recency=${recency} => fused=${fused}`;
}

function renderCompactFormula(diagnostics: ReturnType<typeof normalizeSearchDiagnostics>): string | null {
  const k = formatFormulaNumber(diagnostics.rrf_k);
  if (!k) return null;

  const parts: string[] = [];
  if (typeof diagnostics.keyword_rank === "number" && typeof diagnostics.keyword_weight === "number") {
    parts.push(`kw_rrf=${formatDebugNumber(diagnostics.keyword_weight)} / (${k} + ${diagnostics.keyword_rank})`);
  }
  if (typeof diagnostics.semantic_rank === "number" && typeof diagnostics.semantic_weight === "number") {
    parts.push(`sem_rrf=${formatDebugNumber(diagnostics.semantic_weight)} / (${k} + ${diagnostics.semantic_rank})`);
  }
  if (typeof diagnostics.recency_max_boost === "number") {
    parts.push(`recency in [0, ${formatDebugNumber(diagnostics.recency_max_boost) ?? "0"}]`);
  }

  return parts.length > 0 ? parts.join("; ") : null;
}

function renderScoreBreakdown(diagnostics: ReturnType<typeof normalizeSearchDiagnostics>): string {
  const compact = renderCompactScoreBreakdown(diagnostics);
  if (compact) return compact;

  const parts = buildScoreBreakdownParts(diagnostics);
  const fused = formatDebugNumberPrecise(diagnostics.fused_score);
  if (parts.length === 0) return "—";
  return fused ? `${parts.join(" + ")} = ${fused}` : parts.join(" + ");
}

export function renderSearchFormulaLine(result: SearchEntryResultLike): string {
  const { diagnostics } = normalizeSearchDebugData(result);
  return renderCompactFormula(diagnostics) ?? "—";
}

export function renderSearchScoreBreakdownLine(result: SearchEntryResultLike): string {
  const { diagnostics } = normalizeSearchDebugData(result);
  return renderScoreBreakdown(diagnostics);
}

export function renderSearchFormulaExplanationLine(result: SearchEntryResultLike): string {
  const { diagnostics } = normalizeSearchDebugData(result);
  const pieces: string[] = [];

  const k = formatFormulaNumber(diagnostics.rrf_k);
  if (k) {
    pieces.push(`rrf_k=${k} is the ranking constant added to every rank`);
  }

  if (typeof diagnostics.keyword_rank === "number" && typeof diagnostics.keyword_weight === "number") {
    const keywordWeight = formatDebugNumber(diagnostics.keyword_weight) ?? String(diagnostics.keyword_weight);
    const keywordScore = formatDebugNumberPrecise(diagnostics.keyword_rrf_score) ?? "—";
    pieces.push(`keyword_weight=${keywordWeight} and keyword_rank=${diagnostics.keyword_rank} give kw_rrf=${keywordScore}`);
  }

  if (typeof diagnostics.semantic_rank === "number" && typeof diagnostics.semantic_weight === "number") {
    const semanticWeight = formatDebugNumber(diagnostics.semantic_weight) ?? String(diagnostics.semantic_weight);
    const semanticScore = formatDebugNumberPrecise(diagnostics.semantic_rrf_score) ?? "—";
    pieces.push(`semantic_weight=${semanticWeight} and semantic_rank=${diagnostics.semantic_rank} give sem_rrf=${semanticScore}`);
  }

  if (typeof diagnostics.recency_max_boost === "number") {
    const recencyMax = formatDebugNumber(diagnostics.recency_max_boost) ?? String(diagnostics.recency_max_boost);
    pieces.push(`recency_boost ranges from 0 to ${recencyMax}`);
  }

  return pieces.length > 0 ? pieces.join(" | ") : "—";
}

export function renderSearchSignalExplanationLine(result: SearchEntryResultLike): string {
  const { diagnostics } = normalizeSearchDebugData(result);
  const pieces: string[] = [];

  if (typeof diagnostics.cosine_similarity === "number") {
    pieces.push(`cosine_similarity=${diagnostics.cosine_similarity.toFixed(3)} is the raw semantic similarity, not the final ranking score`);
  }

  if (typeof diagnostics.bm25 === "number") {
    pieces.push(`bm25=${diagnostics.bm25.toFixed(3)} is the raw keyword relevance score, not the final ranking score`);
  }

  if (typeof diagnostics.fused_score === "number") {
    pieces.push(`fused_score=${diagnostics.fused_score.toFixed(4)} is the final ranking score used to sort results`);
  }

  return pieces.length > 0 ? pieces.join(" | ") : "—";
}

function renderDebugGroup(title: string, rows: string): string {
  return `
    <div class="debug-group">
      <div class="debug-group-title">${escapeHtml(title)}</div>
      <div class="debug-grid">${rows}</div>
    </div>
  `;
}

function joinDebugValues(values: readonly string[] | null | undefined): string {
  const normalizedValues = normalizeStringList(values);
  return normalizedValues.length > 0 ? normalizedValues.join(", ") : "—";
}

function renderDebugRow(
  label: string,
  value: unknown,
  explanation?: string,
  kind: "text" | "code" = "text",
): string {
  return `
    <div class="debug-grid-row">
      <span class="debug-label">${escapeHtml(label)}</span>
      <span class="debug-value${kind === "code" ? " debug-code" : ""}">${escapeHtml(value)}</span>
      <span class="debug-explanation">${explanation ? escapeHtml(explanation) : ""}</span>
    </div>
  `;
}

export function renderSearchDebugSummary(result: SearchEntryResultLike): string {
  const { result: normalizedResult, diagnostics } = normalizeSearchDebugData(result);
  const parts: string[] = [`rank #${normalizedResult.rank}`, normalizePresentString(normalizedResult.match_type, "unknown")];

  if (diagnostics.search_mode) parts.push(`mode ${diagnostics.search_mode}`);
  if (typeof diagnostics.keyword_rank === "number") parts.push(`kw #${diagnostics.keyword_rank}`);
  if (typeof diagnostics.semantic_rank === "number") parts.push(`sem #${diagnostics.semantic_rank}`);
  const bucket = inferRankingBucket(diagnostics);
  if (bucket) parts.push(`${bucket} weights`);

  const fused = formatDebugNumber(diagnostics.fused_score);
  if (fused) parts.push(`fused ${fused}`);

  const bm25 = formatDebugNumber(diagnostics.bm25);
  if (bm25) parts.push(`bm25 ${bm25}`);

  const cosine = formatDebugNumber(diagnostics.cosine_similarity);
  if (cosine) parts.push(`cos ${cosine}`);

  return parts.join(" | ");
}

export function renderSearchDebugContext(result: SearchEntryResultLike): string {
  const { matchedTerms, matchedTags, diagnostics } = normalizeSearchDebugData(result);
  const parts: string[] = [];

  if (matchedTerms.length > 0) {
    parts.push(`terms ${matchedTerms.join(", ")}`);
  }

  if (matchedTags.length > 0) {
    parts.push(`tags ${matchedTags.join(", ")}`);
  }

  if (diagnostics.applied_filters.length > 0) {
    parts.push(`filters ${diagnostics.applied_filters.join(", ")}`);
  }

  if (diagnostics.semantic_fallback_reason) {
    parts.push(`fallback ${diagnostics.semantic_fallback_reason}`);
  }

  return parts.join(" | ");
}

export function renderSearchDebugSection(result: SearchEntryResultLike): string {
  const { result: normalizedResult, matchReasons, matchedTerms, matchedTags, diagnostics } = normalizeSearchDebugData(result);
  const overviewRows = [
    renderDebugRow("Why this matched", renderSearchExplanation(result)),
    renderDebugRow("Summary", renderSearchDiagnostics(result), "compact search metadata summary"),
    renderDebugRow("Rank", `#${normalizedResult.rank}`),
    renderDebugRow("Match type", normalizePresentString(normalizedResult.match_type, "unknown"), "why this result made the list"),
    renderDebugRow("Final ranking score", formatDebugNumberPrecise(diagnostics.fused_score) ?? "—", "this fused_score is the final score used to sort results"),
    renderDebugRow("Search mode", normalizePresentString(diagnostics.search_mode)),
    renderDebugRow("Weight bucket", inferRankingBucket(diagnostics) ?? "—", "selected query-length branch: short / medium / long"),
  ].join("");

  const formulaRows = [
    renderDebugRow("Formula", renderCompactFormula(diagnostics) ?? "—", "the exact ranking formula branch used for this result"),
    renderDebugRow("Formula terms", renderSearchFormulaExplanationLine(result), "what each number in the formula means"),
    renderDebugRow("Score breakdown", renderScoreBreakdown(diagnostics), "how kw_rrf, sem_rrf, and recency combine into fused_score"),
    renderDebugRow("Keyword rank", typeof diagnostics.keyword_rank === "number" ? `#${diagnostics.keyword_rank}` : "—", "position in keyword / FTS results"),
    renderDebugRow("Semantic rank", typeof diagnostics.semantic_rank === "number" ? `#${diagnostics.semantic_rank}` : "—", "position in vector similarity results"),
    renderDebugRow("Keyword weight", formatDebugNumber(diagnostics.keyword_weight) ?? "—", "hybrid weight applied to keyword reciprocal-rank fusion"),
    renderDebugRow("Semantic weight", formatDebugNumber(diagnostics.semantic_weight) ?? "—", "hybrid weight applied to semantic reciprocal-rank fusion"),
    renderDebugRow("RRF k", formatDebugNumber(diagnostics.rrf_k) ?? "—", "ranking constant added to every rank before division"),
    renderDebugRow("Keyword RRF", formatDebugNumberPrecise(diagnostics.keyword_rrf_score) ?? "—", "keyword contribution added into fused_score"),
    renderDebugRow("Semantic RRF", formatDebugNumberPrecise(diagnostics.semantic_rrf_score) ?? "—", "semantic contribution added into fused_score"),
    renderDebugRow("Recency boost", formatDebugNumberPrecise(diagnostics.recency_boost) ?? "—", "extra score added for newer entries"),
    renderDebugRow("Recency max", formatDebugNumber(diagnostics.recency_max_boost) ?? "—", "maximum recency bonus allowed by current ranking settings"),
  ].join("");

  const signalRows = [
    renderDebugRow("Signals", renderSearchSignalExplanationLine(result), "raw retrieval signals versus the final ranking score"),
    renderDebugRow("BM25", formatDebugNumber(diagnostics.bm25) ?? "—", "raw keyword relevance score from FTS; not the final ranking score"),
    renderDebugRow("Cosine similarity", formatDebugNumber(diagnostics.cosine_similarity) ?? "—", "raw semantic similarity; not the final ranking score"),
    renderDebugRow("Semantic fallback", normalizePresentString(diagnostics.semantic_fallback_reason), "why semantic scoring was skipped or downgraded"),
  ].join("");

  const queryRows = [
    renderDebugRow("Match reasons", joinDebugValues(matchReasons)),
    renderDebugRow("Matched terms", joinDebugValues(matchedTerms)),
    renderDebugRow("Matched tags", joinDebugValues(matchedTags)),
    renderDebugRow("Query", normalizePresentString(diagnostics.query_text), "the raw text entered by the user", "code"),
    renderDebugRow("FTS query", normalizePresentString(diagnostics.fts_query), "the full-text search query sent to SQLite FTS", "code"),
    renderDebugRow("Applied filters", joinDebugValues(diagnostics.applied_filters), "extra constraints like source, tags, or date limits"),
  ].join("");

  return `
    <details class="debug-disclosure">
      <summary>Search debug</summary>
      <div class="debug-disclosure-content">
        ${renderDebugGroup("Overview", overviewRows)}
        ${renderDebugGroup("Formula", formulaRows)}
        ${renderDebugGroup("Signals", signalRows)}
        ${renderDebugGroup("Query Context", queryRows)}
      </div>
    </details>
  `;
}

export function renderEmbeddingDebugSection(entry: EntryRow): string {
  const containerId = `embedding-debug-${entry.id}`;
  return `
    <details class="debug-disclosure">
      <summary>Entry embedding (vec_entries)</summary>
      <div class="debug-disclosure-content">
        <pre class="debug-pre" id="${containerId}">Loading…</pre>
      </div>
    </details>
  `;
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

function renderHeuristicMatches(diagnostics: ProcessingDiagnostics): string {
  const matches = diagnostics.heuristic.matches;
  if (matches.length === 0) return "—";
  return matches.map((match) => `${match.label} (${match.reason})`).join(", ");
}

export function renderProcessingDiagnosticsSection(entry: EntryRow): string {
  const diagnostics = parseProcessingDiagnostics(entry.processing_diagnostics);
  if (!diagnostics) {
    const fallbackRows = [
      renderDebugRow("Entry ID", entry.id),
      renderDebugRow("Collection ID", entry.collection_id ?? "—"),
      renderDebugRow("Is note", entry.is_note ? "yes" : "no"),
      renderDebugRow("Auto label", entry.label ?? "—"),
      renderDebugRow("Label score", formatPercent(entry.label_score)),
      renderDebugRow("Summary present", entry.summary ? "yes" : "no"),
      renderDebugRow("Stored tags", parseTags(entry.enrichment_tags).join(", ") || "—"),
      renderDebugRow("Secret verdict", entry.secret_verdict ?? "—"),
      renderDebugRow("Secret source", entry.secret_source ?? "—"),
      renderDebugRow(
        "Diagnostics",
        "No per-entry diagnostics recorded for this item.",
      ),
    ].join("");

    return `
      <details class="debug-disclosure">
        <summary>Tagging debug</summary>
        <div class="debug-disclosure-content">
          ${renderDebugGroup("Identifiers", fallbackRows)}
        </div>
      </details>
    `;
  }

  const identifierRows = [
    renderDebugRow("Entry ID", entry.id),
    renderDebugRow("Collection ID", entry.collection_id ?? "—"),
    renderDebugRow("Is note", entry.is_note ? "yes" : "no"),
    renderDebugRow("Source", entry.source),
  ].join("");

  const heuristicRows = [
    renderDebugRow("Status", diagnostics.heuristic.status),
    renderDebugRow("Matches", renderHeuristicMatches(diagnostics)),
    renderDebugRow("Error", diagnostics.heuristic.error ?? "—"),
  ].join("");

  const enrichmentRows = [
    renderDebugRow("Status", diagnostics.enrichment.status),
    renderDebugRow("Provider", diagnostics.enrichment.provider),
    renderDebugRow("Model", diagnostics.enrichment.model ?? "—"),
    renderDebugRow("Tag source", diagnostics.enrichment.source),
    renderDebugRow("Summary present", diagnostics.enrichment.summary_present ? "yes" : "no"),
    renderDebugRow("Tags", diagnostics.enrichment.tags_returned.join(", ") || "—"),
    renderDebugRow("Reason", diagnostics.enrichment.reason ?? "—"),
  ].join("");

  const secretRows = [
    renderDebugRow("Final verdict", diagnostics.secret_detection.final_verdict),
    renderDebugRow("Final type", diagnostics.secret_detection.final_type),
    renderDebugRow("Final source", diagnostics.secret_detection.final_source),
    renderDebugRow("TruffleHog", diagnostics.secret_detection.trufflehog.status),
    renderDebugRow("TruffleHog available", diagnostics.secret_detection.trufflehog.available ? "yes" : "no"),
    renderDebugRow("TruffleHog detector", diagnostics.secret_detection.trufflehog.detector ?? "—"),
    renderDebugRow("TruffleHog verified", diagnostics.secret_detection.trufflehog.verified === null ? "—" : diagnostics.secret_detection.trufflehog.verified ? "yes" : "no"),
    renderDebugRow("Secret masker", diagnostics.secret_detection.secret_masker.status),
    renderDebugRow("Secret masker enabled", diagnostics.secret_detection.secret_masker.enabled ? "yes" : "no"),
    renderDebugRow("Secret masker model", diagnostics.secret_detection.secret_masker.model ?? "—"),
    renderDebugRow("Secret masker top score", diagnostics.secret_detection.secret_masker.top_score ?? "—"),
    renderDebugRow("Secret masker span count", diagnostics.secret_detection.secret_masker.span_count ?? "—"),
  ].join("");

  return `
    <details class="debug-disclosure">
      <summary>Tagging debug</summary>
      <div class="debug-disclosure-content">
        ${renderDebugGroup("Identifiers", identifierRows)}
        ${renderDebugGroup("Heuristic tagging", heuristicRows)}
        ${renderDebugGroup("AI tagging", enrichmentRows)}
        ${renderDebugGroup("Secret detection", secretRows)}
      </div>
    </details>
  `;
}

export async function hydrateEmbeddingDebugSection(entry: EntryRow): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const container = document.getElementById(`embedding-debug-${entry.id}`);
  if (!container) return;
  try {
    const floats: number[] | null = await invoke("db_get_entry_embedding", { id: entry.id });
    if (floats) {
      const dims = floats.length;
      const preview = floats.slice(0, 8).map(f => f.toFixed(4)).join(", ");
      container.textContent = `${dims} dims\n[${preview}, …]`;
    } else {
      container.textContent = "No embedding stored";
    }
  } catch (e) {
    container.textContent = `Error: ${e}`;
  }
}

export function renderRelatedItemsSection(
  heading: string,
  results: SearchEntryResultLike[],
  options: {
    revealSecrets?: boolean;
  } = {},
): string {
  if (results.length === 0) {
    return `
      <section class="related-items-section">
        <div class="related-items-header">${escapeHtml(heading)}</div>
        <p class="hint related-items-empty">No related items yet.</p>
      </section>
    `;
  }

  const items = results.map((result) => {
    const normalizedResult = normalizeSearchEntryResult(result);
    const preview = buildDisplayEntryPreview(normalizedResult.entry, {
      revealSecrets: options.revealSecrets,
    });
    const explanation = renderSearchExplanation(normalizedResult);
    return `
      <button class="related-item-card" type="button" data-entry-id="${escapeHtml(normalizedResult.entry.id)}">
        <div class="related-item-top">
          <span class="hint">${escapeHtml(explanation)}</span>
        </div>
        <div class="related-item-preview">${preview}</div>
      </button>
    `;
  }).join("");

  return `
    <section class="related-items-section">
      <div class="related-items-header">${escapeHtml(heading)}</div>
      <div class="related-items-list">${items}</div>
    </section>
  `;
}
