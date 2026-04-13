import { applyIcons, bindContextMenu, type ContextMenuHandle } from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import type { EntryRow } from "./store";
import { parseManualBadges } from "./store";

const BADGE_INLINE_COLORS: Record<string, { bg: string; border: string; color: string }> = {
  default: { bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.12)", color: "#a9b1d6" },
  blue: { bg: "rgba(122,162,247,0.15)", border: "rgba(122,162,247,0.3)", color: "#7aa2f7" },
  green: { bg: "rgba(158,206,106,0.15)", border: "rgba(158,206,106,0.3)", color: "#9ece6a" },
  red: { bg: "rgba(247,118,142,0.15)", border: "rgba(247,118,142,0.3)", color: "#f7768e" },
  orange: { bg: "rgba(224,175,104,0.15)", border: "rgba(224,175,104,0.3)", color: "#e0af68" },
};

let entries: EntryRow[] = [];
let selectedIndex = 0;
let contextMenuHandle: ContextMenuHandle | null = null;
let contextEntryId: string | null = null;
const searchInput = document.getElementById("overlay-search") as HTMLInputElement;
const resultsList = document.getElementById("results-list") as HTMLDivElement;

function currentSearch(): string {
  return searchInput.value.trim();
}

async function refreshEntries(): Promise<void> {
  await loadEntries(currentSearch());
}

function getContextEntry(): EntryRow | null {
  if (!contextEntryId) return null;
  return entries.find((entry) => entry.id === contextEntryId) ?? null;
}

function setupContextMenu(): void {
  const entry = getContextEntry();
  const isSecret = Boolean(entry?.secret_verdict && entry.secret_verdict !== "not_secret");

  contextMenuHandle?.destroy();
  contextMenuHandle = bindContextMenu({
    target: resultsList,
    items: [
      {
        id: "save-note",
        label: "Save as Note",
        icon: "bookmark-plus",
        onSelect: async () => {
          if (!contextEntryId) return;
          await invoke("db_promote_to_note", { id: contextEntryId });
          await refreshEntries();
          await emit("entries-changed");
        },
      },
      {
        id: "add-badge",
        label: "Add Badge...",
        icon: "plus",
        onSelect: async () => {
          if (!contextEntryId) return;
          const raw = window.prompt("Badge name(s), comma-separated");
          if (raw === null) return;
          const badges = raw.split(",").map((s) => s.trim()).filter(Boolean);
          if (badges.length === 0) return;
          for (const badge of badges) {
            await invoke("db_add_manual_badge", { id: contextEntryId, badge, color: "default" });
          }
          await refreshEntries();
          await emit("entries-changed");
        },
      },
      {
        id: isSecret ? "mark-not-secret" : "mark-secret",
        label: isSecret ? "Mark Not Secret" : "Mark as Secret",
        icon: isSecret ? "shield-check" : "shield-alert",
        onSelect: async () => {
          if (!contextEntryId) return;
          await invoke("db_update_entry_secret", {
            id: contextEntryId,
            secretVerdict: isSecret ? "not_secret" : "likely_secret",
            secretType: "unknown",
            secretSource: "manual",
          });
          await refreshEntries();
          await emit("entries-changed");
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
          await refreshEntries();
          await emit("entries-changed");
        },
      },
    ],
  });
}

async function loadEntries(search = "") {
  try {
    const result = await invoke<EntryRow[]>("db_list_entries", { 
      search: search || null, 
      limit: 50
    });
    entries = result;
    if (selectedIndex >= entries.length) {
      selectedIndex = Math.max(0, entries.length - 1);
    }
    renderEntries();
  } catch (err) {
    console.error("Failed to load entries:", err);
  }
}

function renderEntries() {
  resultsList.innerHTML = "";
  if (entries.length === 0) {
    resultsList.innerHTML = '<div style="padding: 20px; text-align: center; color: #565f89;">No history found</div>';
    return;
  }

  entries.forEach((entry, index) => {
    const item = document.createElement("div");
    const isSecret = entry.secret_verdict && entry.secret_verdict !== "not_secret";
    item.className = `result-item ${index === selectedIndex ? "is-selected" : ""} ${isSecret ? "is-secret" : ""}`;
    
    const content = document.createElement("div");
    content.className = "result-content";
    content.innerHTML = `
      <span class="unmasked-content">${escapeHtml(entry.content)}</span>
      <span class="masked-content">${"•".repeat(Math.min(entry.content.length, 32))}</span>
    `;
    
    const meta = document.createElement("div");
    meta.className = "result-meta";
    const date = new Date(entry.created_at).toLocaleString();
    
    const badgeHtml = renderBadgeHtml(entry);

    meta.innerHTML = `<div>${badgeHtml}</div><span>${date}</span>`;
    
    item.appendChild(content);
    item.appendChild(meta);
    
    item.onclick = () => {
      selectedIndex = index;
      void performPaste();
    };

    item.addEventListener("contextmenu", () => {
      selectedIndex = index;
      contextEntryId = entry.id;
      setupContextMenu();
      renderEntries();
    });
    
    resultsList.appendChild(item);
    
    if (index === selectedIndex) {
      item.scrollIntoView({ block: "nearest" });
    }
  });

  applyIcons();
}

function escapeHtml(str: string): string {
  const p = document.createElement("p");
  p.textContent = str;
  return p.innerHTML;
}

async function performPaste(stripFormatting = false) {
  const entry = entries[selectedIndex];
  if (!entry) return;

  const appWindow = getCurrentWindow();
  await appWindow.hide();
  
  const html = stripFormatting ? null : entry.html_content;

  setTimeout(async () => {
    try {
      await invoke("simulate_paste", { 
        text: entry.content,
        html: html
      });
    } catch (err) {
      console.error("Paste failed:", err);
    }
  }, 100);
}

async function deleteSelectedEntry() {
  const entry = entries[selectedIndex];
  if (!entry) return;

  try {
    await invoke("db_delete_entry", { id: entry.id });
    entries.splice(selectedIndex, 1);
    if (selectedIndex >= entries.length) {
      selectedIndex = Math.max(0, entries.length - 1);
    }
    renderEntries();
    await emit("entries-changed");
  } catch (err) {
    console.error("Delete failed:", err);
  }
}

function renderBadgeHtml(entry: EntryRow): string {
  const parts: string[] = [];

  if (entry.label && entry.label !== "other") {
    parts.push(`<span style="background:rgba(122,162,247,0.1);padding:1px 4px;border-radius:3px;margin-right:4px;white-space:nowrap;display:inline-flex;align-items:center;">${escapeHtml(entry.label)}<button style="all:unset;cursor:pointer;margin-left:4px;opacity:0.6;font-size:12px;line-height:1;" data-entry-id="${entry.id}" data-badge-name="${escapeHtml(entry.label)}" data-badge-type="auto" type="button" aria-label="Remove badge" class="badge-remove-btn" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'">×</button></span>`);
  }

  for (const badge of parseManualBadges(entry.manual_badges)) {
    const c = BADGE_INLINE_COLORS[badge.color] || BADGE_INLINE_COLORS.default;
    parts.push(`<span style="background:${c.bg};border:1px solid ${c.border};color:${c.color};padding:1px 4px;border-radius:3px;margin-right:4px;white-space:nowrap;display:inline-flex;align-items:center;">${escapeHtml(badge.name)}<button style="all:unset;cursor:pointer;margin-left:4px;opacity:0.6;font-size:12px;line-height:1;" data-entry-id="${entry.id}" data-badge-name="${escapeHtml(badge.name)}" data-badge-type="manual" type="button" aria-label="Remove badge" class="badge-remove-btn" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'">×</button></span>`);
  }

  return parts.join("");
}

async function handleBadgeRemoveClick(btn: HTMLElement): Promise<void> {
  const entryId = btn.dataset.entryId;
  const badgeType = btn.dataset.badgeType;
  const badgeName = btn.dataset.badgeName;
  if (!entryId || !badgeType || !badgeName) return;

  try {
    if (badgeType === "auto") {
      await invoke("db_clear_entry_label", { id: entryId });
    } else {
      await invoke("db_remove_manual_badge", { id: entryId, badge: badgeName });
    }
    await refreshEntries();
    await emit("entries-changed");
  } catch (err) {
    console.error("Failed to remove badge:", err);
  }
}

resultsList.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".badge-remove-btn");
  if (btn) {
    e.stopPropagation();
    void handleBadgeRemoveClick(btn);
  }
});

searchInput.oninput = () => {
  selectedIndex = 0;
  void loadEntries(searchInput.value);
};

window.onkeydown = (e) => {
  if (e.key === "Alt") {
    e.preventDefault();
    if (!document.body.classList.contains("alt-pressed")) {
      document.body.classList.add("alt-pressed");
    }
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (entries.length > 0) {
        selectedIndex = (selectedIndex + 1) % entries.length;
        renderEntries();
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (entries.length > 0) {
        selectedIndex = (selectedIndex - 1 + entries.length) % entries.length;
        renderEntries();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    void performPaste(e.ctrlKey);
  } else if (e.key === "Delete") {
    e.preventDefault();
    void deleteSelectedEntry();
  } else if (e.key === "Escape") {
    void getCurrentWindow().hide();
  }
};

window.onkeyup = (e) => {
  if (e.key === "Alt") {
    e.preventDefault();
    document.body.classList.remove("alt-pressed");
  }
};

// Listen for show-overlay event
listen("show-overlay", async (event: any) => {
  const { x, y } = event.payload;
  const appWindow = getCurrentWindow();
  
  // Center roughly on cursor
  await appWindow.setPosition(new LogicalPosition(x - 200, y - 20));
  await appWindow.show();
  await appWindow.setFocus();
  
  document.body.classList.remove("alt-pressed");
  searchInput.value = "";
  selectedIndex = 0;
  await loadEntries();
  searchInput.focus();
});

listen("entries-changed", async () => {
  await refreshEntries();
});

// Auto-focus search on start
window.onload = () => {
  searchInput.focus();
  void loadEntries();
};

// Hide when focus is lost
window.onblur = () => {
  void getCurrentWindow().hide();
};
