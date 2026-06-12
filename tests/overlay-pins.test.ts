import { describe, expect, test } from "vitest";
import { sortPinnedOverlayEntries } from "../src/overlay-pins";
import type { EntryRow } from "../src/store";

function entry(id: string, pinned: boolean): EntryRow {
  return {
    id,
    content: id,
    html_content: null,
    source: "clipboard",
    source_app: null,
    created_at: Number(id.replace(/\D/g, "")) || 0,
    pinned,
    label: null,
    label_score: null,
    summary: null,
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

describe("sortPinnedOverlayEntries", () => {
  test("floats pinned clips while preserving existing ranking inside each group", () => {
    const sorted = sortPinnedOverlayEntries([
      entry("recent-unpinned", false),
      entry("first-pinned", true),
      entry("older-unpinned", false),
      entry("second-pinned", true),
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      "first-pinned",
      "second-pinned",
      "recent-unpinned",
      "older-unpinned",
    ]);
  });
});
