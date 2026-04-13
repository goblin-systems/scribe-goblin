import { applyIcons, bindContextMenu, closeModal, openModal, showToast, type ContextMenuHandle } from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { ScribeDom } from "./dom";
import type { Settings } from "../settings";
import type { EntryRow } from "../store";
import { formatRelativeTime, parseManualBadges, sourceIcon } from "../store";

const CLIPBOARD_LIMIT = 200;

let allEntries: EntryRow[] = [];
let currentRenderedCount = 0;
let selectedEntryId: string | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let getSettings: () => Settings;
let dom: ScribeDom;

let contextMenuHandle: ContextMenuHandle | null = null;
let contextEntryId: string | null = null;
let pendingBadgeEntryId: string | null = null;
let pendingBadgeColor = "default";

function badgeColorClass(color: string): string {
  switch (color) {
    case "blue": return "badge beta";
    case "green": return "badge success";
    case "red": return "badge error";
    case "orange": return "badge warning";
    default: return "badge badge-muted";
  }
}

export function initClipboardController(
  d: ScribeDom,
  settingsGetter: () => Settings
): void {
  dom = d;
  getSettings = settingsGetter;
  setupBadgeRemoveDelegation();
  setupAddBadgeModal();
}

function getContextEntry(): EntryRow | null {
  if (!contextEntryId) return null;
  return allEntries.find((entry) => entry.id === contextEntryId) ?? null;
}

function setupContextMenu(): void {
  const entry = getContextEntry();
  const isSecret = Boolean(entry?.secret_verdict && entry.secret_verdict !== "not_secret");

  contextMenuHandle?.destroy();
  contextMenuHandle = bindContextMenu({
    target: dom.clipboardList,
    items: [
      {
        id: "save-note",
        label: "Save as Note",
        icon: "bookmark-plus",
        onSelect: async () => {
          if (!contextEntryId) return;
          try {
            await invoke("db_promote_to_note", { id: contextEntryId });
            await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
            await emit("entries-changed");
            showToast("Saved as note", "success", 1200);
          } catch {
            showToast("Failed to save as note", "error");
          }
        },
      },
      {
        id: "add-badge",
        label: "Add Badge...",
        icon: "plus",
        onSelect: () => {
          if (!contextEntryId) return;
          pendingBadgeEntryId = contextEntryId;
          pendingBadgeColor = "default";
          const colorContainer = document.getElementById("add-badge-colors")!;
          colorContainer.querySelectorAll(".badge-color-swatch").forEach((s) => s.classList.remove("is-selected"));
          colorContainer.querySelector('[data-color="default"]')?.classList.add("is-selected");
          openModal({ backdrop: dom.addBadgeModal });
          dom.addBadgeInput.value = "";
          dom.addBadgeInput.focus();
        },
      },
      {
        id: isSecret ? "mark-not-secret" : "mark-secret",
        label: isSecret ? "Mark Not Secret" : "Mark as Secret",
        icon: isSecret ? "shield-check" : "shield-alert",
        onSelect: async () => {
          if (!contextEntryId) return;
          try {
            await invoke("db_update_entry_secret", {
              id: contextEntryId,
              secretVerdict: isSecret ? "not_secret" : "likely_secret",
              secretType: "unknown",
              secretSource: "manual",
            });
            await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
            await emit("entries-changed");
            showToast(isSecret ? "Marked not secret" : "Marked as secret", "success", 1200);
          } catch {
            showToast("Failed to update secret status", "error");
          }
        },
      },
        { divider: true },
        {
          id: "delete",
          label: "Delete",
        icon: "trash-2",
        onSelect: async () => {
          if (!contextEntryId) return;
          await invoke("db_delete_entry", { id: contextEntryId });
          clearClipboardSelection();
          await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
          await emit("entries-changed");
          showToast("Deleted", "success", 1200);
        },
      },
    ],
  });
}

export async function loadClipboard(search?: string): Promise<void> {
  try {
    allEntries = await invoke<EntryRow[]>("db_list_entries", {
      search: search ?? null,
      limit: CLIPBOARD_LIMIT,
      isNote: null,
    });
    renderList(allEntries);
  } catch (err) {
    console.error("Failed to load clipboard entries:", err);
  }
}

export function handleClipboardSearchInput(query: string): void {
  dom.clipboardSearchClearBtn.hidden = query.length === 0;

  if (searchDebounce !== null) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchDebounce = null;
    void loadClipboard(query.trim() || undefined);
  }, 300);
}

function renderList(entries: EntryRow[]): void {
  currentRenderedCount = entries.length;
  dom.clipboardList.replaceChildren();

  const hasEntries = entries.length > 0;
  dom.clipboardEmpty.hidden = hasEntries;

  if (!hasEntries) {
    dom.clipboardDetailPlaceholder.hidden = true;
    dom.clipboardDetail.hidden = true;
    selectedEntryId = null;
  } else if (selectedEntryId === null) {
    dom.clipboardDetailPlaceholder.hidden = false;
  }

  for (const entry of entries) {
    const item = buildClipboardItem(entry);
    dom.clipboardList.appendChild(item);
  }

  const selectedEntry = selectedEntryId === null
    ? null
    : entries.find((entry) => entry.id === selectedEntryId) ?? null;
  if (selectedEntry) {
    selectEntry(selectedEntry);
  } else if (selectedEntryId !== null) {
    clearClipboardSelection();
  }

  applyIcons();
}

function buildClipboardItem(entry: EntryRow): HTMLElement {
  const item = document.createElement("div");
  item.className = `note-item${selectedEntryId === entry.id ? " is-selected" : ""}`;
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

  const noteBadge = entry.is_note
    ? `<span class="badge" style="background:rgba(130,87,229,0.15);color:var(--accent);"><i data-lucide="bookmark" style="width:10px;height:10px;"></i> note</span>`
    : "";

  const appInfo = entry.source_app ? `<span class="hint">via ${escapeHtml(entry.source_app)}</span>` : "";

  item.innerHTML = `
    <div class="note-item-header">
      <i data-lucide="${sourceIcon(entry.source)}" class="note-source-icon"></i>
      <span class="note-time hint">${formatRelativeTime(entry.created_at)}</span>
      ${appInfo}
      ${badgeHtml}
      ${secretBadge}
      ${noteBadge}
    </div>
    <p class="note-preview">${displayPreview}</p>
  `;

  item.addEventListener("click", () => selectEntry(entry));

  item.addEventListener("contextmenu", () => {
    contextEntryId = entry.id;
    setupContextMenu();
  });

  return item;
}

function selectEntry(entry: EntryRow): void {
  selectedEntryId = entry.id;

  dom.clipboardList.querySelectorAll(".note-item").forEach((el) => {
    el.classList.toggle("is-selected", (el as HTMLElement).dataset.id === entry.id);
  });

  const isSecret = entry.secret_verdict && entry.secret_verdict !== "not_secret";
  if (isSecret) {
    dom.clipboardDetailContent.innerHTML = `
      <div class="masked-content-row">
        <span class="masked-text">${"•".repeat(Math.min(entry.content.length, 40))}</span>
        <button class="icon-btn icon-btn-sm" id="clipboard-reveal-secret-btn" type="button" title="Reveal secret" aria-label="Reveal secret">
          <i data-lucide="eye"></i>
        </button>
      </div>
    `;
    const revealBtn = document.getElementById("clipboard-reveal-secret-btn");
    if (revealBtn) {
      revealBtn.addEventListener("click", () => {
        dom.clipboardDetailContent.textContent = entry.content;
      });
    }
  } else {
    dom.clipboardDetailContent.textContent = entry.content;
  }

  const labelInfo = renderDetailBadgeHtml(entry);

  const sourceAppInfo = entry.source_app ? `<span class="hint">via ${escapeHtml(entry.source_app)}</span>` : "";

  dom.clipboardDetailMeta.innerHTML = `
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
    dom.clipboardDetailSecretActions.innerHTML = `
      <div class="secret-banner">
        <span style="font-weight:600;">${verdictLabel}</span>
        <span class="hint">(${escapeHtml(typeLabel)} · via ${escapeHtml(entry.secret_source || "unknown")})</span>
      </div>
    `;
    dom.clipboardDetailSecretActions.hidden = false;
  } else {
    dom.clipboardDetailSecretActions.hidden = true;
  }

  dom.clipboardDetail.hidden = false;
  dom.clipboardDetailPlaceholder.hidden = true;
  dom.clipboardDetailDelete.dataset.id = entry.id;
  applyIcons();
}

export function clearClipboardSelection(): void {
  selectedEntryId = null;
  dom.clipboardDetail.hidden = true;
  dom.clipboardDetailPlaceholder.hidden = currentRenderedCount === 0;
  dom.clipboardEmpty.hidden = currentRenderedCount > 0;
}

export async function deleteSelectedClipboardItem(): Promise<void> {
  const id = dom.clipboardDetailDelete.dataset.id;
  if (!id) return;
  await invoke("db_delete_entry", { id });
  clearClipboardSelection();
  await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
   await emit("entries-changed");
  showToast("Deleted", "success", 1200);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
    await emit("entries-changed");
  } catch {
    showToast("Failed to remove badge", "error");
  }
}

function setupBadgeRemoveDelegation(): void {
  dom.clipboardList.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".badge-remove-btn");
    if (btn) {
      e.stopPropagation();
      void handleBadgeRemoveClick(btn);
    }
  });

  dom.clipboardDetailMeta.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".badge-remove-btn");
    if (btn) {
      e.stopPropagation();
      void handleBadgeRemoveClick(btn);
    }
  });
}

function setupAddBadgeModal(): void {
  // Color swatch selection
  const colorContainer = document.getElementById("add-badge-colors")!;
  colorContainer.addEventListener("click", (e) => {
    const swatch = (e.target as HTMLElement).closest<HTMLElement>(".badge-color-swatch");
    if (!swatch) return;
    colorContainer.querySelectorAll(".badge-color-swatch").forEach((s) => s.classList.remove("is-selected"));
    swatch.classList.add("is-selected");
    pendingBadgeColor = swatch.dataset.color || "default";
  });

  const confirm = async () => {
    const raw = dom.addBadgeInput.value.trim();
    if (!raw || !pendingBadgeEntryId) {
      closeModal({ backdrop: dom.addBadgeModal });
      return;
    }
    const badges = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (badges.length === 0) {
      closeModal({ backdrop: dom.addBadgeModal });
      return;
    }
    try {
      for (const badge of badges) {
        await invoke("db_add_manual_badge", { id: pendingBadgeEntryId, badge, color: pendingBadgeColor });
      }
      await loadClipboard(dom.clipboardSearchInput.value.trim() || undefined);
      await emit("entries-changed");
      showToast(
        badges.length === 1 ? "Badge added" : `${badges.length} badges added`,
        "success",
        1200,
      );
    } catch {
      showToast("Failed to add badge", "error");
    }
    closeModal({ backdrop: dom.addBadgeModal });
    pendingBadgeEntryId = null;
    pendingBadgeColor = "default";
    // Reset color picker to default
    colorContainer.querySelectorAll(".badge-color-swatch").forEach((s) => s.classList.remove("is-selected"));
    colorContainer.querySelector('[data-color="default"]')?.classList.add("is-selected");
  };

  dom.addBadgeConfirmBtn.addEventListener("click", () => void confirm());

  dom.addBadgeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void confirm();
    }
  });
}
