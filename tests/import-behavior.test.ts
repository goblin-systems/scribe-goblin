import { describe, expect, test } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { overlayFooterHintText, type EntryRow } from "../src/store";

describe("Epic 001 import behavior", () => {
  test("keeps attachment-only imports note-like for Notes visibility", async () => {
    const [entry] = await invoke<EntryRow[]>("import_capture", {
      payloads: [{
        kind: "file",
        name: "diagram.png",
        contentType: "image/png",
        importOrigin: "file-picker",
        fileBytesBase64: "AA==",
      }],
    });

    expect(entry.is_note).toBe(true);
    expect(entry.attachment_rel_path).toMatch(/^attachments\/.+\.png$/);
  });

  test("treats empty-mime markdown picker imports as text", async () => {
    const [entry] = await invoke<EntryRow[]>("import_capture", {
      payloads: [{
        kind: "file",
        name: "meeting-notes.md",
        contentType: null,
        importOrigin: "file-picker",
        fileBytesBase64: "IyBIZWxsbyB3b3JsZA==",
      }],
    });

    expect(entry.is_note).toBe(true);
    expect(entry.content_type).toBe("text/plain");
    expect(entry.attachment_rel_path).toBeNull();
  });

  test("uses paste as the default overlay footer hint", () => {
    expect(overlayFooterHintText(null)).toBe("Paste");
    expect(overlayFooterHintText({ attachment_rel_path: "attachments/file.png" })).toBe(
      "Attachment-only import selected — paste is blocked",
    );
  });
});
