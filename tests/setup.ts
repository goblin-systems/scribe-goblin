import { beforeEach, vi } from "vitest";

// In-memory mock DB
let mockEntries: any[] = [];
let mockEmbeddings = new Map<string, number[]>();
let nextId = 1;
let mockCollections: Array<{
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  collection_type: string;
  filter_query: string | null;
  kind: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}> = [
  {
    id: "notes",
    slug: "notes",
    name: "Notes",
    icon: null,
    collection_type: "standard",
    filter_query: null,
    kind: "system",
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
  },
  {
    id: "todo",
    slug: "todo",
    name: "Todo",
    icon: null,
    collection_type: "checklist",
    filter_query: null,
    kind: "system",
    sort_order: 1,
    created_at: 0,
    updated_at: 0,
  },
  {
    id: "shopping-list",
    slug: "shopping-list",
    name: "Shopping List",
    icon: null,
    collection_type: "checklist",
    filter_query: null,
    kind: "system",
    sort_order: 2,
    created_at: 0,
    updated_at: 0,
  },
];

function nextCollectionSortOrder(collectionId: string | null | undefined): number | null {
  if (!collectionId) return null;
  const orders = mockEntries
    .filter((entry) => entry.collection_id === collectionId)
    .map((entry) =>
      typeof entry.collection_sort_order === "number" ? entry.collection_sort_order : -1,
    );
  return (orders.length > 0 ? Math.max(...orders) : -1) + 1;
}

function indexWithinCollection(ids: unknown[], id: string): number {
  const index = ids.findIndex((candidate) => candidate === id);
  return index >= 0 ? index : 0;
}

function collectionEntryComparator(collectionId: string) {
  const collection = mockCollections.find((item) => item.id === collectionId);
  return (left: any, right: any) => {
    if (collection?.collection_type === "checklist") {
      const completionDelta = Number(Boolean(left.checklist_completed)) - Number(Boolean(right.checklist_completed));
      if (completionDelta !== 0) return completionDelta;
    }
    const orderDelta =
      (typeof left.collection_sort_order === "number" ? left.collection_sort_order : Number.MAX_SAFE_INTEGER) -
      (typeof right.collection_sort_order === "number" ? right.collection_sort_order : Number.MAX_SAFE_INTEGER);
    if (orderDelta !== 0) return orderDelta;
    return (left.created_at ?? 0) - (right.created_at ?? 0);
  };
}

function clipboardEntryComparator(left: any, right: any): number {
  const pinnedDelta = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
  if (pinnedDelta !== 0) return pinnedDelta;
  return (right.created_at ?? 0) - (left.created_at ?? 0);
}

function normalizeCollectionOrders(collectionId: string): void {
  const ordered = mockEntries
    .filter((entry) => entry.collection_id === collectionId)
    .sort(collectionEntryComparator(collectionId));
  ordered.forEach((entry, index) => {
    entry.collection_sort_order = index;
  });
}

function resetMockState(): void {
  mockEntries = [];
  mockEmbeddings = new Map<string, number[]>();
  nextId = 1;
  mockCollections = [
    {
      id: "notes",
      slug: "notes",
      name: "Notes",
      icon: null,
      collection_type: "standard",
      filter_query: null,
      kind: "system",
      sort_order: 0,
      created_at: 0,
      updated_at: 0,
    },
    {
      id: "todo",
      slug: "todo",
      name: "Todo",
      icon: null,
      collection_type: "checklist",
      filter_query: null,
      kind: "system",
      sort_order: 1,
      created_at: 0,
      updated_at: 0,
    },
    {
      id: "shopping-list",
      slug: "shopping-list",
      name: "Shopping List",
      icon: null,
      collection_type: "checklist",
      filter_query: null,
      kind: "system",
      sort_order: 2,
      created_at: 0,
      updated_at: 0,
    },
  ];
}

resetMockState();

beforeEach(() => {
  resetMockState();
});

function nextMockCollectionName(sourceName: string): string {
  const trimmed = String(sourceName).trim();
  const base = `${trimmed} (copy)`;
  if (!mockCollections.some((collection) => collection.name === base)) {
    return base;
  }

  let copyIndex = 2;
  while (mockCollections.some((collection) => collection.name === `${trimmed} (copy ${copyIndex})`)) {
    copyIndex += 1;
  }

  return `${trimmed} (copy ${copyIndex})`;
}

function slugifyMockCollectionName(name: string): string {
  let slug = "";
  let lastWasDash = false;

  for (const ch of String(name).trim().toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      slug += ch;
      lastWasDash = false;
    } else if (!lastWasDash) {
      slug += "-";
      lastWasDash = true;
    }
  }

  slug = slug.replace(/^-+|-+$/g, "");
  return slug || "collection";
}

function nextMockCollectionSlug(name: string, excludeId?: string): string {
  const base = slugifyMockCollectionName(name);
  let candidate = base;
  let suffix = 2;

  while (
    mockCollections.some(
      (collection) =>
        collection.slug === candidate && collection.id !== (excludeId ?? ""),
    )
  ) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function parseEmbeddingValue(raw: unknown): number[] | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) &&
      parsed.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

const DEFAULT_RANKING_CONFIG = {
  shortKeywordWeight: 1.35,
  shortSemanticWeight: 2,
  mediumKeywordWeight: 1.15,
  mediumSemanticWeight: 2.85,
  longKeywordWeight: 1.0,
  longSemanticWeight: 2,
  semanticRelevanceThreshold: 0.385,
  recencyBoostMax: 0.02,
  rrfK: 10,
};

function sanitizeNonNegative(
  value: unknown,
  fallback: number,
  min = 0,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? value
    : fallback;
}

function normalizeRankingConfig(raw: any) {
  return {
    shortKeywordWeight: sanitizeNonNegative(
      raw?.shortKeywordWeight,
      DEFAULT_RANKING_CONFIG.shortKeywordWeight,
    ),
    shortSemanticWeight: sanitizeNonNegative(
      raw?.shortSemanticWeight,
      DEFAULT_RANKING_CONFIG.shortSemanticWeight,
    ),
    mediumKeywordWeight: sanitizeNonNegative(
      raw?.mediumKeywordWeight,
      DEFAULT_RANKING_CONFIG.mediumKeywordWeight,
    ),
    mediumSemanticWeight: sanitizeNonNegative(
      raw?.mediumSemanticWeight,
      DEFAULT_RANKING_CONFIG.mediumSemanticWeight,
    ),
    longKeywordWeight: sanitizeNonNegative(
      raw?.longKeywordWeight,
      DEFAULT_RANKING_CONFIG.longKeywordWeight,
    ),
    longSemanticWeight: sanitizeNonNegative(
      raw?.longSemanticWeight,
      DEFAULT_RANKING_CONFIG.longSemanticWeight,
    ),
    semanticRelevanceThreshold: sanitizeNonNegative(
      raw?.semanticRelevanceThreshold,
      DEFAULT_RANKING_CONFIG.semanticRelevanceThreshold,
    ),
    recencyBoostMax: sanitizeNonNegative(
      raw?.recencyBoostMax,
      DEFAULT_RANKING_CONFIG.recencyBoostMax,
    ),
    rrfK: sanitizeNonNegative(raw?.rrfK, DEFAULT_RANKING_CONFIG.rrfK, 1),
  };
}

function hybridWeights(
  query: string | null | undefined,
  terms: string[],
  rankingConfig: ReturnType<typeof normalizeRankingConfig>,
) {
  const queryLength = String(query || "").trim().length;
  if (terms.length <= 2 || queryLength <= 18) {
    return {
      keyword: rankingConfig.shortKeywordWeight,
      semantic: rankingConfig.shortSemanticWeight,
    };
  }

  if (terms.length >= 4 || queryLength >= 36) {
    return {
      keyword: rankingConfig.longKeywordWeight,
      semantic: rankingConfig.longSemanticWeight,
    };
  }

  return {
    keyword: rankingConfig.mediumKeywordWeight,
    semantic: rankingConfig.mediumSemanticWeight,
  };
}

function weightedRrfScore(
  weight: number,
  rankIndex: number,
  rankingConfig: ReturnType<typeof normalizeRankingConfig>,
): number {
  return weight / (rankingConfig.rrfK + rankIndex + 1);
}

function parseTagsFromEntry(entry: any): string[] {
  const tags: string[] = [];
  if (typeof entry.label === "string" && entry.label.trim()) {
    tags.push(entry.label.trim().toLowerCase());
  }
  if (entry.manual_badges) {
    try {
      const parsed = JSON.parse(entry.manual_badges);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const name = typeof item === "string" ? item : item?.name;
          if (typeof name === "string" && name.trim()) {
            const normalized = name.trim().toLowerCase();
            if (!tags.includes(normalized)) tags.push(normalized);
          }
        }
      }
    } catch {
      // Ignore invalid badge payloads in test mock.
    }
  }
  return tags;
}

function parseSearchInput(query: string | null | undefined) {
  const filters: Record<string, any> = {};
  const terms: string[] = [];

  for (const token of String(query || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)) {
    const idx = token.indexOf(":");
    if (idx <= 0) {
      terms.push(token.toLowerCase());
      continue;
    }
    const key = token.slice(0, idx).toLowerCase();
    const value = token.slice(idx + 1).trim();
    if (!value) continue;
    if (key === "tag" || key === "label") {
      filters.tag = value.toLowerCase();
    } else if (key === "source") {
      filters.source = value.toLowerCase();
    } else if (key === "app" || key === "sourceapp") {
      filters.source_app = value.toLowerCase();
    } else {
      terms.push(token.toLowerCase());
    }
  }

  return { terms, filters };
}

function inferContentTypeFromName(
  name: string | null | undefined,
): string | null {
  if (!name) return null;

  const extension = name.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "txt":
    case "md":
    case "log":
    case "ini":
      return "text/plain";
    case "rs":
      return "text/rust";
    case "ts":
      return "text/typescript";
    case "tsx":
      return "text/tsx";
    case "js":
      return "text/javascript";
    case "jsx":
      return "text/jsx";
    case "json":
      return "application/json";
    case "toml":
      return "application/toml";
    case "yaml":
    case "yml":
      return "application/yaml";
    case "xml":
      return "application/xml";
    case "csv":
      return "text/csv";
    case "html":
    case "htm":
      return "text/html";
    case "css":
      return "text/css";
    case "sh":
      return "application/x-sh";
    case "ps1":
      return "text/plain";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return null;
  }
}

function isTextLike(
  contentType: string | null,
  name: string | null | undefined,
): boolean {
  const normalized = (contentType || inferContentTypeFromName(name) || "")
    .trim()
    .toLowerCase();
  return (
    normalized.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/yaml",
      "application/toml",
      "application/javascript",
      "application/x-sh",
    ].includes(normalized)
  );
}

function attachmentPath(name: string | null | undefined): string {
  return `attachments/mock-${nextId}${name && name.includes(".") ? `.${name.split(".").pop()}` : ""}`;
}

export const invokeMock = vi.fn(async (command: string, args: any) => {
      if (command === "http_fetch") {
        const req = args.request;
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body || undefined,
        });
        const body = await res.text();
        return {
          status: res.status,
          body: body,
        };
      }

      if (command === "db_add_entry") {
        const id = "mock-" + nextId++;
        const entry = {
          id,
          content: args.content,
          html_content: args.htmlContent,
          source: args.source,
          source_app: args.sourceApp || null,
          created_at: args.createdAt,
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
        mockEntries.push(entry);
        return id;
      }

      if (command === "import_capture") {
        const created: any[] = [];
        for (const payload of args.payloads ?? []) {
          const id = "mock-" + nextId++;
          const resolvedContentType =
            payload.contentType || inferContentTypeFromName(payload.name);
          const isAttachment =
            payload.kind === "file" &&
            !isTextLike(resolvedContentType, payload.name);
          const entry = {
            id,
            content: payload.text || payload.name || "Imported attachment",
            html_content: payload.htmlContent || null,
            source: "import",
            source_app: null,
            created_at: Date.now(),
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
            collection_id: "notes",
            checklist_completed: false,
            is_note: payload.kind === "text" ? true : true,
            import_origin: payload.importOrigin || null,
            import_name: payload.name || null,
            content_type: resolvedContentType || null,
            attachment_rel_path: isAttachment
              ? attachmentPath(payload.name)
              : null,
            attachment_size_bytes: isAttachment ? 1 : null,
            attachment_sha256: isAttachment ? "mock" : null,
            collection_sort_order: 0,
          };
          mockEntries.push(entry);
          created.push(entry);
        }
        return created;
      }

      if (command === "db_list_entries") {
        let results = [...mockEntries];
        if (args.isNote === true) {
          results = results.filter((e) => e.is_note === true);
        } else if (args.isNote === false) {
          results = results.filter((e) => e.is_note === false);
        }
        if (args.search) {
          const q = args.search.toLowerCase();
          results = results.filter(
            (e) =>
              e.content.toLowerCase().includes(q) ||
              (e.label && e.label.toLowerCase().includes(q)) ||
              (e.manual_badges && e.manual_badges.toLowerCase().includes(q)) ||
              (e.tags_json && e.tags_json.toLowerCase().includes(q)),
          );
        }
        return results
          .sort(clipboardEntryComparator)
          .slice(0, args.limit)
          ;
      }

      if (command === "db_set_entry_pinned") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.pinned = Boolean(args.pinned);
        }
        return;
      }

      if (command === "db_list_collections") {
        return [...mockCollections];
      }

      if (command === "db_create_collection") {
        const collectionType =
          args.collectionType === "checklist"
            ? "checklist"
            : args.collectionType === "filter"
              ? "filter"
              : "standard";
        const slug =
          String(args.name || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || `collection-${nextId}`;
        const collection = {
          id: slug,
          slug,
          name: String(args.name).trim(),
          icon: typeof args.icon === "string" && args.icon.trim()
            ? String(args.icon).trim().toLowerCase()
            : null,
          collection_type: collectionType,
          filter_query:
            collectionType === "filter"
              ? String(args.filterQuery ?? "").trim() || null
              : null,
          kind: "user",
          sort_order: mockCollections.length,
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        mockCollections.push(collection);
        return collection;
      }

      if (command === "db_delete_collection") {
        if (args.id === "notes") {
          throw new Error("Notes cannot be deleted");
        }
        const destinationId = args.moveEntriesToCollectionId ?? null;
        const nextSortOrder = destinationId ? nextCollectionSortOrder(destinationId) ?? 0 : null;
        mockEntries = mockEntries.map((entry) =>
          entry.collection_id === args.id
            ? {
                ...entry,
                collection_id: destinationId,
                checklist_completed: entry.checklist_completed ?? false,
                is_note: destinationId === "notes",
                collection_sort_order:
                  destinationId && nextSortOrder !== null
                    ? nextSortOrder + indexWithinCollection(
                        mockEntries
                          .filter((candidate) => candidate.collection_id === args.id)
                          .map((candidate) => candidate.id),
                        entry.id,
                      )
                    : null,
              }
            : entry,
        );
        mockCollections = mockCollections.filter(
          (collection) => collection.id !== args.id,
        );
        return;
      }

      if (command === "db_copy_entries_to_collection") {
        const targetCollection = mockCollections.find(
          (collection) => collection.id === (args.collectionId ?? null),
        );
        if (targetCollection?.collection_type === "filter") {
          throw new Error("Filter collections cannot store copied or moved entries");
        }
        const nextEntries = [...mockEntries];
        const nextSortOrder = args.collectionId
          ? nextCollectionSortOrder(args.collectionId) ?? 0
          : null;
        for (const sourceId of args.ids || []) {
          const entry = mockEntries.find(
            (candidate) => candidate.id === sourceId,
          );
          if (!entry) continue;
          const collectionId = args.collectionId ?? null;
          nextEntries.push({
            ...entry,
            id: `copy-${nextId++}`,
            collection_id: collectionId,
            checklist_completed: entry.checklist_completed ?? false,
            is_note: collectionId === "notes",
            collection_sort_order:
              collectionId && nextSortOrder !== null ? nextSortOrder + indexWithinCollection(args.ids || [], sourceId) : null,
          });
        }
        mockEntries = nextEntries;
        return;
      }

      if (command === "db_move_entries_to_collection") {
        const collectionId = args.collectionId ?? null;
        const targetCollection = mockCollections.find(
          (collection) => collection.id === collectionId,
        );
        if (targetCollection?.collection_type === "filter") {
          throw new Error("Filter collections cannot store copied or moved entries");
        }
        const nextSortOrder = collectionId
          ? nextCollectionSortOrder(collectionId) ?? 0
          : null;
        mockEntries = mockEntries.map((entry) =>
          (args.ids || []).includes(entry.id)
            ? {
                ...entry,
                collection_id: collectionId,
                checklist_completed: entry.checklist_completed ?? false,
                is_note: collectionId === "notes",
                collection_sort_order:
                  collectionId && nextSortOrder !== null
                    ? nextSortOrder + indexWithinCollection(args.ids || [], entry.id)
                    : null,
              }
            : entry,
        );
        return;
      }

      if (command === "db_list_collection_entries") {
        return mockEntries
          .filter((entry) => entry.collection_id === args.collectionId)
          .sort(collectionEntryComparator(args.collectionId))
          .slice(0, args.limit ?? 200);
      }

      if (command === "db_reorder_collection_entry") {
        const collection = mockCollections.find((item) => item.id === args.collectionId);
        if (!collection) throw new Error(`Collection not found: ${args.collectionId}`);
        const position = String(args.position ?? "before").toLowerCase();
        if (position !== "before" && position !== "after") {
          throw new Error("Position must be 'before' or 'after'");
        }
        const entries = mockEntries
          .filter((entry) => entry.collection_id === args.collectionId)
          .sort(collectionEntryComparator(args.collectionId));
        const source = entries.find((entry) => entry.id === args.entryId);
        const target = entries.find((entry) => entry.id === args.targetEntryId);
        if (!source || !target) throw new Error("Entry not found in collection");
        if (
          collection.collection_type === "checklist" &&
          Boolean(source.checklist_completed) !== Boolean(target.checklist_completed)
        ) {
          throw new Error("Checklist items can only be reordered within the same completion state");
        }
        const group = entries.filter((entry) =>
          collection.collection_type === "checklist"
            ? Boolean(entry.checklist_completed) === Boolean(source.checklist_completed)
            : true,
        );
        const sourceIndex = group.findIndex((entry) => entry.id === args.entryId);
        const targetIndex = group.findIndex((entry) => entry.id === args.targetEntryId);
        const [moved] = group.splice(sourceIndex, 1);
        let insertIndex = targetIndex;
        if (sourceIndex < targetIndex) insertIndex -= 1;
        if (position === "after") insertIndex += 1;
        group.splice(insertIndex, 0, moved);

        const otherGroup = entries.filter((entry) => !group.some((candidate) => candidate.id === entry.id));
        const reordered =
          collection.collection_type === "checklist"
            ? Boolean(source.checklist_completed)
              ? [...otherGroup, ...group]
              : [...group, ...otherGroup]
            : group;

        reordered.forEach((entry, index) => {
          entry.collection_sort_order = index;
        });
        return;
      }

      if (command === "__reset_test_state__") {
        resetMockState();
        return;
      }

      if (command === "search_entries") {
        let results = [...mockEntries];
        const filters = args.filters || {};
        const { terms, filters: inlineFilters } = parseSearchInput(args.query);
        const mergedFilters = { ...inlineFilters, ...filters };
        const mode =
          args.mode === "semantic"
            ? "semantic"
            : args.mode === "hybrid"
              ? "hybrid"
              : "keyword";
        const rankingConfig = normalizeRankingConfig(args.rankingConfig);
        const queryEmbedding = Array.isArray(args.queryEmbedding)
          ? args.queryEmbedding.filter(
              (value: unknown) =>
                typeof value === "number" && Number.isFinite(value),
            )
          : null;

        const filterCollectionId =
          mergedFilters.collection_id ?? mergedFilters.collectionId;
        const filterIsNote = mergedFilters.is_note ?? mergedFilters.isNote;
        const filterSourceApp =
          mergedFilters.source_app ?? mergedFilters.sourceApp;
        const filterDateFrom =
          mergedFilters.date_from ?? mergedFilters.dateFrom;
        const filterDateTo = mergedFilters.date_to ?? mergedFilters.dateTo;

        if (filterIsNote === true) {
          results = results.filter((entry) => entry.is_note === true);
        } else if (filterIsNote === false) {
          results = results.filter((entry) => entry.is_note === false);
        }

        if (filterCollectionId) {
          results = results.filter(
            (entry) => entry.collection_id === filterCollectionId,
          );
        }

        if (mergedFilters.source) {
          results = results.filter(
            (entry) => entry.source === mergedFilters.source,
          );
        }

        if (filterSourceApp) {
          results = results.filter(
            (entry) =>
              (entry.source_app || "").toLowerCase() ===
              String(filterSourceApp).toLowerCase(),
          );
        }

        if (typeof filterDateFrom === "number") {
          results = results.filter(
            (entry) => entry.created_at >= filterDateFrom,
          );
        }

        if (typeof filterDateTo === "number") {
          results = results.filter((entry) => entry.created_at <= filterDateTo);
        }

        if (mergedFilters.tag) {
          results = results.filter((entry) =>
            parseTagsFromEntry(entry).includes(
              String(mergedFilters.tag).toLowerCase(),
            ),
          );
        }

        if (mergedFilters.related_to || mergedFilters.relatedTo) {
          const anchorId = String(mergedFilters.related_to ?? mergedFilters.relatedTo);
          const anchor = mockEntries.find((entry) => entry.id === anchorId);
          if (!anchor) {
            results = [];
          } else {
            const anchorEmbedding = mockEmbeddings.get(anchor.id) ?? null;
            const relatedIds = new Set<string>([anchor.id]);
            if (anchorEmbedding) {
              for (const entry of results) {
                if (entry.id === anchor.id) continue;
                const embedding = mockEmbeddings.get(entry.id) ?? null;
                if (!embedding || embedding.length !== anchorEmbedding.length) continue;
                const rank = cosineSimilarity(anchorEmbedding, embedding);
                if (rank > normalizeRankingConfig(args.rankingConfig).semanticRelevanceThreshold) {
                  relatedIds.add(entry.id);
                }
              }
            } else {
              const anchorTags = new Set(parseTagsFromEntry(anchor));
              for (const entry of results) {
                if (entry.id === anchor.id) {
                  relatedIds.add(entry.id);
                  continue;
                }
                const overlap = parseTagsFromEntry(entry).some((tag) => anchorTags.has(tag));
                if (overlap) relatedIds.add(entry.id);
              }
            }
            results = results.filter((entry) => relatedIds.has(entry.id));
          }
        }

        const appliedFilters = Object.entries(mergedFilters)
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([key, value]) => `${key}:${String(value)}`);

        const keywordMatches =
          terms.length > 0
            ? results.filter((entry) => {
                const haystack = [
                  entry.content,
                  entry.label,
                  entry.manual_badges,
                  entry.source_app,
                  entry.import_name,
                ]
                  .filter(Boolean)
                  .join(" ")
                  .toLowerCase();

                return terms.every((term) => haystack.includes(term));
              })
            : [...results];

        if (
          mode === "hybrid" &&
          queryEmbedding &&
          queryEmbedding.length > 0 &&
          terms.length > 0
        ) {
          const weights = hybridWeights(args.query, terms, rankingConfig);
          const fused = new Map<string, any>();
          const semanticMatches = results
            .map((entry) => {
              const embedding = mockEmbeddings.get(entry.id) ?? null;
              if (!embedding || embedding.length !== queryEmbedding.length)
                return null;
              const score = cosineSimilarity(queryEmbedding, embedding);
              if (score < rankingConfig.semanticRelevanceThreshold) return null;
              return {
                entry,
                score,
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .sort(
              (left, right) =>
                right.score - left.score ||
                right.entry.created_at - left.entry.created_at,
            );

          keywordMatches
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .forEach((entry: any, index: number) => {
              const existing = fused.get(entry.id) || {
                entry,
                rank: 0,
                match_reasons: [],
                matched_terms: terms,
                matched_tags: mergedFilters.tag
                  ? [String(mergedFilters.tag).toLowerCase()]
                  : [],
                diagnostics: {
                  query_text: args.query || null,
                  fts_query: args.query || null,
                  applied_filters: appliedFilters,
                  bm25: -1,
                  search_mode: "hybrid",
                  cosine_similarity: null,
                  semantic_fallback_reason: null,
                  keyword_rank: null,
                  semantic_rank: null,
                  keyword_weight: null,
                  semantic_weight: null,
                  keyword_rrf_score: null,
                  semantic_rrf_score: null,
                  recency_max_boost: rankingConfig.recencyBoostMax,
                  rrf_k: rankingConfig.rrfK,
                  recency_boost: 0,
                  fused_score: 0,
                },
              };
              const keywordRrfScore = weightedRrfScore(
                weights.keyword,
                index,
                rankingConfig,
              );
              existing.rank += keywordRrfScore;
              existing.match_reasons = Array.from(
                new Set([...existing.match_reasons, "keyword"]),
              );
              existing.diagnostics.keyword_rank = index + 1;
              existing.diagnostics.keyword_weight = weights.keyword;
              existing.diagnostics.keyword_rrf_score = keywordRrfScore;
              fused.set(entry.id, existing);
            });

          semanticMatches.forEach((item, index) => {
            const existing = fused.get(item.entry.id) || {
              entry: item.entry,
              rank: 0,
              match_reasons: [],
              matched_terms: terms,
              matched_tags: mergedFilters.tag
                ? [String(mergedFilters.tag).toLowerCase()]
                : [],
              diagnostics: {
                query_text: args.query || null,
                fts_query: args.query || null,
                applied_filters: appliedFilters,
                bm25: null,
                search_mode: "hybrid",
                cosine_similarity: null,
                semantic_fallback_reason: null,
                keyword_rank: null,
                semantic_rank: null,
                keyword_weight: null,
                semantic_weight: null,
                keyword_rrf_score: null,
                semantic_rrf_score: null,
                recency_max_boost: rankingConfig.recencyBoostMax,
                rrf_k: rankingConfig.rrfK,
                recency_boost: 0,
                fused_score: 0,
              },
            };
            const semanticRrfScore = weightedRrfScore(
              weights.semantic,
              index,
              rankingConfig,
            );
            existing.rank += semanticRrfScore;
            existing.match_reasons = Array.from(
              new Set([...existing.match_reasons, "semantic"]),
            );
            existing.diagnostics.semantic_rank = index + 1;
            existing.diagnostics.semantic_weight = weights.semantic;
            existing.diagnostics.semantic_rrf_score = semanticRrfScore;
            existing.diagnostics.cosine_similarity = item.score;
            fused.set(item.entry.id, existing);
          });

          const values = [...fused.values()];
          const newest = Math.max(
            ...values.map((item) => item.entry.created_at),
          );
          const oldest = Math.min(
            ...values.map((item) => item.entry.created_at),
          );
          const span = Math.max(1, newest - oldest);
          return values
            .map((item) => {
              const recencyBoost =
                ((item.entry.created_at - oldest) / span) *
                rankingConfig.recencyBoostMax;
              const reasons =
                rankingConfig.recencyBoostMax > 0 &&
                recencyBoost >= rankingConfig.recencyBoostMax * 0.8
                  ? Array.from(new Set([...item.match_reasons, "recent"]))
                  : item.match_reasons;
              const rank = item.rank + recencyBoost;
              return {
                entry: item.entry,
                rank,
                match_type:
                  item.diagnostics.keyword_rank &&
                  item.diagnostics.semantic_rank
                    ? "hybrid"
                    : item.diagnostics.keyword_rank
                      ? "keyword"
                      : "semantic",
                match_reasons: reasons,
                matched_terms: item.matched_terms,
                matched_tags: item.matched_tags,
                diagnostics: {
                  ...item.diagnostics,
                  recency_max_boost: rankingConfig.recencyBoostMax,
                  rrf_k: rankingConfig.rrfK,
                  recency_boost: recencyBoost,
                  fused_score: rank,
                },
              };
            })
            .sort(
              (left, right) =>
                right.rank - left.rank ||
                right.entry.created_at - left.entry.created_at,
            )
            .slice(0, args.limit ?? 100);
        }

        if (
          mode === "semantic" &&
          queryEmbedding &&
          queryEmbedding.length > 0
        ) {
          return results
            .map((entry) => {
              const embedding = mockEmbeddings.get(entry.id) ?? null;
              if (!embedding || embedding.length !== queryEmbedding.length)
                return null;
              const score = cosineSimilarity(queryEmbedding, embedding);
              if (score < rankingConfig.semanticRelevanceThreshold) return null;

              return {
                entry,
                rank: score,
                match_type: "semantic",
                match_reasons: ["semantic"],
                matched_terms: terms,
                matched_tags: mergedFilters.tag
                  ? [String(mergedFilters.tag).toLowerCase()]
                  : [],
                diagnostics: {
                  query_text: args.query || null,
                  fts_query: null,
                  applied_filters: [...appliedFilters, "has_embedding:true"],
                  bm25: null,
                  search_mode: "semantic",
                  cosine_similarity: score,
                  semantic_fallback_reason: null,
                  keyword_rank: null,
                  semantic_rank: null,
                  keyword_weight: null,
                  semantic_weight: null,
                  keyword_rrf_score: null,
                  semantic_rrf_score: null,
                  recency_max_boost: null,
                  rrf_k: null,
                  recency_boost: null,
                  fused_score: null,
                },
              };
            })
            .filter(
              (result): result is NonNullable<typeof result> => result !== null,
            )
            .sort(
              (left, right) =>
                right.rank - left.rank ||
                right.entry.created_at - left.entry.created_at,
            )
            .slice(0, args.limit ?? 100)
            .map((result) => ({
              ...result,
              diagnostics: {
                ...result.diagnostics,
                cosine_similarity: result.rank,
              },
            }));
        }

        results = keywordMatches;

        results = results
          .sort((a: any, b: any) => b.created_at - a.created_at)
          .slice(0, args.limit ?? 100)
          .map((entry) => ({
            entry,
            rank: terms.length > 0 ? 1 : 0,
            match_type: terms.length > 0 ? "keyword" : "filters_only",
            match_reasons: terms.length > 0 ? ["keyword"] : [],
            matched_terms: terms,
            matched_tags: mergedFilters.tag
              ? [String(mergedFilters.tag).toLowerCase()]
              : [],
            diagnostics: {
              query_text: args.query || null,
              fts_query: args.query || null,
              applied_filters: appliedFilters,
              bm25: terms.length > 0 ? -1 : null,
              search_mode: "keyword",
              cosine_similarity: null,
              semantic_fallback_reason:
                mode === "semantic" ? "missing_query_embedding" : null,
              keyword_rank: null,
              semantic_rank: null,
              keyword_weight: null,
              semantic_weight: null,
              keyword_rrf_score: null,
              semantic_rrf_score: null,
              recency_max_boost: null,
              rrf_k: null,
              recency_boost: null,
              fused_score: null,
            },
          }));

        return results;
      }

      if (command === "get_related_entries") {
        const anchor = mockEntries.find((entry) => entry.id === args.entryId);
        if (!anchor) throw new Error(`Entry not found: ${args.entryId}`);

        const filters = args.filters || {};
        let results = mockEntries.filter((entry) => entry.id !== anchor.id);

        if (filters.is_note === true) {
          results = results.filter((entry) => entry.is_note === true);
        } else if (filters.is_note === false) {
          results = results.filter((entry) => entry.is_note === false);
        }

        if (filters.source) {
          results = results.filter((entry) => entry.source === filters.source);
        }

        if (filters.source_app) {
          results = results.filter(
            (entry) =>
              (entry.source_app || "").toLowerCase() ===
              String(filters.source_app).toLowerCase(),
          );
        }

        if (typeof filters.date_from === "number") {
          results = results.filter(
            (entry) => entry.created_at >= filters.date_from,
          );
        }

        if (typeof filters.date_to === "number") {
          results = results.filter(
            (entry) => entry.created_at <= filters.date_to,
          );
        }

        if (filters.tag) {
          results = results.filter((entry) =>
            parseTagsFromEntry(entry).includes(
              String(filters.tag).toLowerCase(),
            ),
          );
        }

        const anchorEmbedding = mockEmbeddings.get(anchor.id) ?? null;
        const related = anchorEmbedding
          ? results
              .map((entry) => {
                const embedding = mockEmbeddings.get(entry.id) ?? null;
                if (!embedding || embedding.length !== anchorEmbedding.length)
                  return null;
                const rank = cosineSimilarity(anchorEmbedding, embedding);
                return {
                  entry,
                  rank,
                  match_type: "related_semantic",
                  match_reasons: ["semantic"],
                  matched_terms: [],
                  matched_tags: [],
                  diagnostics: {
                    query_text: null,
                    fts_query: null,
                    applied_filters: Object.keys(filters),
                    bm25: null,
                    search_mode: "semantic",
                    cosine_similarity: rank,
                    semantic_fallback_reason: null,
                    keyword_rank: null,
                    semantic_rank: null,
                    keyword_weight: null,
                    semantic_weight: null,
                    keyword_rrf_score: null,
                    semantic_rrf_score: null,
                    recency_max_boost: null,
                    rrf_k: null,
                    recency_boost: null,
                    fused_score: null,
                  },
                };
              })
              .filter(
                (result): result is NonNullable<typeof result> =>
                  result !== null,
              )
          : results.map((entry) => ({
              entry,
              rank: parseTagsFromEntry(entry).filter((tag) =>
                parseTagsFromEntry(anchor).includes(tag),
              ).length,
              match_type: "related_fallback",
              match_reasons:
                parseTagsFromEntry(entry).filter((tag) =>
                  parseTagsFromEntry(anchor).includes(tag),
                ).length > 0
                  ? ["related-via-tag"]
                  : [],
              matched_terms: [],
              matched_tags: parseTagsFromEntry(entry).filter((tag) =>
                parseTagsFromEntry(anchor).includes(tag),
              ),
              diagnostics: {
                query_text: null,
                fts_query: null,
                applied_filters: Object.keys(filters),
                bm25: null,
                search_mode: "keyword",
                cosine_similarity: null,
                semantic_fallback_reason: "anchor_embedding_unavailable",
                keyword_rank: null,
                semantic_rank: null,
                keyword_weight: null,
                semantic_weight: null,
                keyword_rrf_score: null,
                semantic_rrf_score: null,
                recency_max_boost: null,
                rrf_k: null,
                recency_boost: null,
                fused_score: null,
              },
            }));

        return related
          .sort(
            (left, right) =>
              right.rank - left.rank ||
              right.entry.created_at - left.entry.created_at,
          )
          .slice(0, args.limit ?? 12);
      }

      if (command === "rebuild_search_indexes") {
        return {
          indexed_entries: mockEntries.length,
          indexed_tags: mockEntries.reduce(
            (total, entry) => total + parseTagsFromEntry(entry).length,
            0,
          ),
        };
      }

      if (command === "db_update_entry_classification") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.label = args.label;
          entry.label_score = args.labelScore;
          if (args.embedding) {
            const parsed = parseEmbeddingValue(args.embedding);
            if (parsed) mockEmbeddings.set(entry.id, parsed);
          }
        }
        return;
      }

      if (command === "db_update_entry_embedding") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry && args.embedding) {
          const parsed = parseEmbeddingValue(args.embedding);
          if (parsed) mockEmbeddings.set(entry.id, parsed);
        }
        return;
      }

      if (command === "db_update_entry_secret") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.secret_verdict = args.secretVerdict;
          entry.secret_type = args.secretType;
          entry.secret_source = args.secretSource;
        }
        return;
      }

      if (command === "db_update_entry_enrichment") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.summary = args.summary ?? null;
          entry.enrichment_tags = args.enrichmentTags ?? null;
        }
        return;
      }

      if (command === "db_replace_generated_tags") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.tags_json = args.tagsJson ?? null;
        }
        return;
      }

      if (command === "db_update_entry_processing_diagnostics") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.processing_diagnostics = args.processingDiagnostics ?? null;
        }
        return;
      }

      if (command === "db_set_entry_checklist_completed") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.checklist_completed = Boolean(args.checklistCompleted);
          if (entry.collection_id) {
            normalizeCollectionOrders(entry.collection_id);
          }
        }
        return;
      }

      if (command === "db_update_collection_type") {
        const collection = mockCollections.find((item) => item.id === args.id);
        if (!collection) {
          throw new Error(`Collection not found: ${args.id}`);
        }
        collection.collection_type =
          args.collectionType === "checklist"
            ? "checklist"
            : args.collectionType === "filter"
              ? "filter"
              : "standard";
        collection.filter_query =
          collection.collection_type === "filter"
            ? String(args.filterQuery ?? "").trim() || null
            : null;
        collection.updated_at = Date.now();
        return;
      }

      if (command === "db_reorder_collection") {
        const sourceIndex = mockCollections.findIndex(
          (collection) => collection.id === args.collectionId,
        );
        const targetIndex = mockCollections.findIndex(
          (collection) => collection.id === args.targetCollectionId,
        );
        if (sourceIndex === -1 || targetIndex === -1) {
          throw new Error("Collection not found");
        }
        if (sourceIndex === targetIndex) return;

        const reordered = [...mockCollections];
        const [source] = reordered.splice(sourceIndex, 1);
        let insertIndex = reordered.findIndex(
          (collection) => collection.id === args.targetCollectionId,
        );
        if (args.position === "after") insertIndex += 1;
        reordered.splice(insertIndex, 0, source);
        mockCollections = reordered.map((collection, index) => ({
          ...collection,
          sort_order: index,
        }));
        return;
      }

      if (command === "db_rename_collection") {
        const collection = mockCollections.find((item) => item.id === args.id);
        if (!collection) {
          throw new Error(`Collection not found: ${args.id}`);
        }

        const trimmedName = String(args.name ?? "").trim();
        if (!trimmedName) {
          throw new Error("Collection name cannot be empty");
        }
        if (collection.kind === "system") {
          throw new Error(`${collection.name} cannot be renamed`);
        }

        collection.name = trimmedName;
        collection.slug = nextMockCollectionSlug(trimmedName, collection.id);
        collection.updated_at = Date.now();
        return collection;
      }

      if (command === "db_duplicate_collection") {
        const source = mockCollections.find((item) => item.id === args.id);
        if (!source) {
          throw new Error(`Collection not found: ${args.id}`);
        }

        const duplicated = {
          ...source,
          id: `collection-${nextId++}`,
          slug: nextMockCollectionSlug(nextMockCollectionName(source.name)),
          name: nextMockCollectionName(source.name),
          kind: "user",
          sort_order: mockCollections.length,
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        mockCollections.push(duplicated);

        const sourceEntries = mockEntries.filter(
          (entry) => entry.collection_id === source.id,
        );
        for (const entry of sourceEntries) {
          mockEntries.push({
            ...entry,
            id: `copy-${nextId++}`,
            collection_id: duplicated.id,
            checklist_completed: entry.checklist_completed ?? false,
            is_note: duplicated.id === "notes",
            collection_sort_order: nextCollectionSortOrder(duplicated.id),
          });
        }

        return duplicated;
      }

      if (command === "db_set_secret_verdict_bulk") {
        mockEntries = mockEntries.map((entry) =>
          (args.ids || []).includes(entry.id)
            ? {
                ...entry,
                secret_verdict: args.secretVerdict,
                secret_type: args.secretType,
                secret_source: args.secretSource,
              }
            : entry,
        );
        return;
      }

      if (command === "db_clear_entry_label") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.label = null;
          entry.label_score = null;
        }
        return;
      }

      if (command === "db_add_manual_badge") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          const normalized = String(args.badge ?? "")
            .trim()
            .toLowerCase();
          if (!normalized) return;
          const existing: Array<{ name: string; color: string }> =
            entry.manual_badges ? JSON.parse(entry.manual_badges) : [];
          if (
            !existing.some((b) =>
              typeof b === "string" ? b === normalized : b.name === normalized,
            )
          ) {
            existing.push({ name: normalized, color: args.color || "default" });
            entry.manual_badges = JSON.stringify(existing);
          }
        }
        return;
      }

      if (command === "db_add_manual_badge_bulk") {
        for (const id of args.ids || []) {
          const entry = mockEntries.find((e) => e.id === id);
          if (!entry) continue;
          const normalized = String(args.badge ?? "")
            .trim()
            .toLowerCase();
          if (!normalized) continue;
          const existing: Array<{ name: string; color: string }> =
            entry.manual_badges ? JSON.parse(entry.manual_badges) : [];
          if (!existing.some((badge) => badge.name === normalized)) {
            existing.push({ name: normalized, color: args.color || "default" });
            entry.manual_badges = JSON.stringify(existing);
          }
        }
        return;
      }

      if (command === "db_remove_manual_badge") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          const normalized = String(args.badge ?? "")
            .trim()
            .toLowerCase();
          const existing: Array<{ name: string; color: string } | string> =
            entry.manual_badges ? JSON.parse(entry.manual_badges) : [];
          const updated = existing.filter(
            (b) => (typeof b === "string" ? b : b.name) !== normalized,
          );
          entry.manual_badges =
            updated.length > 0 ? JSON.stringify(updated) : null;
        }
        return;
      }

      if (command === "db_promote_to_note") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.is_note = true;
          entry.collection_id = "notes";
          entry.collection_sort_order = nextCollectionSortOrder("notes");
          normalizeCollectionOrders("notes");
        }
        return;
      }

      if (command === "db_demote_from_note") {
        const entry = mockEntries.find((e) => e.id === args.id);
        if (entry) {
          entry.is_note = false;
          entry.collection_id = null;
          entry.collection_sort_order = null;
        }
        return;
      }

      if (command === "db_get_entry_embedding") {
        const embedding = mockEmbeddings.get(args.id) ?? null;
        return embedding;
      }

      if (command === "db_delete_entry") {
        mockEntries = mockEntries.filter((e) => e.id !== args.id);
        mockEmbeddings.delete(args.id);
        return;
      }

      if (command === "db_delete_entries") {
        const ids = new Set(args.ids || []);
        mockEntries = mockEntries.filter((e) => !ids.has(e.id));
        for (const id of ids) {
          if (typeof id === "string") mockEmbeddings.delete(id);
        }
        return;
      }

      if (command === "secret_masker_scan") {
        // Mock: the ML model is not available in test environment
        return { spans: [], has_secrets: false, top_score: 0.0 };
      }

      if (command === "trufflehog_check") {
        return {
          available: true,
          path: "mock-trufflehog",
          version: "mock-1.0.0",
          supports_stdin: true,
        };
      }

      if (command === "trufflehog_scan") {
        const text = String(args?.text ?? "");

        if (/\bsk-[a-zA-Z0-9]{48}\b/.test(text)) {
          return [
            {
              detector_name: "OpenAI",
              verified: true,
              raw_redacted: "sk-abcdefgh****IJKL",
              decoder: "PLAIN",
            },
          ];
        }

        if (/\bsk_(?:live|test)_[0-9a-zA-Z]{24}\b/.test(text)) {
          return [
            {
              detector_name: "Stripe",
              verified: true,
              raw_redacted: "sk_live_****",
              decoder: "PLAIN",
            },
          ];
        }

        if (
          /\beyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+\b/.test(
            text,
          )
        ) {
          return [
            {
              detector_name: "JWT",
              verified: false,
              raw_redacted: "eyJ****",
              decoder: "PLAIN",
            },
          ];
        }

        if (
          /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(text)
        ) {
          return [
            {
              detector_name: "PrivateKey",
              verified: false,
              raw_redacted: "-----BEGIN PRIVATE KEY-----",
              decoder: "PLAIN",
            },
          ];
        }

        return [];
      }

      if (command === "heuristic_tag") {
        const text = String(args?.text ?? "").trim();
        const matches: Array<{ label: string; reason: string }> = [];
        if (text.length === 0) {
          return { matches };
        }
        if (/^https?:\/\/\S+$/.test(text)) {
          matches.push({ label: "url", reason: "obvious_url" });
        }
        if (/^(git|npm|pnpm|yarn|cargo|python3?|node|curl|docker|kubectl)\b/.test(text)) {
          matches.push({ label: "command", reason: "obvious_command" });
        }
        if (/\b(fn|function|const|let|class|interface|import|export)\b/.test(text)) {
          matches.push({ label: "code", reason: "obvious_code" });
        }
        if (text.startsWith("{") && text.endsWith("}")) {
          matches.push({ label: "data", reason: "obvious_structured_data" });
        }
        return { matches };
      }

      if (command === "qwen_generate_tags") {
        return {
          raw_response: '{"tags":["mocked","local-qwen"]}',
          model_id: "qwen2.5-0.5b-instruct (mock)",
          prompt_tps: 0,
          completion_tps: 0,
        };
      }

      if (command === "qwen_status") {
        return {
          loaded: false,
          model_id: "qwen2.5-0.5b-instruct (mock)",
          model_path: "mock-qwen.gguf",
          model_exists: true,
          chat_template_path: "mock-chat-template.jinja",
          chat_template_exists: true,
        };
      }

      if (command === "qwen_prefetch") {
        return null;
      }

      if (command === "generate_embedding") {
        const text = String(args?.text ?? "");
        return new Array(384).fill(0).map((_, i) => {
          const seed = (text.charCodeAt(i % text.length) || 1) * (i + 1);
          return Math.sin(seed) * 0.5;
        });
      }

      if (command === "reembed_all_entries") {
        return { total: 0, succeeded: 0, failed: 0 };
      }

      if (command === "db_init") return;

      throw new Error(`Mocked invoke does not support ${command}`);
});

beforeEach(() => {
  invokeMock.mockClear();
});

vi.mock("@tauri-apps/api/core", () => {
  return {
    invoke: invokeMock,
  };
});

vi.mock("@tauri-apps/api/event", () => {
  return {
    listen: async () => () => {},
    emit: async () => {},
  };
});

vi.mock("../src/logger", () => {
  return {
    debugLog: (msg: string, level: string) => console.log(`[${level}] ${msg}`),
    configureDebugLogging: () => {},
    isDebugLoggingEnabled: () => true,
    openDebugLogFolder: async () => {},
  };
});
