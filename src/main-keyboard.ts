import { matchesShortcut, type ShortcutOverrides } from "./shortcuts";

export interface FocusActiveSearchShortcutInput {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isTargetEditable: boolean;
  isTargetActiveSearchInput: boolean;
}

export function shouldFocusActiveSearchInput(
  input: FocusActiveSearchShortcutInput,
  overrides: ShortcutOverrides = {},
  platform?: string,
): boolean {
  if (
    !matchesShortcut(
      "main.focusSearch",
      {
        key: input.key,
        code: input.code,
        ctrlKey: input.ctrlKey,
        metaKey: input.metaKey,
        altKey: input.altKey,
        shiftKey: input.shiftKey,
      },
      overrides,
      platform,
    )
  ) {
    return false;
  }
  if (input.isTargetEditable && !input.isTargetActiveSearchInput) return false;
  return true;
}
