import { describe, test, expect, beforeAll } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { addEntry } from "../src/main/entries-controller";
import type { EntryRow } from "../src/store";

// Mock the DOM elements used in entries-controller
const mockDom = {
  searchInput: { value: "" },
  entriesList: { 
    innerHTML: "", 
    appendChild: () => {},
    querySelectorAll: () => [] 
  },
  entriesEmpty: { hidden: false },
  entryDetail: { hidden: true },
  entryDetailContent: { textContent: "" },
  entryDetailMeta: { innerHTML: "" },
  entryDetailDelete: { dataset: { id: "" } },
} as any;

describe("Database Integration", () => {
  beforeAll(async () => {
    // Note: in setup.ts we don't actually mock db_init, 
    // so we need to ensure our setup.ts mock can handle these.
  });

  test("should add and retrieve a plain text entry", async () => {
    const content = "Test plain text entry " + Date.now();
    const id = await invoke<string>("db_add_entry", {
      content,
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now()
    });
    
    expect(typeof id).toBe("string");

    const entries = await invoke<EntryRow[]>("db_list_entries", { search: content, limit: 1 });
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe(content);
    expect(entries[0].html_content).toBeNull();
  });

  test("should add and retrieve a rich text entry", async () => {
    const content = "Test rich text";
    const htmlContent = "<b>Test rich text</b>";
    const id = await invoke<string>("db_add_entry", {
      content,
      htmlContent,
      source: "clipboard",
      sourceApp: null,
      createdAt: Date.now()
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", { search: content, limit: 1 });
    expect(entries.length).toBe(1);
    expect(entries[0].html_content).toBe(htmlContent);
  });

  test("should update entry with classification", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Classification test",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now()
    });

    const embedding = JSON.stringify([0.1, 0.2, 0.3]);
    await invoke("db_update_entry_classification", {
      id,
      label: "code",
      labelScore: 0.95,
      embedding
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", { search: "Classification test", limit: 1 });
    expect(entries[0].label).toBe("code");
    expect(entries[0].label_score).toBe(0.95);
    expect(entries[0].embedding).toBe(embedding);
  });

  test("should classify text", async () => {
    const result = await invoke<{ label: string; label_score: number; embedding: number[] }>(
      "classify_text",
      { text: "some test text" }
    );

    expect(result.label).toBe("other");
    expect(result.label_score).toBe(0.5);
    expect(Array.isArray(result.embedding)).toBe(true);
    expect(result.embedding.length).toBe(384);
  });

  test("should retrieve entries with embeddings", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Embeddings retrieval test",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now()
    });

    const embedding = JSON.stringify([0.4, 0.5, 0.6]);
    await invoke("db_update_entry_classification", {
      id,
      label: "note",
      labelScore: 0.8,
      embedding
    });

    const withEmbeddings = await invoke<EntryRow[]>("db_get_embeddings");
    const match = withEmbeddings.find(e => e.id === id);
    expect(match).toBeDefined();
    expect(match!.embedding).toBe(embedding);
    expect(match!.label).toBe("note");
  });
});
