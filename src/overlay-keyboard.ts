import { matchesShortcut } from "./shortcuts";

export type OverlayKeyboardAction =
  | "none"
  | "reveal-on"
  | "reveal-off"
  | "move-down"
  | "move-up"
  | "paste"
  | "open-modified-paste"
  | "delete"
  | "close";

export function getOverlayKeydownAction(input: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isContextMenuOpen: boolean;
}): OverlayKeyboardAction {
  if (matchesShortcut("shared.transientReveal", {
    key: input.key,
    code: input.code,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
    shiftKey: input.shiftKey ?? false,
  })) {
    return "reveal-on";
  }

  if (input.isContextMenuOpen) {
    return "none";
  }

  if (matchesShortcut("overlay.moveDown", {
    key: input.key,
    code: input.code,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
    shiftKey: input.shiftKey ?? false,
  })) {
    return "move-down";
  }

  if (matchesShortcut("overlay.moveUp", {
    key: input.key,
    code: input.code,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
    shiftKey: input.shiftKey ?? false,
  })) {
    return "move-up";
  }

  if (matchesShortcut("overlay.modifiedPaste", {
    key: input.key,
    code: input.code,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
    shiftKey: input.shiftKey ?? false,
  })) {
    return "open-modified-paste";
  }

  if (matchesShortcut("overlay.paste", {
    key: input.key,
    code: input.code,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
    shiftKey: input.shiftKey ?? false,
  })) {
    return "paste";
  }

  if (matchesShortcut("overlay.delete", {
    key: input.key,
    code: input.code,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
    shiftKey: input.shiftKey ?? false,
  })) {
    return "delete";
  }

  if (matchesShortcut("overlay.close", {
    key: input.key,
    code: input.code,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
    shiftKey: input.shiftKey ?? false,
  })) {
    return "close";
  }

  return "none";
}

export function getOverlayKeyupAction(key: string): OverlayKeyboardAction {
  return key === "Alt" ? "reveal-off" : "none";
}
