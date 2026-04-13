import { applyIcons, showToast } from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { ScribeDom } from "./dom";
import type { Settings } from "../settings";
import type { EntryRow } from "../store";
import {
  cosineSimilarity,
  formatRelativeTime,
  parseEmbedding,
  parseManualBadges,
  sourceIcon,
} from "../store";
import { getEmbedding } from "../embedding";
import { debugLog } from "../logger";
import { scan } from "../secret-detection/index";

const NOTES_LIMIT = 200;

let allNotes: EntryRow[] = [];
let currentRenderedCount = 0;
let selectedNoteId: string | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let getSettings: () => Settings;
let dom: ScribeDom;

export function initNotesController(
  d: ScribeDom,
  settingsGetter: () => Settings
): void {
  dom = d;
  getSettings = settingsGetter;
  setupBadgeRemoveDelegation();
}

export async function loadNotes(search?: string): Promise<void> {
  try {
    allNotes = await invoke<EntryRow[]>("db_list_entries", {
      search: search ?? null,
      limit: NOTES_LIMIT,
      isNote: true,
    });
    renderList(allNotes);
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
    await loadNotes();
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
        filtered = filtered.filter((entry) => hasBadge(entry, labelFilter));
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
    isNote: true,
  });

  let filtered = keywordResults;
  if (labelFilter) {
    filtered = filtered.filter((entry) => hasBadge(entry, labelFilter));
  }

  renderList(filtered);
}

function renderList(entries: EntryRow[]): void {
  currentRenderedCount = entries.length;
  dom.notesList.replaceChildren();

  const hasEntries = entries.length > 0;
  dom.notesEmpty.hidden = hasEntries;

  if (!hasEntries) {
    dom.noteDetailPlaceholder.hidden = true;
    dom.noteDetail.hidden = true;
    selectedNoteId = null;
  } else if (selectedNoteId === null) {
    dom.noteDetailPlaceholder.hidden = false;
  }

  for (const entry of entries) {
    const item = buildNoteItem(entry);
    dom.notesList.appendChild(item);
  }

  const selectedNote = selectedNoteId === null
    ? null
    : entries.find((entry) => entry.id === selectedNoteId) ?? null;
  if (selectedNote) {
    selectNote(selectedNote);
  } else if (selectedNoteId !== null) {
    clearSelection();
  }

  applyIcons();
}

function buildNoteItem(entry: EntryRow): HTMLElement {
  const item = document.createElement("div");
  item.className = `note-item${selectedNoteId === entry.id ? " is-selected" : ""}`;
  item.dataset.id = entry.id;

  let preview = entry.content.length > 140
    ? entry.content.slice(0, 140).trimEnd() + "…"
    : entry.content;

  const isSecret = entry.secret_verdict && entry.secret_verdict !== "not_secret";
  const displayPreview = isSecret ? "•".repeat(Math.min(entry.content.length, 32)) : escapeHtml(preview);

  const badgeHtml = renderBadgeHtml(entry);

  const secretBadge = entry.secret_verdict && entry.secret_verdict !== "not_secret"
    ? `<span class="badge" style="background:rgba(255,0,0,0.15);color:#ff6b6b;">${entry.secret_verdict === "secret" ? "secret" : "likely secret"}</span>`
    : "";

  const appInfo = entry.source_app ? `<span class="hint">via ${escapeHtml(entry.source_app)}</span>` : "";

  item.innerHTML = `
    <div class="note-item-header">
      <i data-lucide="${sourceIcon(entry.source)}" class="note-source-icon"></i>
      <span class="note-time hint">${formatRelativeTime(entry.created_at)}</span>
      ${appInfo}
      ${badgeHtml}
      ${secretBadge}
    </div>
    <p class="note-preview">${displayPreview}</p>
  `;

  item.addEventListener("click", () => selectNote(entry));
  return item;
}

function selectNote(entry: EntryRow): void {
  selectedNoteId = entry.id;

  dom.notesList.querySelectorAll(".note-item").forEach((el) => {
    el.classList.toggle("is-selected", (el as HTMLElement).dataset.id === entry.id);
  });

  const isSecret = entry.secret_verdict && entry.secret_verdict !== "not_secret";
  if (isSecret) {
    dom.noteDetailContent.innerHTML = `
      <div class="masked-content-row">
        <span class="masked-text">${"•".repeat(Math.min(entry.content.length, 40))}</span>
        <button class="icon-btn icon-btn-sm" id="reveal-secret-btn" type="button" title="Reveal secret" aria-label="Reveal secret">
          <i data-lucide="eye"></i>
        </button>
      </div>
    `;
    const revealBtn = document.getElementById("reveal-secret-btn");
    if (revealBtn) {
      revealBtn.addEventListener("click", () => {
        dom.noteDetailContent.textContent = entry.content;
      });
    }
  } else {
    dom.noteDetailContent.textContent = entry.content;
  }

  const labelInfo = renderDetailBadgeHtml(entry);

  const sourceAppInfo = entry.source_app ? `<span class="hint">via ${escapeHtml(entry.source_app)}</span>` : "";

  dom.noteDetailMeta.innerHTML = `
    <div class="row gap-2" style="align-items:center; flex-wrap: wrap;">
      <span class="hint">${new Date(entry.created_at).toLocaleString()}</span>
      <span class="hint">·</span>
      <span class="hint">${entry.source}</span>
      ${sourceAppInfo}
      ${labelInfo}
    </div>
  `;

  // Show secret detection warning if applicable
  if (entry.secret_verdict && entry.secret_verdict !== "not_secret") {
    const verdictLabel = entry.secret_verdict === "secret" ? "🔴 Secret Detected" : "🟡 Likely Secret";
    const typeLabel = entry.secret_type || "unknown";
    dom.noteDetailSecretActions.innerHTML = `
      <div class="secret-banner">
        <span style="font-weight:600;">${verdictLabel}</span>
        <span class="hint">(${escapeHtml(typeLabel)} · via ${escapeHtml(entry.secret_source || "unknown")})</span>
      </div>
    `;
    dom.noteDetailSecretActions.hidden = false;
  } else {
    dom.noteDetailSecretActions.hidden = true;
  }

  dom.noteDetail.hidden = false;
  dom.noteDetailPlaceholder.hidden = true;
  dom.noteDetailDelete.dataset.id = entry.id;
  applyIcons();
}

export function clearSelection(): void {
  selectedNoteId = null;
  dom.noteDetail.hidden = true;
  dom.noteDetailPlaceholder.hidden = currentRenderedCount === 0;
  dom.notesEmpty.hidden = currentRenderedCount > 0;
}

export async function addNote(
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
  await invoke("db_promote_to_note", { id });

  await loadNotes(dom.searchInput.value.trim() || undefined);
  await emit("entries-changed");
  void processNoteBackground(id, content);
  return id;
}

export async function deleteSelectedNote(): Promise<void> {
  const id = dom.noteDetailDelete.dataset.id;
  if (!id) return;
  await invoke("db_delete_entry", { id });
  clearSelection();
  await loadNotes(dom.searchInput.value.trim() || undefined);
  await emit("entries-changed");
  showToast("Note deleted", "success", 1200);
}

export async function processNoteBackground(id: string, content: string): Promise<void> {
  // Run classification and secret detection in parallel
  const classifyPromise = invoke<{
    label: string;
    label_score: number;
    embedding: number[];
  }>("classify_text", { text: content }).catch((err) => {
    debugLog(`Classification failed for entry ${id}: ${err}`, "WARN");
    return null;
  });

  const secretPromise = scan(content).catch((err) => {
    debugLog(`Secret detection failed for entry ${id}: ${err}`, "WARN");
    return null;
  });

  const [classifyResult, secretResult] = await Promise.all([classifyPromise, secretPromise]);

  try {
    if (classifyResult) {
      await invoke("db_update_entry_classification", {
        id,
        label: classifyResult.label,
        labelScore: classifyResult.label_score,
        embedding: JSON.stringify(classifyResult.embedding),
      });
    }

    if (secretResult && secretResult.verdict !== "not_secret") {
      await invoke("db_update_entry_secret", {
        id,
        secretVerdict: secretResult.verdict,
        secretType: secretResult.secret_type,
        secretSource: secretResult.source,
      });
    }

    // Fallback: if ONNX classifier flagged as password/api_key but secret detection missed it, tag as secret
    if (
      classifyResult &&
      (classifyResult.label === "password" || classifyResult.label === "api_key") &&
      (!secretResult || secretResult.verdict === "not_secret")
    ) {
      await invoke("db_update_entry_secret", {
        id,
        secretVerdict: "likely_secret",
        secretType: classifyResult.label,
        secretSource: "classifier",
      });
    }

    await loadNotes(dom.searchInput.value.trim() || undefined);
    await emit("entries-changed");
  } catch (err) {
    debugLog(`Background processing DB update failed for entry ${id}: ${err}`, "ERROR");
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hasBadge(entry: EntryRow, badge: string): boolean {
  if (entry.label?.toLowerCase() === badge) return true;
  return parseManualBadges(entry.manual_badges).some((b) => b.name === badge);
}

function badgeColorClass(color: string): string {
  switch (color) {
    case "blue": return "badge beta";
    case "green": return "badge success";
    case "red": return "badge error";
    case "orange": return "badge warning";
    default: return "badge badge-muted";
  }
}

function renderBadgeHtml(entry: EntryRow): string {
  const parts: string[] = [];

  if (entry.label && entry.label !== "other") {
    parts.push(`<span class="badge badge-primary">${escapeHtml(entry.label)}<button class="badge-remove-btn" data-entry-id="${entry.id}" data-badge-name="${escapeHtml(entry.label)}" data-badge-type="auto" type="button" aria-label="Remove badge">×</button></span>`);
  }

  for (const badge of parseManualBadges(entry.manual_badges)) {
    parts.push(`<span class="${badgeColorClass(badge.color)}">${escapeHtml(badge.name)}<button class="badge-remove-btn" data-entry-id="${entry.id}" data-badge-name="${escapeHtml(badge.name)}" data-badge-type="manual" type="button" aria-label="Remove badge">×</button></span>`);
  }

  return parts.join(" ");
}

function renderDetailBadgeHtml(entry: EntryRow): string {
  const parts: string[] = [];

  if (entry.label && entry.label !== "other") {
    parts.push(`<span class="badge badge-primary">${escapeHtml(entry.label)}<button class="badge-remove-btn" data-entry-id="${entry.id}" data-badge-name="${escapeHtml(entry.label)}" data-badge-type="auto" type="button" aria-label="Remove badge">×</button></span>`);
    parts.push(`<span class="hint">(${Math.round((entry.label_score || 0) * 100)}%)</span>`);
  }

  for (const badge of parseManualBadges(entry.manual_badges)) {
    parts.push(`<span class="${badgeColorClass(badge.color)}">${escapeHtml(badge.name)}<button class="badge-remove-btn" data-entry-id="${entry.id}" data-badge-name="${escapeHtml(badge.name)}" data-badge-type="manual" type="button" aria-label="Remove badge">×</button></span>`);
  }

  return parts.join(" ");
}

async function handleBadgeRemoveClick(btn: HTMLElement): Promise<void> {
  const entryId = btn.dataset.entryId;
  const badgeType = btn.dataset.badgeType;
  const badgeName = btn.dataset.badgeName;
  if (!entryId || !badgeType || !badgeName) return;

  try {
    if (badgeType === "auto") {
      await invoke("db_clear_entry_label", { id: entryId });
      showToast("Auto badge removed", "success", 1200);
    } else {
      await invoke("db_remove_manual_badge", { id: entryId, badge: badgeName });
      showToast("Badge removed", "success", 1200);
    }
    await loadNotes(dom.searchInput.value.trim() || undefined);
    await emit("entries-changed");
  } catch {
    showToast("Failed to remove badge", "error");
  }
}

function setupBadgeRemoveDelegation(): void {
  dom.notesList.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".badge-remove-btn");
    if (btn) {
      e.stopPropagation();
      void handleBadgeRemoveClick(btn);
    }
  });

  dom.noteDetailMeta.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".badge-remove-btn");
    if (btn) {
      e.stopPropagation();
      void handleBadgeRemoveClick(btn);
    }
  });
}
