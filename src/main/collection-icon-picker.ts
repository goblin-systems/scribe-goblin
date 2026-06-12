export interface RankedCollectionIcon {
  name: string;
  score: number;
}

export function iconExportNameToKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

export function getCollectionIconNames(
  iconSet: Record<string, unknown>,
): string[] {
  return Array.from(
    new Set(Object.keys(iconSet).map(iconExportNameToKebabCase)),
  ).sort((left, right) => left.localeCompare(right));
}

export function getDefaultCreateCollectionIcon(
  iconSet: Record<string, unknown>,
): string {
  const iconNames = getCollectionIconNames(iconSet);
  return iconNames.includes("folder") ? "folder" : (iconNames[0] ?? "folder");
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function collapse(value: string): string {
  return normalize(value).replace(/[\s_-]+/g, "");
}

function tokenize(value: string): string[] {
  return normalize(value).split(/[\s_-]+/).filter(Boolean);
}

function subsequenceGapScore(query: string, target: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let lastMatchIndex = -1;

  for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
    if (target[targetIndex] !== query[queryIndex]) continue;
    if (firstMatchIndex < 0) firstMatchIndex = targetIndex;
    lastMatchIndex = targetIndex;
    queryIndex += 1;
    if (queryIndex === query.length) break;
  }

  if (queryIndex !== query.length || firstMatchIndex < 0 || lastMatchIndex < 0) {
    return null;
  }

  const span = lastMatchIndex - firstMatchIndex + 1;
  const gaps = Math.max(0, span - query.length);
  return Math.max(0, 200 - gaps * 12 - firstMatchIndex * 3);
}

function scoreCollectionIconName(name: string, rawQuery: string): number | null {
  const query = normalize(rawQuery);
  if (!query) return 0;

  const target = normalize(name);
  const collapsedQuery = collapse(query);
  const collapsedTarget = collapse(target);
  const queryTokens = tokenize(query);
  const targetTokens = tokenize(target);
  let score = 0;

  if (target === query || collapsedTarget === collapsedQuery) score += 1000;
  if (target.startsWith(query)) score += 700;
  if (collapsedTarget.startsWith(collapsedQuery)) score += 650;
  if (target.includes(query)) score += 500 - target.indexOf(query) * 4;
  if (collapsedTarget.includes(collapsedQuery)) {
    score += 460 - collapsedTarget.indexOf(collapsedQuery) * 3;
  }

  let matchedTokens = 0;
  for (const token of queryTokens) {
    if (targetTokens.some((targetToken) => targetToken.startsWith(token))) {
      score += 180;
      matchedTokens += 1;
      continue;
    }
    if (targetTokens.some((targetToken) => targetToken.includes(token))) {
      score += 120;
      matchedTokens += 1;
    }
  }

  const subsequenceScore = subsequenceGapScore(collapsedQuery, collapsedTarget);
  if (subsequenceScore !== null) score += subsequenceScore;

  if (matchedTokens === 0 && subsequenceScore === null && !collapsedTarget.includes(collapsedQuery)) {
    return null;
  }

  return score;
}

export function rankCollectionIconNames(
  iconNames: readonly string[],
  query: string,
): RankedCollectionIcon[] {
  return iconNames
    .map((name) => {
      const score = scoreCollectionIconName(name, query);
      return score === null ? null : { name, score };
    })
    .filter((icon): icon is RankedCollectionIcon => icon !== null)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

export function filterCollectionIconNames(
  iconNames: readonly string[],
  query: string,
): string[] {
  return rankCollectionIconNames(iconNames, query).map((icon) => icon.name);
}
