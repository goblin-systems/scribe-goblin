import { isUiTheme, type UiTheme } from "@goblin-systems/goblin-design-system";

export function resolveStoredUiTheme(theme: string | null | undefined): UiTheme {
  return isUiTheme(theme) ? theme : "goblin";
}
