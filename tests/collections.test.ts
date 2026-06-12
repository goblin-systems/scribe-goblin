import { describe, expect, test } from "vitest";
import {
  canDeleteCollection,
  canManuallyReorderCollectionEntries,
  canRenameCollection,
  getAdjacentCollectionId,
  getAdjacentSelectedEntryId,
  getCollectionIcon,
  getNextChecklistCompletedState,
  getNextCollectionType,
  isChecklistCollection,
  sortEntriesForCollection,
} from "../src/main/collections";
import {
  filterCollectionIconNames,
  getDefaultCreateCollectionIcon,
  getCollectionIconNames,
  iconExportNameToKebabCase,
} from "../src/main/collection-icon-picker";

describe("getCollectionIcon", () => {
  test("prefers persisted collection icons", () => {
    expect(
      getCollectionIcon({
        id: "recipes",
        slug: "recipes",
        name: "Recipes",
        icon: "book-open",
        collection_type: "standard",
        kind: "user",
        sort_order: 3,
        created_at: 0,
        updated_at: 0,
      }),
    ).toBe("book-open");
  });

  test("keeps fallback icons for collections without explicit icons", () => {
    expect(
      getCollectionIcon({
        id: "notes",
        slug: "notes",
        name: "Notes",
        icon: null,
        collection_type: "standard",
        kind: "system",
        sort_order: 0,
        created_at: 0,
        updated_at: 0,
      }),
    ).toBe("sticky-note");

    expect(
      getCollectionIcon({
        id: "user-1",
        slug: "reading-list",
        name: "Reading List",
        icon: null,
        collection_type: "standard",
        kind: "user",
        sort_order: 4,
        created_at: 0,
        updated_at: 0,
      }),
    ).toBe("folder");
  });

  test("identifies checklist collections without changing kind semantics", () => {
    expect(
      isChecklistCollection({
        id: "todo",
        slug: "todo",
        name: "Todo",
        icon: null,
        collection_type: "checklist",
        kind: "system",
        sort_order: 1,
        created_at: 0,
        updated_at: 0,
      }),
    ).toBe(true);
  });

  test("sorts completed checklist entries to the bottom while preserving group order", () => {
    const entries = sortEntriesForCollection(
      [
        { id: "1", checklist_completed: true },
        { id: "2", checklist_completed: false },
        { id: "3", checklist_completed: false },
        { id: "4", checklist_completed: true },
      ] as any,
      {
        id: "todo",
        slug: "todo",
        name: "Todo",
        icon: null,
        collection_type: "checklist",
        kind: "system",
        sort_order: 1,
        created_at: 0,
        updated_at: 0,
      },
    );

    expect(entries.map((entry) => entry.id)).toEqual(["2", "3", "1", "4"]);
  });

  test("treats mixed checklist selection as complete unless all selected are complete", () => {
    expect(
      getNextChecklistCompletedState([
        { checklist_completed: true },
        { checklist_completed: false },
      ]),
    ).toBe(true);
    expect(
      getNextChecklistCompletedState([
        { checklist_completed: true },
        { checklist_completed: true },
      ]),
    ).toBe(false);
    expect(getNextChecklistCompletedState([])).toBeNull();
  });

  test("computes the opposite collection type for conversion actions", () => {
    expect(getNextCollectionType("standard")).toBe("checklist");
    expect(getNextCollectionType("checklist")).toBe("filter");
    expect(getNextCollectionType("filter")).toBe("standard");
  });

  test("finds adjacent collections and selected items", () => {
    const collections = [
      { id: "notes" },
      { id: "todo" },
      { id: "recipes" },
    ] as any;
    expect(getAdjacentCollectionId(collections, "todo", -1)).toBe("notes");
    expect(getAdjacentCollectionId(collections, "todo", 1)).toBe("recipes");
    expect(getAdjacentCollectionId(collections, "notes", -1)).toBeNull();

    const entries = [{ id: "1" }, { id: "2" }, { id: "3" }] as any;
    expect(getAdjacentSelectedEntryId(entries, ["2"], -1)).toBe("1");
    expect(getAdjacentSelectedEntryId(entries, ["2"], 1)).toBe("3");
    expect(getAdjacentSelectedEntryId(entries, [], 1)).toBeNull();
  });

  test("allows manual reorder only for single selected unfiltered collection items", () => {
    expect(
      canManuallyReorderCollectionEntries({
        collection: {
          id: "recipes",
          slug: "recipes",
          name: "Recipes",
          icon: null,
          collection_type: "standard",
          kind: "user",
          sort_order: 3,
          created_at: 0,
          updated_at: 0,
        },
        searchQuery: "",
        selectedIds: ["1"],
        entry: { id: "1", checklist_completed: false },
        target: { id: "2", checklist_completed: false },
      }),
    ).toEqual({ enabled: true, reason: "ok" });

    expect(
      canManuallyReorderCollectionEntries({
        collection: {
          id: "recipes",
          slug: "recipes",
          name: "Recipes",
          icon: null,
          collection_type: "standard",
          kind: "user",
          sort_order: 3,
          created_at: 0,
          updated_at: 0,
        },
        searchQuery: "active",
        selectedIds: ["1"],
        entry: { id: "1", checklist_completed: false },
        target: { id: "2", checklist_completed: false },
      }).reason,
    ).toBe("search-active");

    expect(
      canManuallyReorderCollectionEntries({
        collection: {
          id: "todo",
          slug: "todo",
          name: "Todo",
          icon: null,
          collection_type: "checklist",
          kind: "system",
          sort_order: 1,
          created_at: 0,
          updated_at: 0,
        },
        searchQuery: "",
        selectedIds: ["1"],
        entry: { id: "1", checklist_completed: false },
        target: { id: "2", checklist_completed: true },
      }).reason,
    ).toBe("cross-checklist-group");
  });

  test("only protects Notes from collection deletion", () => {
    expect(
      canDeleteCollection({
        id: "notes",
        slug: "notes",
        name: "Notes",
        icon: null,
        collection_type: "standard",
        kind: "system",
        sort_order: 0,
        created_at: 0,
        updated_at: 0,
      }),
    ).toBe(false);

    expect(
      canDeleteCollection({
        id: "todo",
        slug: "todo",
        name: "Todo",
        icon: null,
        collection_type: "checklist",
        kind: "system",
        sort_order: 1,
        created_at: 0,
        updated_at: 0,
      }),
    ).toBe(true);
  });

  test("only protects Notes from renaming", () => {
    expect(
      canRenameCollection({
        id: "notes",
        slug: "notes",
        name: "Notes",
        icon: null,
        collection_type: "standard",
        kind: "system",
        sort_order: 0,
        created_at: 0,
        updated_at: 0,
      }),
    ).toBe(false);

    expect(
      canRenameCollection({
        id: "todo",
        slug: "todo",
        name: "Todo",
        icon: null,
        collection_type: "checklist",
        kind: "system",
        sort_order: 1,
        created_at: 0,
        updated_at: 0,
      }),
    ).toBe(true);

    expect(
      canRenameCollection({
        id: "recipes",
        slug: "recipes",
        name: "Recipes",
        icon: null,
        collection_type: "standard",
        kind: "user",
        sort_order: 3,
        created_at: 0,
        updated_at: 0,
      }),
    ).toBe(true);
  });
});

describe("filterCollectionIconNames", () => {
  test("normalizes icon export names to kebab-case for the picker", () => {
    expect(iconExportNameToKebabCase("Folder")).toBe("folder");
    expect(iconExportNameToKebabCase("SquareCheckBig")).toBe(
      "square-check-big",
    );
    expect(iconExportNameToKebabCase("ALargeSmall")).toBe("a-large-small");
  });

  test("builds kebab-case icon names from the icon set", () => {
    expect(
      getCollectionIconNames({
        Folder: {},
        SquareCheckBig: {},
        FolderClosed: {},
      }),
    ).toEqual(["folder", "folder-closed", "square-check-big"]);
  });

  test("defaults new collection creation to folder when available", () => {
    expect(
      getDefaultCreateCollectionIcon({
        Folder: {},
        SquareCheckBig: {},
        BookOpen: {},
      }),
    ).toBe("folder");
  });

  test("supports fuzzy-ish partial matching", () => {
    const ranked = filterCollectionIconNames(
      ["reply", "replace", "folder", "repeat"],
      "repl",
    );

    expect(ranked.slice(0, 2)).toEqual(["replace", "reply"]);
  });
});
