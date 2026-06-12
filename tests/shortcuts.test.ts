import { describe, expect, test } from "vitest";
import {
  captureShortcutBinding,
  findShortcutConflict,
  formatShortcutBinding,
  getShortcutDisplayLabel,
  matchesShortcut,
  normalizeShortcutBinding,
  resolveEffectiveShortcutBinding,
  sanitizeShortcutOverrides,
  toGlobalShortcutAccelerator,
  validateEditableShortcutBinding,
  withShortcutOverride,
} from "../src/shortcuts";

describe("shortcut catalog helpers", () => {
  test("resolves editable overrides with defaults fallback", () => {
    const overrides = sanitizeShortcutOverrides({ "main.newItem": "Primary+Shift+N" });
    expect(resolveEffectiveShortcutBinding("main.newItem", overrides)).toBe("Primary+Shift+N");
    expect(resolveEffectiveShortcutBinding("main.openImport", overrides)).toBe("Primary+I");
    expect(resolveEffectiveShortcutBinding("overlay.close", overrides)).toBe("Escape");
  });

  test("formats labels for runtime display", () => {
    expect(getShortcutDisplayLabel("main.newItem", {}, "windows")).toBe("Ctrl+N");
    expect(formatShortcutBinding("Primary+Shift+N", "darwin")).toBe("Cmd+Shift+N");
  });

  test("matches editable shortcuts through overrides", () => {
    const overrides = withShortcutOverride({}, "main.focusSearch", "Primary+K");
    expect(matchesShortcut("main.focusSearch", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, overrides, "win32")).toBe(true);
    expect(matchesShortcut("main.focusSearch", {
      key: "f",
      code: "KeyF",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, overrides, "win32")).toBe(false);
  });

  test("captures renderer shortcuts using Primary for non-global scope", () => {
    expect(captureShortcutBinding({
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, "main", "win32")).toBe("Primary+Shift+K");
  });

  test("normalizes and validates editable bindings", () => {
    expect(normalizeShortcutBinding("ctrl+k")).toBe("Control+K");
    expect(validateEditableShortcutBinding("main.newItem", "Shift+N")).toContain("must include");
    expect(validateEditableShortcutBinding("main.newItem", "Primary+Shift+N")).toBeNull();
  });

  test("detects same-scope conflicts", () => {
    const conflict = findShortcutConflict("main.newItem", "Primary+I", {});
    expect(conflict?.id).toBe("main.openImport");
  });

  test("converts global bindings to tauri accelerators", () => {
    expect(toGlobalShortcutAccelerator("Control+Alt+V", "win32")).toBe("Control+Alt+V");
    expect(toGlobalShortcutAccelerator("Primary+Alt+V", "darwin")).toBe("Command+Alt+V");
  });
});
