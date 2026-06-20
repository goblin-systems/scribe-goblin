import { describe, expect, test } from "vitest";
import {
  getGarbageCandidates,
  getGarbageTagReason,
} from "../src/main/garbage-collection-controller";
import type { EntryRow, EntryTagRecord } from "../src/store";

function entry(id: string, content: string, tags: EntryTagRecord[] = []): EntryRow {
  return {
    id,
    content,
    html_content: null,
    source: "clipboard",
    source_app: null,
    created_at: 1,
    pinned: false,
    label: null,
    label_score: null,
    summary: null,
    tags_json: tags.length > 0 ? JSON.stringify(tags) : null,
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
}

function tag(overrides: Partial<EntryTagRecord> = {}): EntryTagRecord {
  return {
    id: "tag-1",
    name: "garbage",
    source: "ai",
    kind: "enrichment",
    created_at: 1,
    confidence: null,
    provider: "local-qwen",
    model: "temporary UI text",
    color: "red",
    ...overrides,
  };
}

describe("garbage collection precomputed tags", () => {
  test("reads AI garbage tag reason from generated tags", () => {
    expect(getGarbageTagReason(entry("a", "Copied!", [tag()]))).toBe("temporary UI text");
  });

  test("ignores non-AI or non-enrichment garbage tags", () => {
    expect(getGarbageTagReason(entry("a", "Copied!", [tag({ source: "manual" })]))).toBeNull();
    expect(getGarbageTagReason(entry("b", "Copied!", [tag({ kind: "manual" })]))).toBeNull();
  });

  test("returns only clipboard entries with precomputed garbage tags", () => {
    const garbage = entry("a", "Copied!", [tag()]);
    const useful = entry("b", "https://example.com");
    const note = entry("c", "note", [tag()]);
    note.is_note = true;

    const candidates = getGarbageCandidates([garbage, useful, note]);

    expect(candidates.map((candidate) => candidate.entry.id)).toEqual(["a"]);
    expect(candidates[0].reason).toBe("temporary UI text");
  });
});
