import { describe, expect, test } from "vitest";
import { applyModifiedPasteTransform } from "../src/overlay-modified-paste";

describe("overlay modified paste transforms", () => {
  test("covers requested case conversions", () => {
    expect(applyModifiedPasteTransform("Hello world", "upper-case")).toBe("HELLO WORLD");
    expect(applyModifiedPasteTransform("Hello WORLD", "lower-case")).toBe("hello world");
    expect(applyModifiedPasteTransform(" hello WORLD_again", "capitalise-first")).toBe(" Hello WORLD_again");
    expect(applyModifiedPasteTransform("hello WORLD_again", "capitalise-all")).toBe("Hello World_Again");
    expect(applyModifiedPasteTransform("Hello wORLD! 123", "invert-case")).toBe("hELLO World! 123");
  });

  test("capitalise first only changes the first letter of the full payload", () => {
    expect(applyModifiedPasteTransform("\n\télan vital", "capitalise-first")).toBe("\n\tÉlan vital");
    expect(applyModifiedPasteTransform("123abc def", "capitalise-first")).toBe("123Abc def");
  });

  test("normalizes separator-based transforms from mixed input", () => {
    const input = "  helloHTTP_world-test value  ";

    expect(applyModifiedPasteTransform(input, "kebab-case")).toBe("hello-http-world-test-value");
    expect(applyModifiedPasteTransform(input, "snake-case")).toBe("hello_http_world_test_value");
    expect(applyModifiedPasteTransform(input, "pascal-case")).toBe("HelloHttpWorldTestValue");
    expect(applyModifiedPasteTransform(input, "camel-case")).toBe("helloHttpWorldTestValue");
  });

  test("trims outer whitespace without altering inner spacing", () => {
    expect(applyModifiedPasteTransform("  keep   inner spacing  ", "trim-whitespace")).toBe("keep   inner spacing");
  });

  test("replaces newline runs with single spaces", () => {
    expect(applyModifiedPasteTransform("alpha\r\n beta\n\n gamma", "remove-new-lines")).toBe("alpha beta gamma");
  });
});
