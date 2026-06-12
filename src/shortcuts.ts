export type ShortcutScope =
  | "global"
  | "main"
  | "modal"
  | "overlay"
  | "collection"
  | "checklist"
  | "shared"
  | "system";

export type EditableShortcutId =
  | "global.showOverlay"
  | "main.focusSearch"
  | "main.newItem"
  | "main.openImport";

export type ShortcutId =
  | EditableShortcutId
  | "main.clearSelection"
  | "main.deleteSelection"
  | "modal.confirm"
  | "modal.cancel"
  | "editor.submit"
  | "editor.cancel"
  | "shared.transientReveal"
  | "checklist.toggleSelected"
  | "collection.reorderUp"
  | "collection.reorderDown"
  | "overlay.moveUp"
  | "overlay.moveDown"
  | "overlay.paste"
  | "overlay.modifiedPaste"
  | "overlay.delete"
  | "overlay.close"
  | "system.quit";

export type ShortcutOverrides = Partial<Record<EditableShortcutId, string>>;

export interface ShortcutDefinition {
  id: ShortcutId;
  title: string;
  description: string;
  scope: ShortcutScope;
  defaultBinding: string;
  editable: boolean;
}

export interface ShortcutMatchInput {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

type ParsedBinding = {
  modifiers: Set<string>;
  key: string;
};

const ACTUAL_MODIFIER_ORDER = ["Control", "Meta", "Alt", "Shift"] as const;

const MAC_PLATFORM_NAMES = new Set(["mac", "macos", "darwin"]);
const MODIFIER_ORDER = ["Primary", "Control", "Meta", "Alt", "Shift"] as const;
const RESERVED_SHORTCUTS: ShortcutDefinition[] = [
  {
    id: "global.showOverlay",
    title: "Show overlay",
    description: "Open the clipboard overlay from anywhere.",
    scope: "global",
    defaultBinding: "Control+Alt+V",
    editable: true,
  },
  {
    id: "main.focusSearch",
    title: "Focus active search",
    description: "Focus the search field for the active view.",
    scope: "main",
    defaultBinding: "Primary+F",
    editable: true,
  },
  {
    id: "main.newItem",
    title: "New item",
    description: "Open the quick add form.",
    scope: "main",
    defaultBinding: "Primary+N",
    editable: true,
  },
  {
    id: "main.openImport",
    title: "Open import",
    description: "Open the import modal.",
    scope: "main",
    defaultBinding: "Primary+I",
    editable: true,
  },
  {
    id: "main.clearSelection",
    title: "Clear search or selection",
    description: "Clear the active search or close the current selection.",
    scope: "main",
    defaultBinding: "Escape",
    editable: false,
  },
  {
    id: "main.deleteSelection",
    title: "Delete selected item",
    description: "Delete the selected clipboard item or note selection.",
    scope: "main",
    defaultBinding: "Delete",
    editable: false,
  },
  {
    id: "modal.confirm",
    title: "Confirm modal action",
    description: "Submit simple confirm fields like collection create or rename.",
    scope: "modal",
    defaultBinding: "Enter",
    editable: false,
  },
  {
    id: "modal.cancel",
    title: "Cancel modal action",
    description: "Close modal flows without applying changes.",
    scope: "modal",
    defaultBinding: "Escape",
    editable: false,
  },
  {
    id: "editor.submit",
    title: "Submit text entry",
    description: "Save quick add or submit pasted import text.",
    scope: "modal",
    defaultBinding: "Primary+Enter",
    editable: false,
  },
  {
    id: "editor.cancel",
    title: "Cancel text entry",
    description: "Cancel quick add text entry.",
    scope: "modal",
    defaultBinding: "Escape",
    editable: false,
  },
  {
    id: "shared.transientReveal",
    title: "Transient secret reveal",
    description: "Reveal masked secrets while the modifier is held.",
    scope: "shared",
    defaultBinding: "Alt",
    editable: false,
  },
  {
    id: "checklist.toggleSelected",
    title: "Toggle checklist completion",
    description: "Toggle selected checklist items in checklist collections.",
    scope: "checklist",
    defaultBinding: "Space",
    editable: false,
  },
  {
    id: "collection.reorderUp",
    title: "Move selected collection item up",
    description: "Reorder a selected collection item upward.",
    scope: "collection",
    defaultBinding: "Shift+ArrowUp",
    editable: false,
  },
  {
    id: "collection.reorderDown",
    title: "Move selected collection item down",
    description: "Reorder a selected collection item downward.",
    scope: "collection",
    defaultBinding: "Shift+ArrowDown",
    editable: false,
  },
  {
    id: "overlay.moveUp",
    title: "Overlay select previous",
    description: "Move the overlay selection upward.",
    scope: "overlay",
    defaultBinding: "ArrowUp",
    editable: false,
  },
  {
    id: "overlay.moveDown",
    title: "Overlay select next",
    description: "Move the overlay selection downward.",
    scope: "overlay",
    defaultBinding: "ArrowDown",
    editable: false,
  },
  {
    id: "overlay.paste",
    title: "Overlay paste selected",
    description: "Paste the selected overlay entry.",
    scope: "overlay",
    defaultBinding: "Enter",
    editable: false,
  },
  {
    id: "overlay.modifiedPaste",
    title: "Overlay modified paste",
    description: "Open modified paste for the selected overlay entry.",
    scope: "overlay",
    defaultBinding: "Control+Enter",
    editable: false,
  },
  {
    id: "overlay.delete",
    title: "Overlay delete selected",
    description: "Delete the selected overlay entry.",
    scope: "overlay",
    defaultBinding: "Delete",
    editable: false,
  },
  {
    id: "overlay.close",
    title: "Close overlay",
    description: "Close the overlay window.",
    scope: "overlay",
    defaultBinding: "Escape",
    editable: false,
  },
  {
    id: "system.quit",
    title: "Quit app",
    description: "Use the OS quit shortcut.",
    scope: "system",
    defaultBinding: "Alt+F4",
    editable: false,
  },
] as const;

const SHORTCUTS_BY_ID = new Map<ShortcutId, ShortcutDefinition>(
  RESERVED_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]),
);

export const SHORTCUT_CATALOG: readonly ShortcutDefinition[] = RESERVED_SHORTCUTS;

export function getShortcutCatalog(): readonly ShortcutDefinition[] {
  return SHORTCUT_CATALOG;
}

export function getEditableShortcutDefinitions(): Array<ShortcutDefinition & { id: EditableShortcutId; editable: true }> {
  return SHORTCUT_CATALOG.filter(
    (shortcut): shortcut is ShortcutDefinition & { id: EditableShortcutId; editable: true } => shortcut.editable,
  );
}

export function getFixedShortcutDefinitions(): ShortcutDefinition[] {
  return SHORTCUT_CATALOG.filter((shortcut) => !shortcut.editable);
}

export function getShortcutDefinition(id: ShortcutId): ShortcutDefinition {
  const shortcut = SHORTCUTS_BY_ID.get(id);
  if (!shortcut) throw new Error(`Unknown shortcut id: ${id}`);
  return shortcut;
}

export function isEditableShortcutId(value: string): value is EditableShortcutId {
  return getEditableShortcutDefinitions().some((shortcut) => shortcut.id === value);
}

export function getDefaultShortcutBinding(id: ShortcutId): string {
  return getShortcutDefinition(id).defaultBinding;
}

export function resolveEffectiveShortcutBinding(
  id: ShortcutId,
  overrides: ShortcutOverrides = {},
): string {
  const shortcut = getShortcutDefinition(id);
  if (!shortcut.editable) return shortcut.defaultBinding;
  const editableId = shortcut.id as EditableShortcutId;
  return normalizeShortcutBinding(overrides[editableId] ?? shortcut.defaultBinding) ?? shortcut.defaultBinding;
}

export function sanitizeShortcutOverrides(
  overrides: Record<string, unknown> | null | undefined,
): ShortcutOverrides {
  if (!overrides || typeof overrides !== "object") return {};

  const next: ShortcutOverrides = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (!isEditableShortcutId(id) || typeof value !== "string") continue;
    const normalized = normalizeShortcutBinding(value);
    if (!normalized) continue;
    if (normalized === getDefaultShortcutBinding(id)) continue;
    next[id] = normalized;
  }
  return next;
}

export function withShortcutOverride(
  overrides: ShortcutOverrides,
  id: EditableShortcutId,
  binding: string | null,
): ShortcutOverrides {
  const next = { ...sanitizeShortcutOverrides(overrides) };
  if (binding === null) {
    delete next[id];
    return next;
  }

  const normalized = normalizeShortcutBinding(binding);
  if (!normalized || normalized === getDefaultShortcutBinding(id)) {
    delete next[id];
    return next;
  }

  next[id] = normalized;
  return next;
}

export function matchesShortcut(
  id: ShortcutId,
  input: ShortcutMatchInput,
  overrides: ShortcutOverrides = {},
  platform?: string,
): boolean {
  return matchesShortcutBinding(
    resolveEffectiveShortcutBinding(id, overrides),
    input,
    platform,
  );
}

export function matchesShortcutBinding(
  binding: string,
  input: ShortcutMatchInput,
  platform?: string,
): boolean {
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return false;

  if (parsed.modifiers.size === 0 && isModifierKey(parsed.key)) {
    return (
      normalizeEventKey(input.key, input.code) === parsed.key &&
      isModifierActive(parsed.key, input) &&
      input.ctrlKey === (parsed.key === "Control") &&
      input.metaKey === (parsed.key === "Meta") &&
      input.altKey === (parsed.key === "Alt") &&
      input.shiftKey === (parsed.key === "Shift")
    );
  }

  const resolvedModifiers = resolvePrimaryModifier(parsed.modifiers, platform);
  if (input.ctrlKey !== resolvedModifiers.has("Control")) return false;
  if (input.metaKey !== resolvedModifiers.has("Meta")) return false;
  if (input.altKey !== resolvedModifiers.has("Alt")) return false;
  if (input.shiftKey !== resolvedModifiers.has("Shift")) return false;

  const normalizedEventKey = normalizeEventKey(input.key, input.code);
  return normalizedEventKey === parsed.key;
}

export function formatShortcutBinding(binding: string, platform?: string): string {
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return binding;

  const parts = [...MODIFIER_ORDER]
    .filter((modifier) => parsed.modifiers.has(modifier))
    .map((modifier) => formatToken(modifier, platform));
  parts.push(formatToken(parsed.key, platform));
  return parts.join("+");
}

export function getShortcutDisplayLabel(
  id: ShortcutId,
  overrides: ShortcutOverrides = {},
  platform?: string,
): string {
  return formatShortcutBinding(resolveEffectiveShortcutBinding(id, overrides), platform);
}

export function normalizeShortcutBinding(binding: string): string | null {
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return null;

  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => parsed.modifiers.has(modifier));
  return [...orderedModifiers, parsed.key].join("+");
}

export function captureShortcutBinding(
  input: ShortcutMatchInput,
  scope: ShortcutScope,
  platform?: string,
): string | null {
  const key = normalizeEventKey(input.key, input.code);
  if (!key) return null;
  if (isModifierKey(key)) return null;

  const modifiers = new Set<string>();
  if (input.ctrlKey) modifiers.add("Control");
  if (input.metaKey) modifiers.add("Meta");
  if (input.altKey) modifiers.add("Alt");
  if (input.shiftKey) modifiers.add("Shift");

  if (scope !== "global") {
    const primaryModifier = isMacPlatform(platform) ? "Meta" : "Control";
    if (modifiers.has(primaryModifier)) {
      modifiers.delete(primaryModifier);
      modifiers.add("Primary");
    }
  }

  return normalizeShortcutBinding([...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+"));
}

export function validateEditableShortcutBinding(
  id: EditableShortcutId,
  binding: string,
): string | null {
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return "Shortcut is not a valid key combination.";

  const modifierCount = [...parsed.modifiers].filter((modifier) => modifier !== "Shift").length;
  if (modifierCount === 0) {
    return "Editable shortcuts must include Ctrl, Cmd, Alt, or another non-Shift modifier.";
  }

  if (id === "global.showOverlay" && parsed.key === "Alt") {
    return "Global shortcuts must include a non-modifier key.";
  }

  return null;
}

export function findShortcutConflict(
  id: EditableShortcutId,
  binding: string,
  overrides: ShortcutOverrides,
): ShortcutDefinition | null {
  const target = getShortcutDefinition(id);
  const normalized = normalizeShortcutBinding(binding);
  if (!normalized) return null;

  for (const shortcut of SHORTCUT_CATALOG) {
    if (shortcut.id === id || shortcut.scope !== target.scope) continue;
    const otherBinding = resolveEffectiveShortcutBinding(shortcut.id, overrides);
    if (normalizeShortcutBinding(otherBinding) === normalized) {
      return shortcut;
    }
  }

  return null;
}

export function toGlobalShortcutAccelerator(binding: string, platform?: string): string {
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return binding;

  const resolvedModifiers = resolvePrimaryModifier(parsed.modifiers, platform);
  const orderedModifiers = ACTUAL_MODIFIER_ORDER
    .filter((modifier) => resolvedModifiers.has(modifier))
    .map((modifier) => modifier === "Meta" && isMacPlatform(platform) ? "Command" : modifier);

  return [...orderedModifiers, parsed.key].join("+");
}

function parseShortcutBinding(binding: string): ParsedBinding | null {
  const parts = binding
    .split("+")
    .map((part) => normalizeToken(part))
    .filter((part): part is string => Boolean(part));

  if (parts.length === 0) return null;

  const modifiers = new Set<string>();
  let key: string | null = null;

  for (const part of parts) {
    if (isModifierToken(part)) {
      modifiers.add(part);
      continue;
    }

    if (key !== null) return null;
    key = part;
  }

  if (!key) {
    if (modifiers.size === 1) {
      return { modifiers: new Set(), key: [...modifiers][0] ?? "" };
    }
    return null;
  }
  return { modifiers, key };
}

function normalizeToken(token: string): string | null {
  const value = token.trim();
  if (!value) return null;

  const lowered = value.toLowerCase();
  switch (lowered) {
    case "primary":
    case "cmdorctrl":
    case "commandorcontrol":
      return "Primary";
    case "ctrl":
    case "control":
      return "Control";
    case "cmd":
    case "command":
    case "meta":
      return "Meta";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    case "esc":
    case "escape":
      return "Escape";
    case "del":
    case "delete":
      return "Delete";
    case "enter":
    case "return":
      return "Enter";
    case "space":
    case "spacebar":
      return "Space";
    case "arrowup":
    case "up":
      return "ArrowUp";
    case "arrowdown":
    case "down":
      return "ArrowDown";
    default:
      if (value.length === 1) return value.toUpperCase();
      if (/^f\d+$/i.test(value)) return value.toUpperCase();
      return value;
  }
}

function resolvePrimaryModifier(modifiers: Set<string>, platform?: string): Set<string> {
  const resolved = new Set<string>();
  const primaryModifier = isMacPlatform(platform) ? "Meta" : "Control";

  for (const modifier of modifiers) {
    if (modifier === "Primary") {
      resolved.add(primaryModifier);
      continue;
    }
    resolved.add(modifier);
  }

  return resolved;
}

function isMacPlatform(platform?: string): boolean {
  const detected = platform ?? detectPlatform();
  return MAC_PLATFORM_NAMES.has(detected.toLowerCase());
}

function detectPlatform(): string {
  if (typeof navigator === "undefined") return "windows";
  return (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "windows";
}

function normalizeEventKey(key: string, code?: string): string | null {
  if (code === "Space") return "Space";
  return normalizeToken(key);
}

function isModifierToken(token: string): boolean {
  return token === "Primary" || token === "Control" || token === "Meta" || token === "Alt" || token === "Shift";
}

function isModifierKey(key: string): boolean {
  return key === "Control" || key === "Meta" || key === "Alt" || key === "Shift";
}

function isModifierActive(key: string, input: ShortcutMatchInput): boolean {
  switch (key) {
    case "Control":
      return input.ctrlKey;
    case "Meta":
      return input.metaKey;
    case "Alt":
      return input.altKey;
    case "Shift":
      return input.shiftKey;
    default:
      return false;
  }
}

function formatToken(token: string, platform?: string): string {
  switch (token) {
    case "Primary":
      return isMacPlatform(platform) ? "Cmd" : "Ctrl";
    case "Control":
      return "Ctrl";
    case "Meta":
      return isMacPlatform(platform) ? "Cmd" : "Meta";
    case "Alt":
      return isMacPlatform(platform) ? "Option" : "Alt";
    case "Escape":
      return "Esc";
    case "Delete":
      return "Del";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    default:
      return token;
  }
}
