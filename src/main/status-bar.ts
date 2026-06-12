import type { Settings } from "../settings";
import {
  parseManualBadges,
  type EntryRow,
  type SearchEntryResult,
} from "../store";

const APP_VERSION = "0.1.0";

export interface StatusBarContext {
  entries: EntryRow[];
  query: string;
  results: SearchEntryResult[];
  settings: Settings;
}

interface StatusChip {
  label: string;
  value: string;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summarizeEmbeddingMode(settings: Settings): string {
  switch (settings.embeddingProvider) {
    case "none":
      return "off";
    case "local":
      return "local";
    case "openai":
    case "gemini":
    case "ollama":
      return settings.embeddingModel
        ? `${settings.embeddingProvider}:${settings.embeddingModel}`
        : settings.embeddingProvider;
    default:
      return settings.embeddingProvider;
  }
}

function summarizeBadgeCount(entries: EntryRow[]): string {
  const badges = new Set<string>();
  for (const entry of entries) {
    const autoBadge = entry.label?.trim().toLowerCase();
    if (autoBadge && autoBadge !== "other") {
      badges.add(autoBadge);
    }
    for (const badge of parseManualBadges(entry.manual_badges)) {
      const normalized = badge.name.trim().toLowerCase();
      if (normalized) badges.add(normalized);
    }
  }
  return pluralize(badges.size, "badge");
}

export function buildStatusBarChips(
  context: StatusBarContext,
): Array<{ label: string; value: string }> {
  const { entries, settings } = context;

  const chips: StatusChip[] = [
    { label: "embed", value: summarizeEmbeddingMode(settings) },
    { label: "badges", value: summarizeBadgeCount(entries) },
    { label: "build", value: `v${APP_VERSION}` },
  ];

  return chips;
}

export function renderStatusBarChips(
  container: HTMLElement,
  context: StatusBarContext,
): void {
  const chips = buildStatusBarChips(context).map(({ label, value }) => {
    const chip = document.createElement("span");
    chip.className = "editor-status-chip";

    const chipLabel = document.createElement("span");
    chipLabel.className = "editor-status-chip-label";
    chipLabel.textContent = label;

    const chipValue = document.createElement("span");
    chipValue.className = "editor-status-chip-value";
    chipValue.textContent = value;
    chipValue.title = value;

    chip.append(chipLabel, chipValue);
    return chip;
  });

  container.replaceChildren(...chips);
}
