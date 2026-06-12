import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { EntryRow, SearchEntryResult } from "../src/store";
import { invokeMock } from "./setup";

const enrichEntryMock = vi.hoisted(() => vi.fn());
const summarizeEntryMock = vi.hoisted(() => vi.fn());
const scanMock = vi.hoisted(() => vi.fn());

vi.mock("@goblin-systems/goblin-design-system", () => ({
  applyIcons: vi.fn(),
  bindContextMenu: vi.fn(),
  showToast: vi.fn(),
  closeModal: vi.fn(),
  openModal: vi.fn(),
}));

vi.mock("../src/enrichment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/enrichment")>();
  return {
    ...actual,
    enrichEntry: enrichEntryMock,
    summarizeEntry: summarizeEntryMock,
  };
});

vi.mock("../src/secret-detection/index", () => ({
  scan: scanMock,
}));

import {
  initCollectionController,
  normalizeEnrichmentSummary,
  parseCollectionSearchInput,
  processNoteBackground,
  serializeEnrichmentTags,
  setActiveCollection,
} from "../src/main/collection-controller";
import { parseClipboardSearchInput } from "../src/main/clipboard-controller";
import { getDefaultSettings, type Settings } from "../src/settings";
import { normalizeEnrichmentResult } from "../src/enrichment";

// Mock the DOM elements used in notes-controller
const mockDom = {
  searchInput: { value: "", placeholder: "" },
  notesList: {
    innerHTML: "",
    dataset: {},
    appendChild: () => {},
    replaceChildren: () => {},
    querySelectorAll: () => [],
    addEventListener: () => {},
  },
  notesEmpty: { hidden: false },
  noteDetail: { hidden: true },
  noteDetailContent: { textContent: "" },
  noteDetailMeta: { innerHTML: "", addEventListener: () => {} },
  noteDetailDelete: { dataset: { id: "" } },
  noteDetailPlaceholder: { hidden: true },
  notesBadgeFilterBtn: { addEventListener: () => {} },
  addBadgeInput: { value: "", addEventListener: () => {}, focus: () => {} },
  addBadgeModal: {},
  addBadgeConfirmBtn: { addEventListener: () => {} },
  searchClearBtn: { hidden: false },
  notesStatusLeft: { textContent: "" },
  notesStatusMeta: { replaceChildren: () => {} },
  noteDetailRelated: { innerHTML: "", querySelectorAll: () => [] },
  noteDetailDebug: { innerHTML: "" },
  noteDetailSecretActions: { hidden: true, innerHTML: "" },
} as any;

class FakeClassList {
  private tokens = new Set<string>();

  add(...names: string[]): void {
    names.forEach((name) => this.tokens.add(name));
  }

  remove(...names: string[]): void {
    names.forEach((name) => this.tokens.delete(name));
  }
}

class FakeElement {
  children: any[] = [];
  dataset: Record<string, string> = {};
  className = "";
  classList = new FakeClassList();
  hidden = false;
  innerHTML = "";
  textContent = "";
  value = "";
  placeholder = "";
  title = "";
  type = "";
  innerText = "";
  private listeners = new Map<string, Array<(event?: any) => void>>();
  private graphFocusButton: FakeElement | null = null;
  private graphFilterButton: FakeElement | null = null;

  appendChild(child: any): any {
    this.children.push(child);
    return child;
  }

  append(...children: any[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: any[]): void {
    this.children = [...children];
  }

  addEventListener(type: string, listener: (event?: any) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(): void {}

  querySelectorAll(): any[] {
    return [];
  }

  querySelector(selector: string): any {
    if (selector === '[data-color="default"]') {
      return this.children.find((child) => child?.dataset?.color === "default") ?? null;
    }
    if (selector === "[data-graph-focus-entry-id]") {
      if (this.graphFocusButton) return this.graphFocusButton;
      const match = /data-graph-focus-entry-id="([^"]+)"/.exec(this.innerHTML);
      if (!match) return null;
      const button = new FakeElement();
      button.dataset.graphFocusEntryId = match[1] ?? "";
      this.graphFocusButton = button;
      return button;
    }
    if (selector === "[data-graph-filter-entry-id]") {
      if (this.graphFilterButton) return this.graphFilterButton;
      const match = /data-graph-filter-entry-id="([^"]+)"/.exec(this.innerHTML);
      if (!match) return null;
      const button = new FakeElement();
      button.dataset.graphFilterEntryId = match[1] ?? "";
      this.graphFilterButton = button;
      return button;
    }
    return null;
  }

  setAttribute(name: string, value: string): void {
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5)] = value;
    }
  }

  focus(): void {}

  closest(): null {
    return null;
  }

  dispatch(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createFakeDocument() {
  const byId = new Map<string, any>();
  return {
    __byId: byId,
    body: new FakeElement(),
    hidden: false,
    createElement: () => new FakeElement(),
    getElementById: (id: string) => byId.get(id) ?? null,
    addEventListener: () => {},
    removeEventListener: () => {},
    elementFromPoint: () => null,
  };
}

function buildSettings(overrides: Partial<Settings> = {}): Settings {
  const defaults = getDefaultSettings();
  return {
    ...defaults,
    ...overrides,
    providers: {
      ...defaults.providers,
      ...overrides.providers,
      openai: {
        ...defaults.providers.openai,
        ...overrides.providers?.openai,
      },
      gemini: {
        ...defaults.providers.gemini,
        ...overrides.providers?.gemini,
      },
      ollama: {
        ...defaults.providers.ollama,
        ...overrides.providers?.ollama,
      },
    },
    ranking: {
      ...defaults.ranking,
      ...overrides.ranking,
    },
  };
}

describe("Database Integration", () => {
  let originalWindow: typeof globalThis.window | undefined;
  let originalDocument: typeof globalThis.document | undefined;

  beforeAll(async () => {
    // Note: in setup.ts we don't actually mock db_init,
    // so we need to ensure our setup.ts mock can handle these.
  });

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    enrichEntryMock.mockReset();
    summarizeEntryMock.mockReset();
    scanMock.mockReset();

    const fakeDocument = createFakeDocument();
    const addBadgeColors = new FakeElement();
    const defaultColor = new FakeElement();
    defaultColor.dataset.color = "default";
    addBadgeColors.children.push(defaultColor);
    fakeDocument.__byId.set("add-badge-colors", addBadgeColors);

    Object.defineProperty(globalThis, "document", {
      value: fakeDocument,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        addEventListener: () => {},
        removeEventListener: () => {},
        setTimeout,
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  });

  async function resetState(): Promise<void> {
    await invoke("__reset_test_state__", {});
  }

  test("should add and retrieve a plain text entry", async () => {
    const content = "Test plain text entry " + Date.now();
    const id = await invoke<string>("db_add_entry", {
      content,
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });

    expect(typeof id).toBe("string");

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: content,
      limit: 1,
    });
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
      createdAt: Date.now(),
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: content,
      limit: 1,
    });
    expect(entries.length).toBe(1);
    expect(entries[0].html_content).toBe(htmlContent);
  });

  test("should float pinned clipboard entries above newer unpinned entries", async () => {
    const olderId = await invoke<string>("db_add_entry", {
      content: "older pinned",
      htmlContent: null,
      source: "clipboard",
      sourceApp: null,
      createdAt: 1,
    });
    const newerId = await invoke<string>("db_add_entry", {
      content: "newer unpinned",
      htmlContent: null,
      source: "clipboard",
      sourceApp: null,
      createdAt: 2,
    });

    await invoke("db_set_entry_pinned", { id: olderId, pinned: true });

    let entries = await invoke<EntryRow[]>("db_list_entries", {
      search: null,
      limit: 10,
    });

    expect(entries.map((entry) => entry.id)).toEqual([olderId, newerId]);
    expect(entries[0].pinned).toBe(true);

    await invoke("db_set_entry_pinned", { id: olderId, pinned: false });
    entries = await invoke<EntryRow[]>("db_list_entries", {
      search: null,
      limit: 10,
    });

    expect(entries.map((entry) => entry.id)).toEqual([newerId, olderId]);
  });

  test("should update entry with classification", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Classification test",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });

    const embedding = JSON.stringify([0.1, 0.2, 0.3]);
    await invoke("db_update_entry_classification", {
      id,
      label: "code",
      labelScore: 0.95,
      embedding,
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Classification test",
      limit: 1,
    });
    expect(entries[0].label).toBe("code");
    expect(entries[0].label_score).toBe(0.95);
    // embedding is now stored in vec_entries, not on EntryRow
  });

  test("should persist enrichment summary and tags via entry reads", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Enrichment persistence test",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });

    await invoke("db_update_entry_enrichment", {
      id,
      summary: "Short generated summary",
      enrichmentTags: JSON.stringify(["alpha", "beta-tag"]),
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Enrichment persistence test",
      limit: 10,
    });
    const match = entries.find((entry) => entry.id === id);

    expect(match?.summary).toBe("Short generated summary");
    expect(match?.enrichment_tags).toBe(
      JSON.stringify(["alpha", "beta-tag"]),
    );
  });

  test("should keep enrichment fields nullable by default", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Enrichment default null test",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Enrichment default null test",
      limit: 10,
    });
    const match = entries.find((entry) => entry.id === id);

    expect(match?.summary).toBeNull();
    expect(match?.enrichment_tags).toBeNull();
  });

  test("processNoteBackground should persist enrichment when enabled and configured", async () => {
    let currentSettings = buildSettings({
      enrichmentSummaryEnabled: true,
      enrichmentTaggingEnabled: true,
      enrichmentProvider: "openai",
      providers: {
        openai: { apiKey: "test-key" },
      } as Settings["providers"],
    });

    enrichEntryMock.mockResolvedValue({
      tags: ["alpha", " beta ", ""],
    });
    summarizeEntryMock.mockResolvedValue({
      summary: "  Useful summary  ",
      tags: [],
    });
    scanMock.mockResolvedValue({
      verdict: "not_secret",
      source: "both",
      secret_type: "unknown",
      confidence: 1,
      reason: "none",
      evidence: {},
      diagnostics: {
        trufflehog: {
          available: true,
          matched: false,
          verified: null,
          detector: null,
          status: "no_match",
        },
        secret_masker: {
          enabled: true,
          matched: false,
          model: "distilbert-secret-masker",
          top_score: 0,
          span_count: 0,
          status: "no_match",
        },
      },
    });

    initCollectionController(mockDom, () => currentSettings, {
      getCollections: () => [
        {
          id: "notes",
          slug: "notes",
          name: "Notes",
          icon: null,
          collection_type: "standard",
          kind: "system",
          sort_order: 0,
          created_at: 0,
          updated_at: 0,
        },
      ],
      requestCreateCollection: async () => null,
      refreshCollections: async () => {},
    });
    await setActiveCollection("notes");

    const longContent = "background text ".repeat(24);

    await processNoteBackground("mock-1", longContent);

    expect(enrichEntryMock).toHaveBeenCalledWith(longContent, currentSettings);
    expect(summarizeEntryMock).toHaveBeenCalledWith(longContent, currentSettings);
    expect(invokeMock).toHaveBeenCalledWith(
      "db_update_entry_enrichment",
      expect.objectContaining({
        id: "mock-1",
        summary: "Useful summary",
        enrichmentTags: JSON.stringify(["alpha", "beta"]),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "db_update_entry_processing_diagnostics",
      expect.objectContaining({ id: "mock-1" }),
    );
  });

  test("processNoteBackground should skip enrichment persistence when disabled or unconfigured", async () => {
    let currentSettings = buildSettings();

    scanMock.mockResolvedValue({
      verdict: "not_secret",
      source: "both",
      secret_type: "unknown",
      confidence: 1,
      reason: "none",
      evidence: {},
      diagnostics: {
        trufflehog: {
          available: true,
          matched: false,
          verified: null,
          detector: null,
          status: "no_match",
        },
        secret_masker: {
          enabled: true,
          matched: false,
          model: "distilbert-secret-masker",
          top_score: 0,
          span_count: 0,
          status: "no_match",
        },
      },
    });

    initCollectionController(mockDom, () => currentSettings, {
      getCollections: () => [
        {
          id: "notes",
          slug: "notes",
          name: "Notes",
          icon: null,
          collection_type: "standard",
          kind: "system",
          sort_order: 0,
          created_at: 0,
          updated_at: 0,
        },
      ],
      requestCreateCollection: async () => null,
      refreshCollections: async () => {},
    });
    await setActiveCollection("notes");

    currentSettings = buildSettings({
      enrichmentSummaryEnabled: false,
      enrichmentTaggingEnabled: false,
      enrichmentProvider: "openai",
      providers: {
        openai: { apiKey: "test-key" },
      } as Settings["providers"],
    });
    await processNoteBackground("mock-1", "disabled enrichment");

    enrichEntryMock.mockRejectedValueOnce(new Error("missing provider"));
    currentSettings = buildSettings({
      enrichmentSummaryEnabled: true,
      enrichmentTaggingEnabled: true,
      enrichmentProvider: "openai",
      providers: {
        openai: { apiKey: "" },
      } as Settings["providers"],
    });
    await processNoteBackground("mock-1", "unconfigured enrichment");

    expect(summarizeEntryMock).not.toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "db_update_entry_enrichment").length,
    ).toBe(2);
  });

  test("processNoteBackground should not throw when enrichment fails and should still persist classification and secret verdict", async () => {
    let currentSettings = buildSettings({
      enrichmentSummaryEnabled: true,
      enrichmentTaggingEnabled: true,
      enrichmentProvider: "openai",
      providers: {
        openai: { apiKey: "test-key" },
      } as Settings["providers"],
    });

    enrichEntryMock.mockRejectedValue(new Error("enrichment boom"));
    scanMock.mockResolvedValue({
      verdict: "likely_secret",
      source: "trufflehog",
      secret_type: "token",
      confidence: 0.9,
      reason: "match",
      evidence: {},
      diagnostics: {
        trufflehog: {
          available: true,
          matched: true,
          verified: false,
          detector: "JWT",
          status: "matched",
        },
        secret_masker: {
          enabled: true,
          matched: false,
          model: "distilbert-secret-masker",
          top_score: 0,
          span_count: 0,
          status: "no_match",
        },
      },
    });

    initCollectionController(mockDom, () => currentSettings, {
      getCollections: () => [
        {
          id: "notes",
          slug: "notes",
          name: "Notes",
          icon: null,
          collection_type: "standard",
          kind: "system",
          sort_order: 0,
          created_at: 0,
          updated_at: 0,
        },
      ],
      requestCreateCollection: async () => null,
      refreshCollections: async () => {},
    });
    await setActiveCollection("notes");

    await expect(
      processNoteBackground("mock-1", "content with secret"),
    ).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith(
      "db_update_entry_secret",
      expect.objectContaining({
        id: "mock-1",
        secretVerdict: "likely_secret",
        secretType: "token",
        secretSource: "trufflehog",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "db_update_entry_enrichment",
      expect.objectContaining({
        id: "mock-1",
        enrichmentTags: null,
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "db_update_entry_processing_diagnostics",
      expect.objectContaining({ id: "mock-1" }),
    );
  });

  test("should persist processing diagnostics via entry reads", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Diagnostics persistence test",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });

    await invoke("db_update_entry_processing_diagnostics", {
      id,
      processingDiagnostics: JSON.stringify({
        version: 2,
        heuristic: { status: "completed", matches: [], error: null },
        enrichment: { status: "fallback" },
        secret_detection: { final_verdict: "not_secret" },
      }),
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Diagnostics persistence test",
      limit: 10,
    });

    expect(entries.find((entry) => entry.id === id)?.processing_diagnostics).toContain(
      '"version":2',
    );
  });

  test("processNoteBackground should keep heuristic tags separate when provider is unavailable", async () => {
    let currentSettings = buildSettings({
      enrichmentSummaryEnabled: false,
      enrichmentTaggingEnabled: true,
      enrichmentProvider: "none",
    });

    enrichEntryMock.mockRejectedValueOnce(new Error("provider unavailable"));

    scanMock.mockResolvedValue({
      verdict: "not_secret",
      source: "both",
      secret_type: "unknown",
      confidence: 1,
      reason: "none",
      evidence: {},
      diagnostics: {
        trufflehog: {
          available: false,
          matched: false,
          verified: null,
          detector: null,
          status: "unavailable",
        },
        secret_masker: {
          enabled: true,
          matched: false,
          model: "distilbert-secret-masker",
          top_score: 0,
          span_count: 0,
          status: "no_match",
        },
      },
    });

    initCollectionController(mockDom, () => currentSettings, {
      getCollections: () => [
        {
          id: "notes",
          slug: "notes",
          name: "Notes",
          icon: null,
          collection_type: "standard",
          kind: "system",
          sort_order: 0,
          created_at: 0,
          updated_at: 0,
        },
      ],
      requestCreateCollection: async () => null,
      refreshCollections: async () => {},
    });
    await setActiveCollection("notes");

    await processNoteBackground("mock-heuristic", "https://api.example.com/v1/users");

    expect(invokeMock).toHaveBeenCalledWith(
      "db_update_entry_enrichment",
      expect.objectContaining({
        id: "mock-heuristic",
        enrichmentTags: null,
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "db_replace_generated_tags",
      expect.objectContaining({
        id: "mock-heuristic",
        tagsJson: expect.stringContaining('"source":"heuristic"'),
      }),
    );
  });

  test("normalizes provider enrichment tags and removes generic junk", () => {
    const normalized = normalizeEnrichmentResult({
      summary: " summary ",
      tags: [" Note ", "API", "api", "general", "json_data"],
      source: "provider",
    });

    expect(normalized.summary).toBe("summary");
    expect(normalized.tags).toEqual(["api", "json-data"]);
  });

  test("list hover and eye action sync with graph when graph is visible", async () => {
    const hovered: Array<string | null> = [];
    const focused: string[] = [];
    const filtered: string[] = [];
    const appended: FakeElement[] = [];

    mockDom.notesList.replaceChildren = () => {
      appended.length = 0;
    };
    mockDom.notesList.appendChild = (child: FakeElement) => {
      appended.push(child);
      return child;
    };

    const id = await invoke<string>("db_add_entry", {
      content: "Graph sync item",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });

    await invoke("db_move_entries_to_collection", {
      ids: [id],
      collectionId: "notes",
    });

    let currentSettings = buildSettings();
    initCollectionController(mockDom, () => currentSettings, {
      getCollections: () => [
        {
          id: "notes",
          slug: "notes",
          name: "Notes",
          icon: null,
          collection_type: "standard",
          kind: "system",
          sort_order: 0,
          created_at: 0,
          updated_at: 0,
        },
      ],
      requestCreateCollection: async () => null,
      refreshCollections: async () => {},
      isGraphVisible: () => true,
      setGraphHoveredEntry: (entryId) => {
        hovered.push(entryId);
      },
      focusGraphEntry: (entryId) => {
        focused.push(entryId);
      },
      applyRelatedToFilter: (entryId) => {
        filtered.push(entryId);
      },
    });

    await setActiveCollection("notes");

    expect(appended.length).toBeGreaterThan(0);
    const firstItem = appended[0]!;
    expect(firstItem.innerHTML).toContain('data-graph-focus-entry-id');

    firstItem.dispatch("mouseenter");
    firstItem.dispatch("mouseleave");

    expect(hovered).toEqual([id, null]);

    const eyeButton = firstItem.querySelector("[data-graph-focus-entry-id]") as FakeElement | null;
    expect(eyeButton).not.toBeNull();
    eyeButton?.dispatch("click", {
      stopPropagation: vi.fn(),
    });

    expect(focused).toEqual([id]);

    const filterButton = firstItem.querySelector("[data-graph-filter-entry-id]") as FakeElement | null;
    expect(filterButton).not.toBeNull();
    filterButton?.dispatch("click", {
      stopPropagation: vi.fn(),
    });

    expect(filtered).toEqual([id]);
  });

  test("should add and remove manual badges with normalization", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Manual badge test",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });

    await invoke("db_add_manual_badge", {
      id,
      badge: "  Work  ",
      color: "default",
    });
    await invoke("db_add_manual_badge", {
      id,
      badge: "work",
      color: "default",
    });
    await invoke("db_add_manual_badge", {
      id,
      badge: "Personal",
      color: "blue",
    });

    let entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "work",
      limit: 10,
    });
    const match = entries.find((entry) => entry.id === id);
    expect(match?.manual_badges).toBe(
      JSON.stringify([
        { name: "work", color: "default" },
        { name: "personal", color: "blue" },
      ]),
    );

    await invoke("db_remove_manual_badge", { id, badge: "WORK" });
    entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "personal",
      limit: 10,
    });
    const updated = entries.find((entry) => entry.id === id);
    expect(updated?.manual_badges).toBe(
      JSON.stringify([{ name: "personal", color: "blue" }]),
    );

    await invoke("db_remove_manual_badge", { id, badge: "personal" });
    entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Manual badge test",
      limit: 10,
    });
    const cleared = entries.find((entry) => entry.id === id);
    expect(cleared?.manual_badges).toBeNull();
  });

  test("should clear auto label independently from manual badges", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Clear label test",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });

    await invoke("db_update_entry_classification", {
      id,
      label: "code",
      labelScore: 0.91,
      embedding: JSON.stringify([1, 2, 3]),
    });
    await invoke("db_add_manual_badge", {
      id,
      badge: "kept",
      color: "default",
    });
    await invoke("db_clear_entry_label", { id });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Clear label test",
      limit: 10,
    });
    const match = entries.find((entry) => entry.id === id);
    expect(match?.label).toBeNull();
    expect(match?.label_score).toBeNull();
    expect(match?.manual_badges).toBe(
      JSON.stringify([{ name: "kept", color: "default" }]),
    );
  });

  test("should copy entries into a target collection without changing the original", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Copy collection regression",
      htmlContent: "<p>copy me</p>",
      source: "clipboard",
      sourceApp: "Copy Test",
      createdAt: Date.now(),
    });

    await invoke("db_add_manual_badge", { id, badge: "keep", color: "blue" });
    await invoke("db_update_entry_secret", {
      id,
      secretVerdict: "likely_secret",
      secretType: "token",
      secretSource: "manual",
    });
    await invoke("db_copy_entries_to_collection", {
      ids: [id],
      collectionId: "todo",
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Copy collection regression",
      limit: 10,
    });
    const original = entries.find((entry) => entry.id === id);
    const copies = entries.filter((entry) => entry.id !== id);

    expect(original?.collection_id).toBeNull();
    expect(original?.is_note).toBe(false);
    expect(copies).toHaveLength(1);
    expect(copies[0].collection_id).toBe("todo");
    expect(copies[0].manual_badges).toBe(
      JSON.stringify([{ name: "keep", color: "blue" }]),
    );
    expect(copies[0].secret_verdict).toBe("likely_secret");
    expect(copies[0].html_content).toBe("<p>copy me</p>");
  });

  test("should allow deleting todo and moving entries to no collection", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Todo delete regression",
      htmlContent: null,
      source: "manual",
      sourceApp: "Delete Test",
      createdAt: Date.now(),
    });

    await invoke("db_move_entries_to_collection", {
      ids: [id],
      collectionId: "todo",
    });
    await invoke("db_delete_collection", {
      id: "todo",
      moveEntriesToCollectionId: null,
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Todo delete regression",
      limit: 10,
    });
    const collections = await invoke<Array<{ id: string }>>(
      "db_list_collections",
    );

    expect(entries.find((entry) => entry.id === id)?.collection_id).toBeNull();
    expect(entries.find((entry) => entry.id === id)?.is_note).toBe(false);
    expect(collections.some((collection) => collection.id === "todo")).toBe(
      false,
    );
  });

  test("should duplicate a collection with copied entries and preserved metadata", async () => {
    const created = await invoke<{
      id: string;
      name: string;
      collection_type: string;
      icon: string | null;
      kind: string;
    }>("db_create_collection", {
      name: "Recipes",
      icon: "book-open",
      collectionType: "checklist",
    });

    const id = await invoke<string>("db_add_entry", {
      content: "Recipe duplicate regression",
      htmlContent: "<p>keep me</p>",
      source: "manual",
      sourceApp: "Duplicate Test",
      createdAt: Date.now(),
    });

    await invoke("db_add_manual_badge", { id, badge: "meal", color: "green" });
    await invoke("db_update_entry_secret", {
      id,
      secretVerdict: "likely_secret",
      secretType: "token",
      secretSource: "manual",
    });
    await invoke("db_set_entry_checklist_completed", {
      id,
      checklistCompleted: true,
    });
    await invoke("db_move_entries_to_collection", {
      ids: [id],
      collectionId: created.id,
    });

    const duplicated = await invoke<{
      id: string;
      name: string;
      collection_type: string;
      icon: string | null;
      kind: string;
    }>("db_duplicate_collection", {
      id: created.id,
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Recipe duplicate regression",
      limit: 10,
    });

    const original = entries.find((entry) => entry.id === id);
    const copied = entries.find((entry) => entry.collection_id === duplicated.id);

    expect(duplicated.id).not.toBe(created.id);
    expect(duplicated.name).toBe("Recipes (copy)");
    expect(duplicated.collection_type).toBe("checklist");
    expect(duplicated.icon).toBe("book-open");
    expect(duplicated.kind).toBe("user");
    expect(original?.collection_id).toBe(created.id);
    expect(copied?.html_content).toBe("<p>keep me</p>");
    expect(copied?.manual_badges).toBe(
      JSON.stringify([{ name: "meal", color: "green" }]),
    );
    expect(copied?.secret_verdict).toBe("likely_secret");
    expect(copied?.checklist_completed).toBe(true);
  });

  test("should rename a user collection and update its slug uniquely", async () => {
    const source = await invoke<{
      id: string;
      name: string;
      slug: string;
      kind: string;
    }>("db_create_collection", {
      name: "Recipes",
      icon: null,
      collectionType: "standard",
    });
    await invoke("db_create_collection", {
      name: "Travel Plans",
      icon: null,
      collectionType: "standard",
    });

    const renamed = await invoke<{
      id: string;
      name: string;
      slug: string;
      kind: string;
    }>("db_rename_collection", {
      id: source.id,
      name: "Travel Plans",
    });

    const collections = await invoke<Array<{ id: string; name: string; slug: string }>>(
      "db_list_collections",
    );

    expect(renamed.id).toBe(source.id);
    expect(renamed.name).toBe("Travel Plans");
    expect(renamed.slug).toBe("travel-plans-2");
    expect(collections.find((collection) => collection.id === source.id)).toMatchObject({
      name: "Travel Plans",
      slug: "travel-plans-2",
    });
  });

  test("should keep system collection rename protections", async () => {
    await expect(
      invoke("db_rename_collection", {
        id: "notes",
        name: "Tasks",
      }),
    ).rejects.toThrow("Notes cannot be renamed");
  });

  test("should persist collection icons on create while leaving legacy rows nullable", async () => {
    const created = await invoke<{
      id: string;
      name: string;
      slug: string;
      icon: string | null;
      collection_type: string;
    }>("db_create_collection", {
      name: "Recipes",
      icon: "book-open",
      collectionType: "standard",
    });

    const collections = await invoke<
      Array<{ id: string; slug: string; icon: string | null; collection_type: string }>
    >("db_list_collections");

    expect(created.icon).toBe("book-open");
    expect(created.collection_type).toBe("standard");
    expect(
      collections.find((collection) => collection.id === created.id)?.icon,
    ).toBe("book-open");
    expect(
      collections.find((collection) => collection.id === "notes")?.icon,
    ).toBeNull();
  });

  test("should expose checklist collection types and persist checklist completion", async () => {
    const collections = await invoke<
      Array<{ id: string; collection_type: string }>
    >("db_list_collections");
    expect(
      collections.find((collection) => collection.id === "shopping-list")?.collection_type,
    ).toBe("checklist");

    const createdChecklist = await invoke<{
      id: string;
      collection_type: string;
    }>("db_create_collection", {
      name: "Weekend Tasks",
      icon: "list-todo",
      collectionType: "checklist",
    });

    expect(createdChecklist.collection_type).toBe("checklist");

    const id = await invoke<string>("db_add_entry", {
      content: "Checklist persistence test",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });
    await invoke("db_move_entries_to_collection", {
      ids: [id],
      collectionId: createdChecklist.id,
    });
    await invoke("db_set_entry_checklist_completed", {
      id,
      checklistCompleted: true,
    });

    const entries = await invoke<EntryRow[]>("db_list_entries", {
      search: "Checklist persistence test",
      limit: 10,
    });

    expect(entries.find((entry) => entry.id === id)?.checklist_completed).toBe(
      true,
    );
  });

  test("should create filter collections with persisted filter query", async () => {
    const created = await invoke<{
      id: string;
      collection_type: string;
      filter_query: string | null;
    }>("db_create_collection", {
      name: "Code Related",
      icon: "filter",
      collectionType: "filter",
      filterQuery: "tag:code related-to:entry-123",
    });

    expect(created.collection_type).toBe("filter");
    expect(created.filter_query).toBe("tag:code related-to:entry-123");

    const collections = await invoke<
      Array<{ id: string; collection_type: string; filter_query: string | null }>
    >("db_list_collections");
    expect(collections.find((collection) => collection.id === created.id)).toMatchObject({
      collection_type: "filter",
      filter_query: "tag:code related-to:entry-123",
    });
  });

  test("filter collection query should match items from other collections", async () => {
    const standardCollection = await invoke<{ id: string }>("db_create_collection", {
      name: "Real Bucket",
      icon: "folder",
      collectionType: "standard",
    });

    const matchingId = await invoke<string>("db_add_entry", {
      content: "Cross collection code item",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });
    await invoke("db_move_entries_to_collection", {
      ids: [matchingId],
      collectionId: standardCollection.id,
    });
    await invoke("db_update_entry_classification", {
      id: matchingId,
      label: "code",
      labelScore: 0.93,
      embedding: JSON.stringify([1, 0]),
    });

    const filterCollection = await invoke<{ id: string; filter_query: string | null }>(
      "db_create_collection",
      {
        name: "All code",
        icon: "filter",
        collectionType: "filter",
        filterQuery: "tag:code",
      },
    );

    const results = await invoke<SearchEntryResult[]>("search_entries", {
      query: null,
      filters: { tag: "code" },
      limit: 20,
    });

    expect(filterCollection.filter_query).toBe("tag:code");
    expect(results.map((result) => result.entry.id)).toContain(matchingId);
  });

  test("should reject moving or copying entries into filter collections", async () => {
    const filterCollection = await invoke<{ id: string }>("db_create_collection", {
      name: "Filtered",
      icon: "filter",
      collectionType: "filter",
      filterQuery: "tag:code",
    });

    const id = await invoke<string>("db_add_entry", {
      content: "Filter target",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: Date.now(),
    });

    await expect(
      invoke("db_move_entries_to_collection", {
        ids: [id],
        collectionId: filterCollection.id,
      }),
    ).rejects.toThrow("Filter collections cannot store copied or moved entries");

    await expect(
      invoke("db_copy_entries_to_collection", {
        ids: [id],
        collectionId: filterCollection.id,
      }),
    ).rejects.toThrow("Filter collections cannot store copied or moved entries");
  });

  test("should reorder collections between themselves", async () => {
    const first = await invoke<{ id: string }>("db_create_collection", {
      name: "First",
      icon: "folder",
      collectionType: "standard",
    });
    const second = await invoke<{ id: string }>("db_create_collection", {
      name: "Second",
      icon: "folder",
      collectionType: "standard",
    });

    await invoke("db_reorder_collection", {
      collectionId: second.id,
      targetCollectionId: first.id,
      position: "before",
    });

    const collections = await invoke<
      Array<{ id: string; sort_order: number }>
    >("db_list_collections");
    const firstIndex = collections.findIndex((collection) => collection.id === first.id);
    const secondIndex = collections.findIndex((collection) => collection.id === second.id);
    expect(secondIndex).toBeLessThan(firstIndex);
  });

  test("should persist manual collection ordering without touching clipboard behavior", async () => {
    await resetState();
    const collection = await invoke<{ id: string }>("db_create_collection", {
      name: "Ordered",
      icon: "folder",
      collectionType: "standard",
    });

    const firstId = await invoke<string>("db_add_entry", {
      content: "ordered first",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: 1,
    });
    const secondId = await invoke<string>("db_add_entry", {
      content: "ordered second",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: 2,
    });
    const clipboardId = await invoke<string>("db_add_entry", {
      content: "clipboard order control",
      htmlContent: null,
      source: "clipboard",
      sourceApp: null,
      createdAt: 3,
    });

    await invoke("db_move_entries_to_collection", {
      ids: [firstId, secondId],
      collectionId: collection.id,
    });

    await invoke("db_reorder_collection_entry", {
      collectionId: collection.id,
      entryId: secondId,
      targetEntryId: firstId,
      position: "before",
    });

    const ordered = await invoke<EntryRow[]>("db_list_collection_entries", {
      collectionId: collection.id,
      limit: 10,
    });
    const clipboard = await invoke<SearchEntryResult[]>("search_entries", {
      query: "clipboard order control",
      filters: { is_note: false },
      limit: 10,
    });

    expect(ordered.map((entry) => entry.id)).toEqual([secondId, firstId]);
    expect(ordered.map((entry) => entry.collection_sort_order)).toEqual([0, 1]);
    expect(
      ordered.every((entry) => entry.collection_id === collection.id),
    ).toBe(true);
    expect(clipboard.some((result) => result.entry.id === clipboardId)).toBe(true);
  });

  test("should keep completed checklist items below incomplete ones while allowing same-group reorder", async () => {
    await resetState();
    const firstId = await invoke<string>("db_add_entry", {
      content: "checklist incomplete first",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: 10,
    });
    const secondId = await invoke<string>("db_add_entry", {
      content: "checklist incomplete second",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: 11,
    });
    const doneId = await invoke<string>("db_add_entry", {
      content: "checklist done",
      htmlContent: null,
      source: "manual",
      sourceApp: null,
      createdAt: 12,
    });

    await invoke("db_move_entries_to_collection", {
      ids: [firstId, secondId, doneId],
      collectionId: "todo",
    });
    await invoke("db_set_entry_checklist_completed", {
      id: doneId,
      checklistCompleted: true,
    });

    await invoke("db_reorder_collection_entry", {
      collectionId: "todo",
      entryId: secondId,
      targetEntryId: firstId,
      position: "before",
    });

    const ordered = await invoke<EntryRow[]>("db_list_collection_entries", {
      collectionId: "todo",
      limit: 10,
    });

    expect(ordered.map((entry) => entry.id)).toEqual([secondId, firstId, doneId]);

    await expect(
      invoke("db_reorder_collection_entry", {
        collectionId: "todo",
        entryId: doneId,
        targetEntryId: firstId,
        position: "before",
      }),
    ).rejects.toThrow("same completion state");
  });

  test("should persist collection type conversion for the active collection", async () => {
    const created = await invoke<{
      id: string;
      collection_type: string;
    }>("db_create_collection", {
      name: "Conversion Test",
      icon: "folder",
      collectionType: "standard",
    });

    await invoke("db_update_collection_type", {
      id: created.id,
      collectionType: "checklist",
    });

    let collections = await invoke<
      Array<{ id: string; collection_type: string }>
    >("db_list_collections");
    expect(
      collections.find((collection) => collection.id === created.id)
        ?.collection_type,
    ).toBe("checklist");

    await invoke("db_update_collection_type", {
      id: created.id,
      collectionType: "standard",
    });

    collections = await invoke<Array<{ id: string; collection_type: string }>>(
      "db_list_collections",
    );
    expect(
      collections.find((collection) => collection.id === created.id)
        ?.collection_type,
    ).toBe("standard");
  });

  test("should generate local embedding and heuristic tags separately", async () => {
    const embedding = await invoke<number[]>("generate_embedding", { text: "some test text" });
    const heuristic = await invoke<{ matches: Array<{ label: string; reason: string }> }>(
      "heuristic_tag",
      { text: "https://example.com/docs" },
    );

    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBe(384);
    expect(heuristic.matches[0]).toEqual({
      label: "url",
      reason: "obvious_url",
    });
  });

  test("should run hybrid search in backend with filtered candidates", async () => {
    const noteId = await invoke<string>("db_add_entry", {
      content: "Rust semantic note",
      htmlContent: null,
      source: "manual",
      sourceApp: "VS Code",
      createdAt: Date.now(),
    });
    await invoke("db_promote_to_note", { id: noteId });
    await invoke("db_update_entry_classification", {
      id: noteId,
      label: "code",
      labelScore: 0.99,
      embedding: JSON.stringify([1, 0, 0]),
    });

    const clipboardId = await invoke<string>("db_add_entry", {
      content: "Rust semantic clipboard",
      htmlContent: null,
      source: "clipboard",
      sourceApp: "Terminal",
      createdAt: Date.now(),
    });
    await invoke("db_update_entry_classification", {
      id: clipboardId,
      label: "code",
      labelScore: 0.8,
      embedding: JSON.stringify([1, 0, 0]),
    });

    const results = await invoke<SearchEntryResult[]>("search_entries", {
      query: "rust semantic",
      filters: { is_note: true },
      limit: 10,
      mode: "hybrid",
      queryEmbedding: [1, 0, 0],
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.id).toBe(noteId);
    expect(results.every((result) => result.entry.is_note)).toBe(true);
    expect(results.every((result) => result.entry.id !== clipboardId)).toBe(
      true,
    );
    expect(["hybrid", "semantic", "keyword"]).toContain(results[0].match_type);
    expect(results[0].diagnostics.search_mode).toBe("hybrid");
    expect(results[0].diagnostics.cosine_similarity).toBeGreaterThan(0);
    expect(results[0].match_reasons).toContain("semantic");
  });

  test("should include hybrid diagnostics and recency-aware ranking metadata", async () => {
    const newerId = await invoke<string>("db_add_entry", {
      content: "Rust hybrid ranking note",
      htmlContent: null,
      source: "manual",
      sourceApp: "VS Code",
      createdAt: Date.now(),
    });
    await invoke("db_promote_to_note", { id: newerId });
    await invoke("db_update_entry_classification", {
      id: newerId,
      label: "code",
      labelScore: 0.98,
      embedding: JSON.stringify([1, 0, 0]),
    });

    const results = await invoke<SearchEntryResult[]>("search_entries", {
      query: "rust hybrid ranking",
      filters: { is_note: true },
      limit: 10,
      mode: "hybrid",
      queryEmbedding: [1, 0, 0],
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].diagnostics.fused_score).not.toBeNull();
    expect(results[0].diagnostics.recency_boost).not.toBeNull();
    expect(results[0].match_reasons.length).toBeGreaterThan(0);
  });

  test("should search entries via backend search API with exact tag filters", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Rust FTS foundation note",
      htmlContent: null,
      source: "manual",
      sourceApp: "VS Code",
      createdAt: Date.now(),
    });

    await invoke("db_promote_to_note", { id });
    await invoke("db_update_entry_classification", {
      id,
      label: "code",
      labelScore: 0.97,
      embedding: JSON.stringify([0.1, 0.2]),
    });
    await invoke("db_add_manual_badge", {
      id,
      badge: "Search",
      color: "default",
    });

    const results = await invoke<SearchEntryResult[]>("search_entries", {
      query: "rust foundation",
      filters: {
        is_note: true,
        tag: "search",
        source_app: "vs code",
      },
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.id).toBe(id);
    expect(results[0].matched_tags).toContain("search");
    expect(results[0].match_type).toBe("keyword");
  });

  test("should fall back cleanly when semantic query embedding is unavailable", async () => {
    const id = await invoke<string>("db_add_entry", {
      content: "Fallback semantic keyword test",
      htmlContent: null,
      source: "manual",
      sourceApp: "VS Code",
      createdAt: Date.now(),
    });
    await invoke("db_promote_to_note", { id });

    const results = await invoke<SearchEntryResult[]>("search_entries", {
      query: "Fallback semantic",
      filters: { is_note: true },
      limit: 10,
      mode: "semantic",
      queryEmbedding: null,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.id).toBe(id);
    expect(results[0].match_type).toBe("keyword");
    expect(results[0].diagnostics.semantic_fallback_reason).toBe(
      "missing_query_embedding",
    );
  });

  test("should provide backend related entries", async () => {
    const anchorId = await invoke<string>("db_add_entry", {
      content: "Anchor related note",
      htmlContent: null,
      source: "manual",
      sourceApp: "Related Test App",
      createdAt: Date.now(),
    });
    await invoke("db_promote_to_note", { id: anchorId });
    await invoke("db_update_entry_classification", {
      id: anchorId,
      label: "code",
      labelScore: 0.9,
      embedding: JSON.stringify([1, 0, 0]),
    });

    const neighborId = await invoke<string>("db_add_entry", {
      content: "Neighbor related note",
      htmlContent: null,
      source: "manual",
      sourceApp: "Related Test App",
      createdAt: Date.now(),
    });
    await invoke("db_promote_to_note", { id: neighborId });
    await invoke("db_update_entry_classification", {
      id: neighborId,
      label: "code",
      labelScore: 0.88,
      embedding: JSON.stringify([0.95, 0.05, 0]),
    });

    const related = await invoke<SearchEntryResult[]>("get_related_entries", {
      entryId: anchorId,
      filters: { is_note: true, source_app: "Related Test App" },
      limit: 5,
    });

    expect(related.length).toBeGreaterThan(0);
    expect(related[0].entry.id).toBe(neighborId);
    expect(related[0].match_type).toBe("related_semantic");
  });

  test("parses related-to filter syntax in collection and clipboard searches", () => {
    expect(parseCollectionSearchInput("tag:code related-to:entry-123", "notes")).toEqual({
      query: null,
      filters: {
        collection_id: "notes",
        tag: "code",
        related_to: "entry-123",
      },
    });

    expect(parseClipboardSearchInput("related:entry-456")).toEqual({
      query: null,
      filters: {
        is_note: false,
        related_to: "entry-456",
      },
    });
  });

  test("search_entries should support related-to filter syntax", async () => {
    const anchorId = await invoke<string>("db_add_entry", {
      content: "Anchor filter note",
      htmlContent: null,
      source: "manual",
      sourceApp: "Related Filter App",
      createdAt: Date.now(),
    });
    await invoke("db_promote_to_note", { id: anchorId });
    await invoke("db_update_entry_classification", {
      id: anchorId,
      label: "code",
      labelScore: 0.91,
      embedding: JSON.stringify([1, 0, 0]),
    });

    const neighborId = await invoke<string>("db_add_entry", {
      content: "Neighbor filter note",
      htmlContent: null,
      source: "manual",
      sourceApp: "Related Filter App",
      createdAt: Date.now(),
    });
    await invoke("db_promote_to_note", { id: neighborId });
    await invoke("db_update_entry_classification", {
      id: neighborId,
      label: "code",
      labelScore: 0.88,
      embedding: JSON.stringify([0.95, 0.05, 0]),
    });

    const unrelatedId = await invoke<string>("db_add_entry", {
      content: "Unrelated filter note",
      htmlContent: null,
      source: "manual",
      sourceApp: "Related Filter App",
      createdAt: Date.now(),
    });
    await invoke("db_promote_to_note", { id: unrelatedId });
    await invoke("db_update_entry_classification", {
      id: unrelatedId,
      label: "ops",
      labelScore: 0.75,
      embedding: JSON.stringify([0, 1, 0]),
    });

    const results = await invoke<SearchEntryResult[]>("search_entries", {
      query: null,
      filters: { is_note: true, related_to: anchorId },
      limit: 10,
    });

    const ids = results.map((result) => result.entry.id);
    expect(ids).toContain(anchorId);
    expect(ids).toContain(neighborId);
    expect(ids).not.toContain(unrelatedId);
  });

  test("should keep clipboard and notes search results separated by is_note", async () => {
    const clipboardId = await invoke<string>("db_add_entry", {
      content: "view separation regression item",
      htmlContent: null,
      source: "clipboard",
      sourceApp: "Separation Test",
      createdAt: Date.now(),
    });

    const noteId = await invoke<string>("db_add_entry", {
      content: "view separation regression item",
      htmlContent: null,
      source: "manual",
      sourceApp: "Separation Test",
      createdAt: Date.now(),
    });
    await invoke("db_promote_to_note", { id: noteId });

    const clipboardResults = await invoke<SearchEntryResult[]>(
      "search_entries",
      {
        query: "view separation regression item",
        filters: { is_note: false },
        limit: 10,
      },
    );

    const noteResults = await invoke<SearchEntryResult[]>("search_entries", {
      query: "view separation regression item",
      filters: { is_note: true },
      limit: 10,
    });

    expect(
      clipboardResults.some((result) => result.entry.id === clipboardId),
    ).toBe(true);
    expect(
      clipboardResults.every((result) => result.entry.is_note === false),
    ).toBe(true);
    expect(clipboardResults.every((result) => result.entry.id !== noteId)).toBe(
      true,
    );

    expect(noteResults.some((result) => result.entry.id === noteId)).toBe(true);
    expect(noteResults.every((result) => result.entry.is_note === true)).toBe(
      true,
    );
    expect(noteResults.every((result) => result.entry.id !== clipboardId)).toBe(
      true,
    );
  });

  test("should remove promoted clipboard items from clipboard results and include them in notes", async () => {
    const promotedId = await invoke<string>("db_add_entry", {
      content: "promote to note separation",
      htmlContent: null,
      source: "clipboard",
      sourceApp: "Promotion Test",
      createdAt: Date.now(),
    });

    const beforePromotion = await invoke<SearchEntryResult[]>(
      "search_entries",
      {
        query: "promote to note separation",
        filters: { is_note: false },
        limit: 10,
      },
    );

    expect(
      beforePromotion.some((result) => result.entry.id === promotedId),
    ).toBe(true);

    await invoke("db_promote_to_note", { id: promotedId });

    const clipboardResults = await invoke<SearchEntryResult[]>(
      "search_entries",
      {
        query: "promote to note separation",
        filters: { is_note: false },
        limit: 10,
      },
    );

    const noteResults = await invoke<SearchEntryResult[]>("search_entries", {
      query: "promote to note separation",
      filters: { is_note: true },
      limit: 10,
    });

    expect(
      clipboardResults.every((result) => result.entry.id !== promotedId),
    ).toBe(true);
    expect(noteResults.some((result) => result.entry.id === promotedId)).toBe(
      true,
    );
    expect(noteResults.every((result) => result.entry.is_note === true)).toBe(
      true,
    );
  });
});
