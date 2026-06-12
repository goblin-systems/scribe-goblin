import { describe, expect, test } from "vitest";
import { appendBadgeToInputValue } from "../src/main/quick-add-badges";

describe("quick add badge suggestions", () => {
  test("appends a clicked suggestion to the badge input", () => {
    expect(appendBadgeToInputValue("todo, work", "urgent")).toBe(
      "todo, work, urgent",
    );
  });

  test("skips duplicates already present in the input", () => {
    expect(appendBadgeToInputValue("todo, Work", "work")).toBe("todo, Work");
  });

  test("keeps freeform formatting trimmed when input is messy", () => {
    expect(appendBadgeToInputValue(" todo ,  work  ", "later")).toBe(
      "todo, work, later",
    );
  });
});
