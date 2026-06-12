import { invoke } from "@tauri-apps/api/core";
import type { CollectionRow, CollectionType, EntryRow } from "../store";

export type ActiveView =
  | { kind: "clipboard" }
  | { kind: "collection"; collectionId: string };

export const NOTES_COLLECTION_ID = "notes";

export interface ReorderCapability {
  enabled: boolean;
  reason: "ok" | "clipboard" | "search-active" | "multi-selection" | "same-item" | "cross-checklist-group";
}

export function getAdjacentCollectionId(
  collections: CollectionRow[],
  currentCollectionId: string,
  delta: -1 | 1,
): string | null {
  const currentIndex = collections.findIndex(
    (collection) => collection.id === currentCollectionId,
  );
  if (currentIndex === -1) return null;
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= collections.length) return null;
  return collections[nextIndex]?.id ?? null;
}

export function getAdjacentSelectedEntryId(
  entries: Array<Pick<EntryRow, "id">>,
  selectedIds: string[],
  delta: -1 | 1,
): string | null {
  if (entries.length === 0 || selectedIds.length === 0) return null;
  const currentIndex = entries.findIndex((entry) => entry.id === selectedIds[0]);
  if (currentIndex === -1) return null;
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= entries.length) return null;
  return entries[nextIndex]?.id ?? null;
}

export function isSystemCollection(collection: CollectionRow): boolean {
  return collection.kind === "system";
}

export function canDeleteCollection(collection: CollectionRow): boolean {
  return collection.id !== NOTES_COLLECTION_ID;
}

export function canRenameCollection(collection: CollectionRow): boolean {
  return collection.id !== NOTES_COLLECTION_ID;
}

export function getDefaultCollectionId(collections: CollectionRow[]): string {
  return (
    collections.find((collection) => collection.id === NOTES_COLLECTION_ID)
      ?.id ??
    collections[0]?.id ??
    NOTES_COLLECTION_ID
  );
}

export function getCollectionIcon(collection: CollectionRow): string {
  const explicitIcon = collection.icon?.trim();
  if (explicitIcon) return explicitIcon;

  if (collection.collection_type === "filter") return "filter";

  switch (collection.slug) {
    case "notes":
      return "sticky-note";
    case "todo":
      return "square-check-big";
    case "shopping-list":
      return "shopping-cart";
    default:
      return "folder";
  }
}

export function isChecklistCollection(collection: CollectionRow): boolean {
  return collection.collection_type === "checklist";
}

export function isFilterCollection(collection: CollectionRow): boolean {
  return collection.collection_type === "filter";
}

export function getNextChecklistCompletedState(
  entries: Array<Pick<EntryRow, "checklist_completed">>,
): boolean | null {
  if (entries.length === 0) return null;
  return entries.every((entry) => entry.checklist_completed) ? false : true;
}

export function getNextCollectionType(
  collectionType: CollectionType,
): CollectionType {
  if (collectionType === "standard") return "checklist";
  if (collectionType === "checklist") return "filter";
  return "standard";
}

export function sortEntriesForCollection(
  entries: EntryRow[],
  collection: CollectionRow | null,
): EntryRow[] {
  if (
    !collection ||
    isFilterCollection(collection) ||
    !isChecklistCollection(collection) ||
    entries.length < 2
  ) {
    return entries;
  }

  const incomplete = entries.filter((entry) => !entry.checklist_completed);
  const completed = entries.filter((entry) => entry.checklist_completed);
  return [...incomplete, ...completed];
}

export function canManuallyReorderCollectionEntries(args: {
  collection: CollectionRow | null;
  searchQuery: string;
  selectedIds: string[];
  entry: Pick<EntryRow, "id" | "checklist_completed">;
  target: Pick<EntryRow, "id" | "checklist_completed">;
}): ReorderCapability {
  const { collection, searchQuery, selectedIds, entry, target } = args;

  if (!collection) {
    return { enabled: false, reason: "clipboard" };
  }

  if (searchQuery.trim().length > 0) {
    return { enabled: false, reason: "search-active" };
  }

  if (selectedIds.length !== 1 || selectedIds[0] !== entry.id) {
    return { enabled: false, reason: "multi-selection" };
  }

  if (entry.id === target.id) {
    return { enabled: false, reason: "same-item" };
  }

  if (
    isChecklistCollection(collection) &&
    entry.checklist_completed !== target.checklist_completed
  ) {
    return { enabled: false, reason: "cross-checklist-group" };
  }

  return { enabled: true, reason: "ok" };
}

export async function listCollections(): Promise<CollectionRow[]> {
  return invoke<CollectionRow[]>("db_list_collections");
}

export async function createCollection(
  name: string,
  icon: string | null,
  collectionType: CollectionType,
  filterQuery?: string | null,
): Promise<CollectionRow> {
  return invoke<CollectionRow>("db_create_collection", {
    name,
    icon,
    collectionType,
    filterQuery,
  });
}

export async function updateCollectionType(
  id: string,
  collectionType: CollectionType,
  filterQuery?: string | null,
): Promise<void> {
  await invoke("db_update_collection_type", {
    id,
    collectionType,
    filterQuery,
  });
}

export async function renameCollection(
  id: string,
  name: string,
): Promise<CollectionRow> {
  return invoke<CollectionRow>("db_rename_collection", {
    id,
    name,
  });
}

export async function duplicateCollection(id: string): Promise<CollectionRow> {
  return invoke<CollectionRow>("db_duplicate_collection", { id });
}

export async function deleteCollection(
  id: string,
  moveEntriesToCollectionId: string | null,
): Promise<void> {
  await invoke("db_delete_collection", {
    id,
    moveEntriesToCollectionId,
  });
}

export async function moveEntriesToCollection(
  ids: string[],
  collectionId: string | null,
): Promise<void> {
  await invoke("db_move_entries_to_collection", {
    ids,
    collectionId,
  });
}

export async function copyEntriesToCollection(
  ids: string[],
  collectionId: string | null,
): Promise<void> {
  await invoke("db_copy_entries_to_collection", {
    ids,
    collectionId,
  });
}

export async function listCollectionEntries(
  collectionId: string,
  limit: number,
): Promise<EntryRow[]> {
  return invoke<EntryRow[]>("db_list_collection_entries", {
    collectionId,
    limit,
  });
}

export async function reorderCollectionEntry(args: {
  collectionId: string;
  entryId: string;
  targetEntryId: string;
  position: "before" | "after";
}): Promise<void> {
  await invoke("db_reorder_collection_entry", args);
}

export async function reorderCollection(args: {
  collectionId: string;
  targetCollectionId: string;
  position: "before" | "after";
}): Promise<void> {
  await invoke("db_reorder_collection", args);
}
