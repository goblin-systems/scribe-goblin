import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

interface Entry {
  id: string;
  content: string;
  html_content: string | null;
  source: string;
  source_app: string | null;
  created_at: number;
  label: string | null;
  label_score: number | null;
  embedding: string | null;
}

let entries: Entry[] = [];
let selectedIndex = 0;
const searchInput = document.getElementById("overlay-search") as HTMLInputElement;
const resultsList = document.getElementById("results-list") as HTMLDivElement;

async function loadEntries(search = "") {
  try {
    const result = await invoke<Entry[]>("db_list_entries", { 
      search: search || null, 
      limit: 50
    });
    entries = result;
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
    item.className = `result-item ${index === selectedIndex ? "is-selected" : ""}`;
    
    const content = document.createElement("div");
    content.className = "result-content";
    content.innerHTML = `
      <span class="unmasked-content">${escapeHtml(entry.content)}</span>
      <span class="masked-content">${"•".repeat(Math.min(entry.content.length, 32))}</span>
    `;
    
    const meta = document.createElement("div");
    meta.className = "result-meta";
    const date = new Date(entry.created_at).toLocaleString();
    
    let badgeHtml = "";
    if (entry.label && entry.label !== "other") {
      badgeHtml = `<span style="background:rgba(122,162,247,0.1);padding:1px 4px;border-radius:3px;margin-right:4px;">${entry.label}</span>`;
    }

    meta.innerHTML = `<div>${badgeHtml}</div><span>${date}</span>`;
    
    item.appendChild(content);
    item.appendChild(meta);
    
    item.onclick = () => {
      selectedIndex = index;
      void performPaste();
    };
    
    resultsList.appendChild(item);
    
    if (index === selectedIndex) {
      item.scrollIntoView({ block: "nearest" });
    }
  });
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
  } catch (err) {
    console.error("Delete failed:", err);
  }
}

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

// Auto-focus search on start
window.onload = () => {
  searchInput.focus();
  void loadEntries();
};

// Hide when focus is lost
window.onblur = () => {
  void getCurrentWindow().hide();
};
