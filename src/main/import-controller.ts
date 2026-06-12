import { applyIcons, closeModal, openModal, showToast } from "@goblin-systems/goblin-design-system";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ScribeDom } from "./dom";
import type { EntryRow } from "../store";
import { formatBytes, isAttachmentOnlyEntry } from "../store";
import { processNoteBackground } from "./collection-controller";

type SelectedImportFile =
  | {
      kind: "browser";
      id: string;
      name: string;
      contentType: string | null;
      sizeBytes: number;
      file: File;
    }
  | {
      kind: "path";
      id: string;
      name: string;
      contentType: string | null;
      sizeBytes: number | null;
      path: string;
    };

interface ImportPayload {
  kind: "text" | "file";
  text?: string;
  htmlContent?: string | null;
  path?: string;
  fileBytesBase64?: string;
  name?: string | null;
  contentType?: string | null;
  importOrigin?: string | null;
}

let dom: ScribeDom;
let selectedFiles: SelectedImportFile[] = [];
let unlistenDragDrop: (() => void) | null = null;
let importInFlight = false;

export async function initImportController(d: ScribeDom): Promise<void> {
  dom = d;

  dom.importBtn.addEventListener("click", () => openImportModal());
  dom.importChooseFilesBtn.addEventListener("click", () => dom.importFileInput.click());
  dom.importClearFilesBtn.addEventListener("click", () => {
    selectedFiles = [];
    dom.importFileInput.value = "";
    renderSelectedFiles();
  });
  dom.importFileInput.addEventListener("change", () => {
    const files = Array.from(dom.importFileInput.files ?? []);
    addBrowserFiles(files);
    dom.importFileInput.value = "";
  });
  dom.importConfirmBtn.addEventListener("click", () => {
    void submitImport();
  });
  dom.importTextInput.addEventListener("input", () => renderSelectedFiles());
  dom.importTextInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void submitImport();
    }
  });

  await bindNativeDragDrop();
  renderSelectedFiles();
}

export function openImportModal(): void {
  dom.importDropZone.classList.remove("is-drag-active");
  openModal({ backdrop: dom.importModal });
  renderSelectedFiles();
  dom.importTextInput.focus();
}

async function bindNativeDragDrop(): Promise<void> {
  unlistenDragDrop?.();
  unlistenDragDrop = await getCurrentWindow().onDragDropEvent((event) => {
    if (dom.importModal.hidden) return;

    if (event.payload.type === "over") {
      dom.importDropZone.classList.toggle("is-drag-active", isWithinDropZone(event.payload.position));
      return;
    }

    if (event.payload.type === "drop") {
      dom.importDropZone.classList.remove("is-drag-active");
      if (!isWithinDropZone(event.payload.position)) return;
      addDroppedPaths(event.payload.paths);
      return;
    }

    dom.importDropZone.classList.remove("is-drag-active");
  });
}

function isWithinDropZone(position: { x: number; y: number }): boolean {
  const element = document.elementFromPoint(position.x, position.y);
  return Boolean(element?.closest("#import-drop-zone"));
}

function addBrowserFiles(files: File[]): void {
  const mapped = files.map<SelectedImportFile>((file) => ({
    kind: "browser",
    id: crypto.randomUUID(),
    name: file.name,
    contentType: file.type || null,
    sizeBytes: file.size,
    file,
  }));

  selectedFiles = dedupeSelectedFiles([...selectedFiles, ...mapped]);
  renderSelectedFiles();
}

function addDroppedPaths(paths: string[]): void {
  const mapped = paths.map<SelectedImportFile>((path) => ({
    kind: "path",
    id: crypto.randomUUID(),
    path,
    name: basename(path),
    contentType: null,
    sizeBytes: null,
  }));

  selectedFiles = dedupeSelectedFiles([...selectedFiles, ...mapped]);
  renderSelectedFiles();
}

function dedupeSelectedFiles(files: SelectedImportFile[]): SelectedImportFile[] {
  const seen = new Set<string>();
  const next: SelectedImportFile[] = [];

  for (const file of files) {
    const key = file.kind === "path"
      ? `path:${file.path.toLowerCase()}`
      : `browser:${file.name}:${file.sizeBytes}:${file.contentType ?? ""}`;

    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }

  return next;
}

function renderSelectedFiles(): void {
  const hasText = dom.importTextInput.value.trim().length > 0;
  const hasFiles = selectedFiles.length > 0;

  dom.importSelectedFiles.replaceChildren();
  dom.importSelectedFilesEmpty.hidden = hasFiles;
  dom.importClearFilesBtn.hidden = !hasFiles;
  dom.importConfirmBtn.disabled = !hasText && !hasFiles || importInFlight;

  if (hasFiles) {
    for (const file of selectedFiles) {
      dom.importSelectedFiles.appendChild(buildSelectedFileItem(file));
    }
  }

  const summaryParts: string[] = [];
  if (hasText) summaryParts.push("pasted text ready");
  if (hasFiles) summaryParts.push(`${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected`);
  dom.importSummary.textContent = summaryParts.length > 0
    ? `Will import ${summaryParts.join(" and ")}.`
    : "Paste text, choose files, or drag files into the drop zone.";

  applyIcons();
}

function buildSelectedFileItem(file: SelectedImportFile): HTMLElement {
  const item = document.createElement("div");
  item.className = "import-file-item";

  const size = file.kind === "browser"
    ? formatBytes(file.sizeBytes)
    : formatBytes(file.sizeBytes);
  const source = file.kind === "path" ? "drag & drop" : "file picker";

  item.innerHTML = `
    <div class="import-file-item-main">
      <div class="import-file-item-name">${escapeHtml(file.name)}</div>
      <div class="import-file-item-meta">${[file.contentType, size, source].filter((part): part is string => Boolean(part)).map((part) => escapeHtml(part)).join(" · ")}</div>
    </div>
    <button class="icon-btn icon-btn-sm import-file-remove-btn" type="button" aria-label="Remove file" title="Remove file">
      <i data-lucide="x"></i>
    </button>
  `;

  item.querySelector<HTMLButtonElement>(".import-file-remove-btn")?.addEventListener("click", () => {
    selectedFiles = selectedFiles.filter((entry) => entry.id !== file.id);
    renderSelectedFiles();
  });

  return item;
}

async function submitImport(): Promise<void> {
  if (importInFlight) return;

  const text = dom.importTextInput.value.trim();
  const hasText = text.length > 0;
  const hasFiles = selectedFiles.length > 0;

  if (!hasText && !hasFiles) {
    showToast("Nothing to import", "error");
    return;
  }

  importInFlight = true;
  renderSelectedFiles();

  try {
    const payloads: ImportPayload[] = [];

    if (hasText) {
      payloads.push({
        kind: "text",
        text,
        contentType: "text/plain",
        importOrigin: "pasted-text",
      });
    }

    for (const file of selectedFiles) {
      payloads.push(await buildFilePayload(file));
    }

    const imported = await invoke<EntryRow[]>("import_capture", { payloads });
    await Promise.all(
      imported
        .filter((entry) => !isAttachmentOnlyEntry(entry))
        .map((entry) => processNoteBackground(entry.id, entry.content)),
    );

    resetState();
    closeModal({ backdrop: dom.importModal });
    await emit("entries-changed");

    const textCount = imported.filter((entry) => !isAttachmentOnlyEntry(entry)).length;
    const attachmentCount = imported.filter((entry) => isAttachmentOnlyEntry(entry)).length;
    const messageParts: string[] = [];
    if (textCount > 0) messageParts.push(`${textCount} text import${textCount === 1 ? "" : "s"}`);
    if (attachmentCount > 0) messageParts.push(`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`);
    showToast(`Imported ${messageParts.join(" and ")}`, "success", 1800);
  } catch (error) {
    console.error("Import failed:", error);
    showToast(`Import failed: ${String(error)}`, "error");
  } finally {
    importInFlight = false;
    renderSelectedFiles();
  }
}

async function buildFilePayload(file: SelectedImportFile): Promise<ImportPayload> {
  if (file.kind === "path") {
    return {
      kind: "file",
      path: file.path,
      name: file.name,
      contentType: file.contentType,
      importOrigin: "drag-drop",
    };
  }

  return {
    kind: "file",
    name: file.name,
    contentType: file.contentType,
    importOrigin: "file-picker",
    fileBytesBase64: await readFileAsBase64(file.file),
  };
}

function resetState(): void {
  selectedFiles = [];
  dom.importTextInput.value = "";
  dom.importFileInput.value = "";
  dom.importDropZone.classList.remove("is-drag-active");
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const payload = result.split(",", 2)[1];
      if (!payload) {
        reject(new Error(`Failed to encode ${file.name}`));
        return;
      }
      resolve(payload);
    };
    reader.readAsDataURL(file);
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
