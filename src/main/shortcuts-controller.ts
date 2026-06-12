import { openModal } from "@goblin-systems/goblin-design-system";
import type { ScribeDom } from "./dom";
import {
  captureShortcutBinding,
  findShortcutConflict,
  formatShortcutBinding,
  getEditableShortcutDefinitions,
  getFixedShortcutDefinitions,
  getShortcutDefinition,
  resolveEffectiveShortcutBinding,
  validateEditableShortcutBinding,
  type EditableShortcutId,
  type ShortcutMatchInput,
  type ShortcutOverrides,
} from "../shortcuts";

interface ApplyShortcutResult {
  ok: boolean;
  message?: string;
}

export interface ShortcutsControllerOptions {
  dom: ScribeDom;
  getShortcutOverrides: () => ShortcutOverrides;
  applyShortcutOverride: (
    id: EditableShortcutId,
    binding: string | null,
  ) => Promise<ApplyShortcutResult>;
  resetAllEditableShortcuts: () => Promise<ApplyShortcutResult>;
}

export function setupShortcutsController(options: ShortcutsControllerOptions) {
  const { dom, getShortcutOverrides, applyShortcutOverride, resetAllEditableShortcuts } = options;

  let capturingShortcutId: EditableShortcutId | null = null;
  let busyShortcutId: EditableShortcutId | "__all__" | null = null;

  dom.shortcutsResetAllBtn.addEventListener("click", async () => {
    if (busyShortcutId) return;
    busyShortcutId = "__all__";
    render();
    const result = await resetAllEditableShortcuts();
    busyShortcutId = null;
    setStatus(result.ok ? "All editable shortcuts reset to defaults." : result.message ?? "Failed to reset shortcuts.", !result.ok);
    render();
  });

  dom.shortcutsSettingsModal.addEventListener("click", (event: MouseEvent) => {
    if (event.target === dom.shortcutsSettingsModal) {
      stopCapture();
      render();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (dom.shortcutsSettingsModal.hidden || !capturingShortcutId) return;
    handleCaptureKeydown(event);
  });

  function openShortcutsSettings(): void {
    stopCapture();
    setStatus("Click Edit, then press a shortcut. Press Esc to cancel capture.");
    render();
    openModal({ backdrop: dom.shortcutsSettingsModal });
  }

  function refresh(): void {
    if (dom.shortcutsSettingsModal.hidden) return;
    render();
  }

  function stopCapture(): void {
    capturingShortcutId = null;
  }

  function render(): void {
    renderEditableShortcuts();
    renderFixedShortcuts();
    dom.shortcutsResetAllBtn.disabled = busyShortcutId !== null;
  }

  function renderEditableShortcuts(): void {
    const overrides = getShortcutOverrides();
    dom.shortcutsEditableList.replaceChildren();

    for (const shortcut of getEditableShortcutDefinitions()) {
      const row = document.createElement("div");
      row.className = "shortcut-row";

      const details = document.createElement("div");
      details.className = "shortcut-row-details";
      details.innerHTML = `
        <div class="shortcut-row-title-wrap">
          <span class="shortcut-row-title">${escapeHtml(shortcut.title)}</span>
          <span class="shortcut-row-badge">Editable</span>
        </div>
        <p class="shortcut-row-description">${escapeHtml(shortcut.description)}</p>
      `;

      const actions = document.createElement("div");
      actions.className = "shortcut-row-actions";

      const value = document.createElement("span");
      value.className = "shortcut-row-binding";
      value.textContent = formatShortcutBinding(resolveEffectiveShortcutBinding(shortcut.id, overrides));

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "secondary-btn slim-btn";
      editBtn.textContent = capturingShortcutId === shortcut.id ? "Press keys…" : "Edit";
      editBtn.disabled = busyShortcutId !== null && busyShortcutId !== shortcut.id;
      editBtn.addEventListener("click", () => {
        if (busyShortcutId) return;
        capturingShortcutId = capturingShortcutId === shortcut.id ? null : shortcut.id;
        setStatus(
          capturingShortcutId
            ? `Capturing ${shortcut.title}. Press Esc to cancel.`
            : "Click Edit, then press a shortcut. Press Esc to cancel capture.",
        );
        render();
      });

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "secondary-btn slim-btn";
      resetBtn.textContent = "Reset";
      resetBtn.disabled = busyShortcutId !== null || !overrides[shortcut.id];
      resetBtn.addEventListener("click", async () => {
        stopCapture();
        busyShortcutId = shortcut.id;
        render();
        const result = await applyShortcutOverride(shortcut.id, null);
        busyShortcutId = null;
        setStatus(result.ok ? `${shortcut.title} reset to default.` : result.message ?? "Failed to reset shortcut.", !result.ok);
        render();
      });

      actions.append(value, editBtn, resetBtn);
      row.append(details, actions);
      dom.shortcutsEditableList.appendChild(row);
    }
  }

  function renderFixedShortcuts(): void {
    dom.shortcutsFixedList.replaceChildren();

    for (const shortcut of getFixedShortcutDefinitions()) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      row.innerHTML = `
        <div class="shortcut-row-details">
          <div class="shortcut-row-title-wrap">
            <span class="shortcut-row-title">${escapeHtml(shortcut.title)}</span>
            <span class="shortcut-row-badge shortcut-row-badge--fixed">Fixed</span>
          </div>
          <p class="shortcut-row-description">${escapeHtml(shortcut.description)}</p>
        </div>
        <div class="shortcut-row-actions">
          <span class="shortcut-row-binding">${escapeHtml(formatShortcutBinding(shortcut.defaultBinding))}</span>
        </div>
      `;
      dom.shortcutsFixedList.appendChild(row);
    }
  }

  async function handleCaptureKeydown(event: KeyboardEvent): Promise<void> {
    const shortcutId = capturingShortcutId;
    if (!shortcutId) return;

    event.preventDefault();
    event.stopPropagation();

    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === "Escape") {
      stopCapture();
      setStatus("Shortcut capture cancelled.");
      render();
      return;
    }

    const shortcut = getShortcutDefinition(shortcutId);
    const binding = captureShortcutBinding(toShortcutInput(event), shortcut.scope);
    if (!binding) return;

    const validationError = validateEditableShortcutBinding(shortcutId, binding);
    if (validationError) {
      setStatus(validationError, true);
      return;
    }

    const candidateOverrides = { ...getShortcutOverrides(), [shortcutId]: binding };
    const conflict = findShortcutConflict(shortcutId, binding, candidateOverrides);
    if (conflict) {
      setStatus(`Conflicts with ${conflict.title} (${formatShortcutBinding(resolveEffectiveShortcutBinding(conflict.id, candidateOverrides))}).`, true);
      return;
    }

    stopCapture();
    busyShortcutId = shortcutId;
    render();

    const result = await applyShortcutOverride(shortcutId, binding);
    busyShortcutId = null;
    setStatus(
      result.ok
        ? `${shortcut.title} updated to ${formatShortcutBinding(binding)}.`
        : result.message ?? `Failed to update ${shortcut.title}.`,
      !result.ok,
    );
    render();
  }

  function setStatus(message: string, isError = false): void {
    dom.shortcutsCaptureHint.textContent = message;
    dom.shortcutsCaptureHint.classList.toggle("is-error", isError);
  }

  return {
    openShortcutsSettings,
    refresh,
  };
}

function toShortcutInput(event: KeyboardEvent): ShortcutMatchInput {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
