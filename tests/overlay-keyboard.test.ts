import { describe, expect, test } from "vitest";
import { getOverlayKeydownAction, getOverlayKeyupAction } from "../src/overlay-keyboard";

describe("overlay keyboard handling", () => {
  test("Ctrl+Enter opens modified paste when menu is closed", () => {
    expect(
      getOverlayKeydownAction({
        key: "Enter",
        code: "Enter",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isContextMenuOpen: false,
      }),
    ).toBe("open-modified-paste");
  });

  test("plain Enter remains normal paste when menu is closed", () => {
    expect(
      getOverlayKeydownAction({
        key: "Enter",
        code: "Enter",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isContextMenuOpen: false,
      }),
    ).toBe("paste");
  });

  test("overlay shortcuts are suppressed while menu is open", () => {
    expect(
      getOverlayKeydownAction({
        key: "ArrowDown",
        code: "ArrowDown",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isContextMenuOpen: true,
      }),
    ).toBe("none");

    expect(
      getOverlayKeydownAction({
        key: "Enter",
        code: "Enter",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isContextMenuOpen: true,
      }),
    ).toBe("none");

    expect(
      getOverlayKeydownAction({
        key: "Delete",
        code: "Delete",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isContextMenuOpen: true,
      }),
    ).toBe("none");

    expect(
      getOverlayKeydownAction({
        key: "Escape",
        code: "Escape",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isContextMenuOpen: true,
      }),
    ).toBe("none");
  });

  test("Alt reveal remains active regardless of menu state", () => {
    expect(
      getOverlayKeydownAction({
        key: "Alt",
        code: "AltLeft",
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
        isContextMenuOpen: true,
      }),
    ).toBe("reveal-on");

    expect(getOverlayKeyupAction("Alt")).toBe("reveal-off");
  });
});
