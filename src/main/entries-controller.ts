import { applyIcons, showToast } from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import type { ScribeDom } from "./dom";
import type { Settings } from "../settings";
import type { EntryRow } from "../store";
import {
  cosineSimilarity,
  formatRelativeTime,
  parseEmbedding,
  sourceIcon,
} from "../store";
import { getEmbedding } from "../embedding";

const ENTRIES_LIMIT = 200;

let allEntries: EntryRow[] = [];
let currentRenderedCount = 0;
let selectedEntryId: string | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let getSettings: () => Settings;
let dom: ScribeDom;

export function initEntriesController(
  d: ScribeDom,
  settingsGetter: () => Settings
): void {
  dom = d;
  getSettings = settingsGetter;
}

export async function loadEntries(search?: string): Promise<void> {
  try {
    allEntries = await invoke<EntryRow[]>("db_list_entries", {
      search: search ?? null,
      limit: ENTRIES_LIMIT,
    });
    renderList(allEntries);
  } catch (err) {
    console.error("Failed to load entries:", err);
  }
}

export function handleSearchInput(query: string): void {
  dom.searchClearBtn.hidden = query.length === 0;

  if (searchDebounce !== null) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchDebounce = null;
    runSearch(query.trim());
  }, 300);
}

async function runSearch(query: string): Promise<void> {
  if (query.length === 0) {
    await loadEntries();
    return;
  }

  const settings = getSettings();
  
  // Parse label filter: label:code
  let labelFilter: string | null = null;
  let cleanQuery = query;

  const labelMatch = query.match(/label:(\w+)/);
  if (labelMatch) {
    labelFilter = labelMatch[1].toLowerCase();
    cleanQuery = cleanQuery.replace(labelMatch[0], "").trim();
  }

  // If semantic search is possible
  if (settings.embeddingProvider !== "none" && cleanQuery.length >= 3) {
    try {
      const queryVec = await getEmbedding(cleanQuery, settings);
      const withEmbeddings = await invoke<EntryRow[]>("db_get_embeddings");

      let filtered = withEmbeddings;
      if (labelFilter) {
        filtered = filtered.filter(e => e.label?.toLowerCase() === labelFilter);
      }

      const scored = filtered
        .map((entry) => ({
          entry,
          score: cosineSimilarity(queryVec, parseEmbedding(entry.embedding) ?? []),
        }))
        .filter((r) => r.score > 0.25)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40)
        .map((r) => r.entry);

      renderList(scored);
      return;
    } catch {
      // Fall through
    }
  }

  // Keyword search fallback with label filter
  const keywordResults = await invoke<EntryRow[]>("db_list_entries", {
    search: cleanQuery || null,
    limit: 100,
  });

  let filtered = keywordResults;
  if (labelFilter) {
    filtered = filtered.filter(e => e.label?.toLowerCase() === labelFilter);
  }

  renderList(filtered);
}

function renderList(entries: EntryRow[]): void {
  currentRenderedCount = entries.length;
  dom.entriesList.replaceChildren();

  const hasEntries = entries.length > 0;
  dom.entriesEmpty.hidden = hasEntries;

  const placeholder = document.getElementById("entry-detail-placeholder") as HTMLElement | null;

  if (!hasEntries) {
    if (placeholder) placeholder.hidden = true;
    dom.entryDetail.hidden = true;
    selectedEntryId = null;
  } else if (selectedEntryId === null) {
    if (placeholder) placeholder.hidden = false;
  }

  for (const entry of entries) {
    const item = buildEntryItem(entry);
    dom.entriesList.appendChild(item);
  }
  applyIcons();
}

function buildEntryItem(entry: EntryRow): HTMLElement {
  const item = document.createElement("div");
  item.className = `entry-item${selectedEntryId === entry.id ? " is-selected" : ""}`;
  item.dataset.id = entry.id;

  let preview = entry.content.length > 140
    ? entry.content.slice(0, 140).trimEnd() + "…"
    : entry.content;

  const labelBadge = entry.label && entry.label !== "other" 
    ? `<span class="badge badge-primary">${escapeHtml(entry.label)}</span>` 
    : "";

  const appInfo = entry.source_app ? `<span class="hint">via ${escapeHtml(entry.source_app)}</span>` : "";

  item.innerHTML = `
    <div class="entry-item-header">
      <i data-lucide="${sourceIcon(entry.source)}" class="entry-source-icon"></i>
      <span class="entry-time hint">${formatRelativeTime(entry.created_at)}</span>
      ${appInfo}
      ${labelBadge}
    </div>
    <p class="entry-preview">${escapeHtml(preview)}</p>
  `;

  item.addEventListener("click", () => selectEntry(entry));
  return item;
}

function selectEntry(entry: EntryRow): void {
  selectedEntryId = entry.id;

  dom.entriesList.querySelectorAll(".entry-item").forEach((el) => {
    el.classList.toggle("is-selected", (el as HTMLElement).dataset.id === entry.id);
  });

  dom.entryDetailContent.textContent = entry.content;

  const labelInfo = entry.label 
    ? `<span class="badge badge-primary">${escapeHtml(entry.label)}</span> <span class="hint">(${Math.round((entry.label_score || 0) * 100)}%)</span>` 
    : "";

  const sourceAppInfo = entry.source_app ? `<span class="hint">via ${escapeHtml(entry.source_app)}</span>` : "";

  dom.entryDetailMeta.innerHTML = `
    <div class="row gap-2" style="align-items:center; flex-wrap: wrap;">
      <span class="hint">${new Date(entry.created_at).toLocaleString()}</span>
      <span class="hint">·</span>
      <span class="hint">${entry.source}</span>
      ${sourceAppInfo}
      ${labelInfo}
    </div>
  `;

  dom.entryDetail.hidden = false;
  document.getElementById("entry-detail-placeholder")!.hidden = true;
  dom.entryDetailDelete.dataset.id = entry.id;
  applyIcons();
}

export function clearSelection(): void {
  selectedEntryId = null;
  dom.entryDetail.hidden = true;
  const placeholder = document.getElementById("entry-detail-placeholder") as HTMLElement | null;
  if (placeholder) placeholder.hidden = currentRenderedCount === 0;
  dom.entriesEmpty.hidden = currentRenderedCount > 0;
}

export async function addEntry(
  content: string,
  source: "manual" | "clipboard",
  html_content: string | null = null,
  sourceApp: string | null = null
): Promise<string> {
  const id = await invoke<string>("db_add_entry", {
    content,
    htmlContent: html_content,
    source,
    sourceApp,
    createdAt: Date.now(),
  });

  await loadEntries(dom.searchInput.value.trim() || undefined);
  void processEntryBackground(id, content);
  return id;
}

export async function deleteSelectedEntry(): Promise<void> {
  const id = dom.entryDetailDelete.dataset.id;
  if (!id) return;
  await invoke("db_delete_entry", { id });
  clearSelection();
  await loadEntries(dom.searchInput.value.trim() || undefined);
  showToast("Entry deleted", "success", 1200);
}

async function processEntryBackground(id: string, content: string): Promise<void> {
  try {
    const result = await invoke<{
      label: string;
      label_score: number;
      embedding: number[];
    }>("classify_text", { text: content });

    await invoke("db_update_entry_classification", {
      id,
      label: result.label,
      labelScore: result.label_score,
      embedding: JSON.stringify(result.embedding),
    });

    await loadEntries(dom.searchInput.value.trim() || undefined);
  } catch (err) {
    console.warn("Background processing failed:", err);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
