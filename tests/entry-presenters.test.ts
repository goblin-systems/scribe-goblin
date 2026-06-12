import { describe, expect, test } from "vitest";
import {
  buildDisplayEntryPreview,
  buildEntryPreview,
  buildMaskedSecretPreview,
  buildSearchHighlightedPreview,
  renderEntryBadges,
  renderEntryDetailText,
  renderProcessingDiagnosticsSection,
  renderSearchDebugContext,
  renderSearchDebugSection,
  renderSearchDiagnostics,
  renderSearchDebugSummary,
  renderSearchExplanation,
} from "../src/main/entry-presenters";
import {
  normalizeSearchEntryResult,
  normalizeSearchEntryResults,
} from "../src/store";
import type {
  EntryRow,
  SearchDiagnostics,
  SearchEntryResult,
  SearchEntryResultPayload,
} from "../src/store";

const baseEntry: EntryRow = {
  id: "entry-1",
  content: "Clipboard entry",
  html_content: null,
  source: "clipboard",
  source_app: null,
  created_at: 0,
  pinned: false,
  label: null,
  label_score: null,
  summary: null,
  tags_json: null,
  enrichment_tags: null,
  processing_diagnostics: null,
  manual_badges: null,
  secret_verdict: null,
  secret_type: null,
  secret_source: null,
  collection_id: null,
  checklist_completed: false,
  is_note: false,
  import_origin: null,
  import_name: null,
  content_type: null,
  attachment_rel_path: null,
  attachment_size_bytes: null,
  attachment_sha256: null,
  collection_sort_order: null,
};

const baseDiagnostics: SearchDiagnostics = {
  query_text: "clipboard",
  fts_query: "clipboard*",
  applied_filters: [],
  bm25: null,
  search_mode: "keyword",
  cosine_similarity: null,
  semantic_fallback_reason: null,
  keyword_rank: 1,
  keyword_weight: null,
  semantic_weight: null,
  keyword_rrf_score: null,
  semantic_rrf_score: null,
  recency_max_boost: null,
  rrf_k: null,
  semantic_rank: null,
  recency_boost: null,
  fused_score: null,
};

function makeResult(overrides: Partial<SearchEntryResult> = {}): SearchEntryResult {
  return {
    entry: baseEntry,
    rank: 1,
    match_type: "keyword",
    match_reasons: ["keyword"],
    matched_terms: ["clipboard"],
    matched_tags: ["debug"],
    diagnostics: baseDiagnostics,
    ...overrides,
  };
}

describe("entry presenters debug search instrumentation", () => {
  test("masks secret list previews using the same preview basis", () => {
    const importEntry: EntryRow = {
      ...baseEntry,
      import_name: "Quarterly Secrets Export.txt",
      content: "short",
    };

    expect(buildEntryPreview(importEntry)).toBe("Quarterly Secrets Export.txt");
    expect(buildMaskedSecretPreview(importEntry)).toBe("••••••••••••••••••••••••••••");
  });

  test("highlights exact lexical preview matches", () => {
    const entry: EntryRow = {
      ...baseEntry,
      content: "Clipboard entry with clipboard match",
    };

    expect(buildSearchHighlightedPreview(entry, makeResult())).toBe(
      '<mark class="search-highlight">Clipboard</mark> entry with <mark class="search-highlight">clipboard</mark> match',
    );
  });

  test("highlights prefix lexical matches in detail content", () => {
    const entry: EntryRow = {
      ...baseEntry,
      content: "Improvement work improves outcomes.",
    };

    const result = makeResult({ matched_terms: ["improv"] });
    expect(renderEntryDetailText(entry, result)).toBe(
      '<mark class="search-highlight">Improv</mark>ement work <mark class="search-highlight">improv</mark>es outcomes.',
    );
  });

  test("highlights fuzzy matches using backend matched terms", () => {
    const entry: EntryRow = {
      ...baseEntry,
      content: "The improvement landed yesterday.",
    };

    const result = makeResult({ matched_terms: ["improvemnt:improvement"] });
    expect(renderEntryDetailText(entry, result)).toBe(
      'The <mark class="search-highlight">improvement</mark> landed yesterday.',
    );
  });

  test("does not highlight semantic-only matches", () => {
    const entry: EntryRow = {
      ...baseEntry,
      content: "Clipboard entry",
    };

    const result = makeResult({
      match_reasons: ["semantic"],
      matched_terms: ["clipboard"],
    });

    expect(buildSearchHighlightedPreview(entry, result)).toBe("Clipboard entry");
  });

  test("keeps masked secret previews unhighlighted", () => {
    const entry: EntryRow = {
      ...baseEntry,
      content: "Clipboard token 123",
      secret_verdict: "secret",
    };

    const highlighted = buildSearchHighlightedPreview(entry, makeResult(), { revealSecrets: false });
    expect(highlighted).toBe(buildMaskedSecretPreview(entry));
    expect(highlighted).not.toContain("search-highlight");
    expect(buildDisplayEntryPreview(entry, { revealSecrets: false })).toBe(buildMaskedSecretPreview(entry));
  });

  test("normalizes camelCase search payloads at the frontend boundary", () => {
    const camelCasePayload: SearchEntryResultPayload = {
      entry: baseEntry,
      rank: 4.25,
      matchType: "hybrid",
      matchReasons: ["keyword", "semantic", "recent"],
      matchedTerms: ["clipboard", "debug"],
      matchedTags: ["search"],
      diagnostics: {
        queryText: "clipboard debug",
        ftsQuery: '"clipboard" AND "debug"',
        appliedFilters: ["is_note:false", "tag:search"],
        bm25: 0.42,
        searchMode: "hybrid",
        cosineSimilarity: 0.991,
        semanticFallbackReason: "missing_query_embedding",
        keywordRank: 2,
        semanticRank: 1,
        keywordWeight: 1.15,
        semanticWeight: 0.85,
        keywordRrfScore: 0.0188,
        semanticRrfScore: 0.0139,
        recencyMaxBoost: 0.05,
        rrfK: 60,
        recencyBoost: 0.045,
        fusedScore: 0.0777,
      },
    };

    const normalized = normalizeSearchEntryResult(camelCasePayload);

    expect(normalized.match_type).toBe("hybrid");
    expect(normalized.match_reasons).toEqual(["keyword", "semantic", "recent"]);
    expect(normalized.matched_terms).toEqual(["clipboard", "debug"]);
    expect(normalized.matched_tags).toEqual(["search"]);
    expect(normalized.diagnostics.search_mode).toBe("hybrid");
    expect(normalized.diagnostics.query_text).toBe("clipboard debug");
    expect(normalized.diagnostics.fts_query).toBe('"clipboard" AND "debug"');
    expect(normalized.diagnostics.applied_filters).toEqual(["is_note:false", "tag:search"]);
    expect(normalized.diagnostics.keyword_rank).toBe(2);
    expect(normalized.diagnostics.semantic_rank).toBe(1);
    expect(normalized.diagnostics.keyword_weight).toBe(1.15);
    expect(normalized.diagnostics.semantic_weight).toBe(0.85);
    expect(normalized.diagnostics.keyword_rrf_score).toBe(0.0188);
    expect(normalized.diagnostics.semantic_rrf_score).toBe(0.0139);
    expect(normalized.diagnostics.recency_max_boost).toBe(0.05);
    expect(normalized.diagnostics.rrf_k).toBe(60);
    expect(normalized.diagnostics.fused_score).toBe(0.0777);
    expect(normalized.diagnostics.bm25).toBe(0.42);
    expect(normalized.diagnostics.cosine_similarity).toBe(0.991);
    expect(normalized.diagnostics.recency_boost).toBe(0.045);
    expect(normalized.diagnostics.semantic_fallback_reason).toBe("missing_query_embedding");
  });

  test("renders camelCase payloads the same as snake_case payloads", () => {
    const camelCasePayload = {
      entry: baseEntry,
      rank: 7,
      matchType: "hybrid",
      matchReasons: ["keyword", "semantic", "recent"],
      matchedTerms: ["clipboard", "debug"],
      matchedTags: ["search"],
      diagnostics: {
        queryText: "clipboard debug",
        ftsQuery: '"clipboard" AND "debug"',
        appliedFilters: ["source_app:raycast", "tag:search"],
        bm25: 0.42,
        searchMode: "hybrid",
        cosineSimilarity: 0.991,
        semanticFallbackReason: "missing_query_embedding",
        keywordRank: 2,
        semanticRank: 1,
        keywordWeight: 1.15,
        semanticWeight: 0.85,
        keywordRrfScore: 0.0188,
        semanticRrfScore: 0.0139,
        recencyMaxBoost: 0.05,
        rrfK: 60,
        recencyBoost: 0.045,
        fusedScore: 0.0777,
      },
    } as const;

    expect(renderSearchExplanation(camelCasePayload)).toBe("keyword | semantic | recent | tag:search | clipboard | debug");
    expect(renderSearchDiagnostics(camelCasePayload)).toBe("hybrid | kw #2 | sem #1 | short weights | cos 0.991 | bm25 0.420 | recency +0.045 | fallback missing_query_embedding");
    expect(renderSearchDebugSummary(camelCasePayload)).toBe("rank #7 | hybrid | mode hybrid | kw #2 | sem #1 | short weights | fused 0.078 | bm25 0.420 | cos 0.991");
    expect(renderSearchDebugContext(camelCasePayload)).toBe("terms clipboard, debug | tags search | filters source_app:raycast, tag:search | fallback missing_query_embedding");

    const debugSection = renderSearchDebugSection(camelCasePayload);
    expect(debugSection).toContain("Match type");
    expect(debugSection).toContain("hybrid");
    expect(debugSection).toContain("keyword, semantic, recent");
    expect(debugSection).toContain("clipboard, debug");
    expect(debugSection).toContain("search");
    expect(debugSection).toContain('source_app:raycast, tag:search');
    expect(debugSection).toContain('&quot;clipboard&quot; AND &quot;debug&quot;');
    expect(debugSection).toContain("missing_query_embedding");
    expect(debugSection).toContain("Keyword weight");
    expect(debugSection).toContain("Semantic weight");
    expect(debugSection).toContain("Weight bucket");
    expect(debugSection).toContain("Formula");
    expect(debugSection).toContain("RRF k");
    expect(debugSection).toContain("Keyword RRF");
    expect(debugSection).toContain("Semantic RRF");
    expect(debugSection).toContain("Recency max");
    expect(debugSection).toContain("kw_rrf=0.0188 + sem_rrf=0.0139 + recency=0.0450 =&gt; fused=0.0777");
  });

  test("normalizes mixed payload arrays defensively", () => {
    const mixedResults = normalizeSearchEntryResults([
      {
        entry: baseEntry,
        rank: 1,
        matchType: "keyword",
        matchReasons: ["keyword"],
        matchedTerms: ["clipboard"],
        matchedTags: ["debug"],
        diagnostics: { searchMode: "keyword" },
      },
      makeResult(),
    ]);

    expect(mixedResults).toHaveLength(2);
    expect(mixedResults[0].match_type).toBe("keyword");
    expect(mixedResults[0].diagnostics.search_mode).toBe("keyword");
    expect(mixedResults[1].match_type).toBe("keyword");
  });

  test("handles missing search metadata arrays without crashing", () => {
    const malformedResult = {
      ...makeResult(),
      match_reasons: undefined,
      matched_terms: undefined,
      matched_tags: undefined,
      diagnostics: {
        ...baseDiagnostics,
        applied_filters: undefined,
        semantic_fallback_reason: "no embedding",
      },
    } as unknown as SearchEntryResult;

    expect(renderSearchExplanation(malformedResult)).toBe("matched by filters");
    expect(renderSearchDiagnostics(malformedResult)).toBe("keyword | kw #1 | short weights | fallback no embedding");
    expect(renderSearchDebugContext(malformedResult)).toBe("fallback no embedding");

    const debugSection = renderSearchDebugSection(malformedResult);
    expect(debugSection).toContain("Search debug");
    expect(debugSection).toContain("Applied filters");
    expect(debugSection).toContain("Matched terms");
    expect(debugSection).toContain("Matched tags");
    expect(debugSection).toContain("Semantic fallback");
    expect(debugSection).toContain("no embedding");
    expect(debugSection).toContain("—");
  });

  test("keeps useful explanation text when only some arrays are missing", () => {
    const partialResult = {
      ...makeResult({
        matched_terms: undefined as unknown as string[],
        matched_tags: undefined as unknown as string[],
      }),
      diagnostics: {
        ...baseDiagnostics,
        applied_filters: undefined,
      },
    } as unknown as SearchEntryResult;

    expect(renderSearchExplanation(partialResult)).toBe("keyword");
    expect(renderSearchDebugContext(partialResult)).toBe("");
  });

  test("gracefully handles missing scalar debug metadata", () => {
    const malformedResult = {
      ...makeResult({
        match_type: undefined as unknown as string,
        matched_terms: undefined as unknown as string[],
        matched_tags: undefined as unknown as string[],
      }),
      diagnostics: {
        ...baseDiagnostics,
        query_text: undefined,
        fts_query: undefined,
        search_mode: undefined,
        semantic_fallback_reason: undefined,
      },
    } as unknown as SearchEntryResult;

    expect(renderSearchDiagnostics(malformedResult)).toBe("kw #1");
    expect(renderSearchDebugContext(malformedResult)).toBe("");
    expect(renderSearchDebugSummary(malformedResult)).toBe("rank #1 | unknown | kw #1");

    const debugSection = renderSearchDebugSection(malformedResult);
    expect(debugSection).toContain("Match type");
    expect(debugSection).toContain("unknown");
    expect(debugSection).toContain("Query");
    expect(debugSection).toContain("FTS query");
    expect(debugSection).toContain("Search mode");
    expect(debugSection).toContain("Semantic fallback");
    expect(debugSection).toContain("—");
  });

  test("renders processing diagnostics without exposing raw secret spans", () => {
    const entry: EntryRow = {
      ...baseEntry,
      processing_diagnostics: JSON.stringify({
        version: 2,
        heuristic: {
          status: "completed",
          matches: [
            { label: "url", reason: "obvious_url" },
          ],
          error: null,
        },
        enrichment: {
          status: "fallback",
          provider: "local-heuristic",
          model: null,
          summary_present: true,
          tags_returned: ["url", "api"],
          source: "heuristic",
          reason: "provider_not_configured",
          error: null,
        },
        secret_detection: {
          final_verdict: "likely_secret",
          final_type: "token",
          final_source: "secret_masker",
          trufflehog: {
            status: "no_match",
            enabled: true,
            available: true,
            matched: false,
            verified: null,
            detector: null,
            model: null,
            top_score: null,
            span_count: null,
          },
          secret_masker: {
            status: "matched",
            enabled: true,
            matched: true,
            verified: null,
            detector: null,
            model: "distilbert-secret-masker",
            top_score: 0.88,
            span_count: 1,
          },
        },
      }),
    };

    const html = renderProcessingDiagnosticsSection(entry);
    expect(html).toContain("Tagging debug");
    expect(html).toContain("url (obvious_url)");
    expect(html).toContain("provider_not_configured");
    expect(html).toContain("distilbert-secret-masker");
    expect(html).not.toContain("sk-abc");
    expect(html).not.toContain("start");
  });

  test("colors heuristic, trufflehog, and AI enrichment badges by origin", () => {
    const entry: EntryRow = {
      ...baseEntry,
      tags_json: JSON.stringify([
        {
          id: "tag-heuristic",
          name: "url",
          source: "heuristic",
          kind: "classification",
          created_at: 0,
          confidence: 0.98,
          provider: "local-heuristic",
          model: null,
          color: null,
        },
        {
          id: "tag-ai-1",
          name: "api",
          source: "ai",
          kind: "enrichment",
          created_at: 0,
          confidence: null,
          provider: "openai",
          model: "gpt-4o-mini",
          color: null,
        },
        {
          id: "tag-ai-2",
          name: "auth",
          source: "ai",
          kind: "enrichment",
          created_at: 0,
          confidence: null,
          provider: "openai",
          model: "gpt-4o-mini",
          color: null,
        },
        {
          id: "tag-trufflehog",
          name: "aws",
          source: "trufflehog",
          kind: "detector",
          created_at: 0,
          confidence: null,
          provider: "trufflehog",
          model: null,
          color: null,
        },
      ]),
      processing_diagnostics: JSON.stringify({
        version: 2,
        heuristic: {
          status: "completed",
          matches: [
            { label: "url", reason: "obvious_url" },
          ],
          error: null,
        },
        enrichment: {
          status: "completed",
          provider: "openai",
          model: "gpt-4o-mini",
          summary_present: false,
          tags_returned: ["api", "auth"],
          source: "provider",
          reason: null,
          error: null,
        },
        secret_detection: {
          final_verdict: "likely_secret",
          final_type: "token",
          final_source: "trufflehog",
          trufflehog: {
            status: "matched",
            enabled: true,
            available: true,
            matched: true,
            verified: true,
            detector: "aws",
            model: null,
            top_score: null,
            span_count: null,
          },
          secret_masker: {
            status: "skipped",
            enabled: true,
            matched: false,
            verified: null,
            detector: null,
            model: null,
            top_score: null,
            span_count: null,
          },
        },
      }),
    };

    const html = renderEntryBadges(entry);
    expect(html).toContain('class="badge beta"');
    expect(html).toContain('class="badge ai"');
    expect(html).toContain('class="badge error"');
    expect(html).toContain("aws");
  });
});
