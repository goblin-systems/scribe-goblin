import { invoke } from "@tauri-apps/api/core";

let enabled = false;

export function configureDebugLogging(isEnabled: boolean): void {
  enabled = isEnabled;
  invoke("set_debug_logging_enabled", { enabled: isEnabled }).catch(() => {});
}

export function debugLog(message: string, level: "INFO" | "WARN" | "ERROR" = "INFO"): void {
  if (!enabled) return;
  invoke("write_debug_log", { level, message }).catch(() => {});
}

export function isDebugLoggingEnabled(): boolean {
  return enabled;
}

export async function openDebugLogFolder(): Promise<void> {
  await invoke("open_debug_log_folder");
}
