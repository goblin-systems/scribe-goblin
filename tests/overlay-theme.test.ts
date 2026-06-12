import { describe, expect, test } from "vitest";
import { resolveStoredUiTheme } from "../src/overlay-theme";

describe("overlay theme resolution", () => {
  test("returns persisted built-in themes", () => {
    expect(resolveStoredUiTheme("goblin")).toBe("goblin");
    expect(resolveStoredUiTheme("dark")).toBe("dark");
    expect(resolveStoredUiTheme("light")).toBe("light");
  });

  test("falls back to goblin for unknown values", () => {
    expect(resolveStoredUiTheme("unknown")).toBe("goblin");
    expect(resolveStoredUiTheme(null)).toBe("goblin");
    expect(resolveStoredUiTheme(undefined)).toBe("goblin");
  });
});
