import { parseBadgeInput } from "./add-badge-modal";

function normalizeBadgeName(value: string): string {
  return value.trim().toLowerCase();
}

export function appendBadgeToInputValue(
  currentValue: string,
  badge: string,
): string {
  const normalizedBadge = normalizeBadgeName(badge);
  if (!normalizedBadge) return currentValue;

  const existingBadges = parseBadgeInput(currentValue);
  if (
    existingBadges.some(
      (existingBadge) => normalizeBadgeName(existingBadge) === normalizedBadge,
    )
  ) {
    return existingBadges.join(", ");
  }

  return [...existingBadges, badge.trim()].join(", ");
}
