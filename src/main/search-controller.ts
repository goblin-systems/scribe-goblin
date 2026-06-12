import { invoke } from "@tauri-apps/api/core";
import { debugLog } from "../logger";
import type { Settings } from "../settings";
import { normalizeSearchEntryResults } from "../store";
import type { SearchEntryResult, SearchEntryResultPayload, SearchFilters } from "../store";

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface SearchRequest {
  query: string | null;
  filters: SearchFilters;
  limit: number;
}

function shouldAttemptHybridSearch(query: string | null): boolean {
  return Boolean(query && query.trim().length > 0);
}

async function buildQueryEmbedding(query: string): Promise<number[] | null> {
  try {
    return await invoke<number[]>("generate_embedding", { text: query });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Semantic query embedding unavailable: ${message}`, "WARN");
    return null;
  }
}

export async function searchEntries(
  request: SearchRequest,
  settings: Settings,
): Promise<SearchEntryResult[]> {
  const trimmedQuery = request.query?.trim() ?? null;
  const mode: SearchMode = shouldAttemptHybridSearch(trimmedQuery) ? "hybrid" : "keyword";
  const queryEmbedding = mode === "hybrid" && trimmedQuery
    ? await buildQueryEmbedding(trimmedQuery)
    : null;

  const results = await invoke<SearchEntryResultPayload[]>("search_entries", {
    query: trimmedQuery,
    filters: request.filters,
    limit: request.limit,
    mode,
    queryEmbedding,
    rankingConfig: settings.ranking,
  });

  return normalizeSearchEntryResults(results);
}
