import {
  applyIcons,
  closeModal,
  openModal,
  showToast,
} from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { EntryRow, EntryTagRecord } from "../store";
import type { ScribeDom } from "./dom";

interface GarbageCandidate {
  entry: EntryRow;
  reason: string;
}

const MAX_SCAN_ITEMS = 1000;

function escapeHtml(value: string): string {
  const p = document.createElement("p");
  p.textContent = value;
  return p.innerHTML;
}

function previewContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 260) || "(empty clipboard item)";
}

function parseTags(entry: EntryRow): EntryTagRecord[] {
  if (!entry.tags_json) return [];
  try {
    const parsed = JSON.parse(entry.tags_json) as EntryTagRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getGarbageTagReason(entry: EntryRow): string | null {
  const tag = parseTags(entry).find(
    (candidate) =>
      candidate.name === "garbage" &&
      candidate.kind === "enrichment" &&
      candidate.source === "ai",
  );
  if (!tag) return null;
  return tag.model?.trim() || "AI enrichment marked this as garbage.";
}

export function getGarbageCandidates(entries: EntryRow[]): GarbageCandidate[] {
  return entries
    .filter((entry) => entry.is_note === false)
    .map((entry) => {
      const reason = getGarbageTagReason(entry);
      return reason ? { entry, reason } : null;
    })
    .filter((candidate): candidate is GarbageCandidate => Boolean(candidate));
}

export function initGarbageCollectionController(
  dom: ScribeDom,
  onDeleted: () => Promise<void>,
): { open: () => void } {
  let candidates: GarbageCandidate[] = [];

  function setStatus(message: string): void {
    dom.garbageCollectionStatus.textContent = message;
  }

  function renderCandidates(): void {
    dom.garbageCollectionDeleteBtn.disabled = candidates.length === 0;

    if (candidates.length === 0) {
      dom.garbageCollectionList.innerHTML = `<p class="hint garbage-collection-empty">No precomputed garbage tags found. New clipboard items are tagged during AI enrichment when garbage detection is enabled.</p>`;
      return;
    }

    dom.garbageCollectionList.innerHTML = candidates.map((candidate, index) => {
      const date = new Date(candidate.entry.created_at).toLocaleString();
      return `
        <label class="garbage-collection-row">
          <div class="garbage-collection-row-head">
            <span class="garbage-collection-row-title">
              <input type="checkbox" data-garbage-index="${index}" checked />
              <span>Clipboard item from ${escapeHtml(date)}</span>
            </span>
          </div>
          <div class="garbage-collection-preview">${escapeHtml(previewContent(candidate.entry.content))}</div>
          <div class="garbage-collection-reason">${escapeHtml(candidate.reason)}</div>
        </label>
      `;
    }).join("");
  }

  async function scan(): Promise<void> {
    dom.garbageCollectionScanBtn.disabled = true;
    dom.garbageCollectionDeleteBtn.disabled = true;
    dom.garbageCollectionList.innerHTML = `<p class="hint garbage-collection-empty">Loading precomputed garbage tags…</p>`;

    try {
      const entries = await invoke<EntryRow[]>("db_list_entries", { search: null, limit: MAX_SCAN_ITEMS });
      candidates = getGarbageCandidates(entries);
      setStatus(candidates.length === 0
        ? `Checked ${entries.length} clipboard records. No garbage tags found.`
        : `Checked ${entries.length} clipboard records. Review ${candidates.length} garbage candidate${candidates.length === 1 ? "" : "s"}.`);
      renderCandidates();
    } catch (err) {
      candidates = [];
      renderCandidates();
      setStatus("Could not load garbage tags.");
      showToast(`Garbage collection failed: ${String(err)}`, "error", 5000);
    } finally {
      dom.garbageCollectionScanBtn.disabled = false;
    }
  }

  async function deleteSelected(): Promise<void> {
    const selectedIds = Array.from(dom.garbageCollectionList.querySelectorAll<HTMLInputElement>("input[data-garbage-index]:checked"))
      .map((input) => candidates[Number(input.dataset.garbageIndex)]?.entry.id)
      .filter((id): id is string => Boolean(id));
    if (selectedIds.length === 0) {
      showToast("No garbage items selected", "info", 1500);
      return;
    }

    dom.garbageCollectionDeleteBtn.disabled = true;
    try {
      await invoke("db_delete_entries", { ids: selectedIds });
      await emit("entries-changed");
      await onDeleted();
      candidates = candidates.filter((candidate) => !selectedIds.includes(candidate.entry.id));
      setStatus(`Deleted ${selectedIds.length} garbage item${selectedIds.length === 1 ? "" : "s"}.`);
      renderCandidates();
      showToast(`Deleted ${selectedIds.length} garbage item${selectedIds.length === 1 ? "" : "s"}`, "success", 1600);
      if (candidates.length === 0) closeModal({ backdrop: dom.garbageCollectionModal });
    } catch (err) {
      dom.garbageCollectionDeleteBtn.disabled = false;
      showToast(`Delete failed: ${String(err)}`, "error", 5000);
    }
  }

  dom.garbageCollectionScanBtn.addEventListener("click", () => void scan());
  dom.garbageCollectionDeleteBtn.addEventListener("click", () => void deleteSelected());

  return {
    open: () => {
      candidates = [];
      setStatus(`Ready to load precomputed garbage tags from up to ${MAX_SCAN_ITEMS} clipboard items.`);
      renderCandidates();
      openModal({ backdrop: dom.garbageCollectionModal });
      applyIcons();
      void scan();
    },
  };
}
