import { describe, expect, test } from "vitest";
import { shouldFocusActiveSearchInput } from "../src/main-keyboard";

describe("main window search shortcut", () => {
  test("handles Ctrl+F from non-editable targets", () => {
    expect(
      shouldFocusActiveSearchInput({
        key: "f",
        code: "KeyF",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isTargetEditable: false,
        isTargetActiveSearchInput: false,
      }),
    ).toBe(true);
  });

  test("handles Cmd+F from non-editable targets", () => {
    expect(
      shouldFocusActiveSearchInput({
        key: "F",
        code: "KeyF",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
        isTargetEditable: false,
        isTargetActiveSearchInput: false,
      }, {}, "darwin"),
    ).toBe(true);
  });

  test("does not steal Ctrl+F from other editable targets", () => {
    expect(
      shouldFocusActiveSearchInput({
        key: "f",
        code: "KeyF",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isTargetEditable: true,
        isTargetActiveSearchInput: false,
      }),
    ).toBe(false);
  });

  test("allows Ctrl+F when active search is already focused", () => {
    expect(
      shouldFocusActiveSearchInput({
        key: "f",
        code: "KeyF",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isTargetEditable: true,
        isTargetActiveSearchInput: true,
      }),
    ).toBe(true);
  });

  test("ignores unrelated shortcuts", () => {
    expect(
      shouldFocusActiveSearchInput({
        key: "n",
        code: "KeyN",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isTargetEditable: false,
        isTargetActiveSearchInput: false,
      }),
    ).toBe(false);
  });
});
