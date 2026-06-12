import { describe, expect, test } from "vitest";
import { buildStatusBarChips } from "../src/main/status-bar";
import type { Settings } from "../src/settings";
import type { EntryRow, SearchEntryResult } from "../src/store";

const baseSettings: Settings = {
  clipboardMonitoring: true,
  providers: {
    openai: { apiKey: "", modelCache: null },
    gemini: { apiKey: "", modelCache: null },
    ollama: { baseUrl: "http://localhost:11434" },
  },
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
  ranking: {
    shortKeywordWeight: 1.35,
    shortSemanticWeight: 2,
    mediumKeywordWeight: 1.15,
    mediumSemanticWeight: 2.85,
    longKeywordWeight: 1,
    longSemanticWeight: 2,
    semanticRelevanceThreshold: 0.385,
    recencyBoostMax: 0.02,
    rrfK: 10,
  },
  enrichmentSummaryEnabled: false,
  enrichmentTaggingEnabled: false,
  enrichmentProvider: "none",
  enrichmentModel: "gpt-4o-mini",
  debugLoggingEnabled: false,
  trufflehogPath: "",
  secretMaskerEnabled: true,
  shortcutOverrides: {},
};

const baseEntry: EntryRow = {
  id: "entry-1",
  content: "Entry",
  html_content: null,
  source: "clipboard",
  source_app: "Slack",
  created_at: 0,
  pinned: false,
  label: "code",
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

function makeResult(overrides: Partial<SearchEntryResult> = {}): SearchEntryResult {
  return {
    entry: baseEntry,
    rank: 1,
    match_type: "hybrid",
    match_reasons: ["keyword", "semantic"],
    matched_terms: ["entry"],
    matched_tags: [],
    diagnostics: {
      query_text: "entry",
      fts_query: "entry*",
      applied_filters: ["is_note:false"],
      bm25: 0.3,
      search_mode: "hybrid",
      cosine_similarity: 0.92,
      semantic_fallback_reason: null,
      keyword_rank: 1,
      semantic_rank: 1,
      keyword_weight: 1.15,
      semantic_weight: 2.85,
      keyword_rrf_score: 0.02,
      semantic_rrf_score: 0.03,
      recency_max_boost: 0.02,
      rrf_k: 10,
      recency_boost: 0.01,
      fused_score: 0.06,
    },
    ...overrides,
  };
}

describe("status bar meta", () => {
  test("summarizes embedding mode, manual badges, auto badges, and build", () => {
    const entries: EntryRow[] = [
      {
        ...baseEntry,
        id: "entry-1",
        label: "code",
        manual_badges: JSON.stringify([
          { name: "Urgent", color: "red" },
          { name: "Work", color: "blue" },
        ]),
      },
      {
        ...baseEntry,
        id: "entry-2",
        source: "manual",
        source_app: "Chrome",
        label: "other",
        manual_badges: JSON.stringify([
          { name: "work", color: "green" },
          { name: "Idea", color: "default" },
        ]),
      },
    ];

    const chips = buildStatusBarChips({
      entries,
      query: "entry",
      results: [makeResult()],
      settings: baseSettings,
    });

    expect(chips).toEqual([
      { label: "embed", value: "openai:text-embedding-3-small" },
      { label: "badges", value: "4 badges" },
      { label: "build", value: "v0.1.0" },
    ]);
  });

  test("shows embedding off when embeddings are disabled", () => {
    const chips = buildStatusBarChips({
      entries: [baseEntry],
      query: "entry",
      results: [
        makeResult({
          diagnostics: {
            ...makeResult().diagnostics,
            search_mode: "keyword",
            semantic_fallback_reason: "missing_query_embedding",
          },
        }),
      ],
      settings: {
        ...baseSettings,
        embeddingProvider: "none",
      },
    });

    expect(chips[0]).toEqual({ label: "embed", value: "off" });
    expect(chips[1]).toEqual({ label: "badges", value: "1 badge" });
  });
});
