import {
  applyIcons,
  bindNavigation,
  closeModal,
  openModal,
  setTheme,
  setupWindowControls,
  showToast,
  type UiTheme,
} from "@goblin-systems/goblin-design-system";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { ScribeDom } from "./dom";
import {
  configureDebugLogging,
  debugLog,
  isDebugLoggingEnabled,
  openDebugLogFolder,
} from "../logger";
import { saveSettings, type Settings } from "../settings";

// ── Public interface ────────────────────────────────────────────────────────

export interface ShellControllerOptions {
  dom: ScribeDom;
  getSettings: () => Settings;
  setSettings: (s: Settings) => void;
}

// ── Setup ───────────────────────────────────────────────────────────────────

export function setupShell(options: ShellControllerOptions) {
  const { dom, getSettings, setSettings } = options;

  let uiStore: Store | null = null;

  async function getUiStore(): Promise<Store> {
    if (!uiStore) {
      uiStore = await load("settings.json", { autoSave: true, defaults: {} });
    }
    return uiStore;
  }

  // ── Window controls ─────────────────────────────────────────────────────
  debugLog("setupShell: initialising window controls");
  setupWindowControls();

  // ── Icons ───────────────────────────────────────────────────────────────
  debugLog("setupShell: applying icons");
  applyIcons();

  // ── Navigation ──────────────────────────────────────────────────────────
  debugLog("setupShell: binding navigation");
  bindNavigation({
    onSelect: (id) => {
      debugLog(`nav select: "${id}"`);
      handleNavSelect(id);
    },
  });

  // ── Sidebar view switching ──────────────────────────────────────────────
  const sidebarBtns = document.querySelectorAll<HTMLElement>(".sidebar-nav-item");
  debugLog(`setupShell: found ${sidebarBtns.length} sidebar nav items`);
  sidebarBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset["view"];
      if (!view) return;
      debugLog(`sidebar: switching to view "${view}"`);
      switchView(view);
      sidebarBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
    });
  });

  // ── Modal reject buttons ────────────────────────────────────────────────
  bindModalRejectButtons(dom.captureSettingsModal, "capture-settings");
  bindModalRejectButtons(dom.providersSettingsModal, "providers-settings");
  bindModalRejectButtons(dom.embeddingsSettingsModal, "embeddings-settings");
  bindModalRejectButtons(dom.enrichmentSettingsModal, "enrichment-settings");
  bindModalRejectButtons(dom.trufflehogSettingsModal, "trufflehog-settings");
  bindModalRejectButtons(dom.debugSettingsModal, "debug-settings");
  bindModalRejectButtons(dom.aboutModal, "about");
  bindModalRejectButtons(dom.addBadgeModal, "add-badge");

  // ── Overlay buttons ─────────────────────────────────────────────────────
  dom.showOverlayBtn.addEventListener("click", () => {
    debugLog("overlay: triggered from sidebar button");
    void showOverlay();
  });
  dom.showOverlayStatusBtn.addEventListener("click", () => {
    debugLog("overlay: triggered from status bar button");
    void showOverlay();
  });

  debugLog("setupShell: done");

  // ── Nav handler ─────────────────────────────────────────────────────────

  function handleNavSelect(id: string) {
    switch (id) {
      case "new-note":
        debugLog("nav: new note");
        dom.quickAddForm.hidden = false;
        dom.quickAddInput.focus();
        break;

      case "quit":
        debugLog("nav: quit requested");
        window.__TAURI__?.core
          .invoke("plugin:window|close")
          .catch((err) => {
            debugLog(`nav: quit via invoke failed (${err}), falling back to window.close()`, "WARN");
            window.close();
          });
        break;

      case "toggle-sidebar":
        toggleSidebar();
        break;

      case "set-theme-goblin":
        applyThemeAndSave("goblin");
        syncThemeMenuIcons("goblin");
        break;

      case "set-theme-dark":
        applyThemeAndSave("dark");
        syncThemeMenuIcons("dark");
        break;

      case "set-theme-light":
        applyThemeAndSave("light");
        syncThemeMenuIcons("light");
        break;

      case "open-capture-settings":
        openCaptureSettings();
        break;

      case "open-providers-settings":
        debugLog("nav: opening providers settings modal");
        openModal({ backdrop: dom.providersSettingsModal });
        break;

      case "open-embeddings-settings":
        debugLog("nav: opening embeddings settings modal");
        openModal({ backdrop: dom.embeddingsSettingsModal });
        break;

      case "open-enrichment-settings":
        debugLog("nav: opening enrichment settings modal");
        openModal({ backdrop: dom.enrichmentSettingsModal });
        break;

      case "open-trufflehog-settings":
        debugLog("nav: opening trufflehog settings modal");
        openModal({ backdrop: dom.trufflehogSettingsModal });
        break;

      case "open-debug-settings":
        openDebugSettings();
        break;

      case "open-about":
        debugLog("nav: opening about modal");
        openModal({ backdrop: dom.aboutModal });
        break;

      case "open-debug-folder":
        debugLog("nav: opening debug logs folder");
        openDebugLogFolder().catch((err) => {
          debugLog(`nav: failed to open logs folder — ${err}`, "ERROR");
          showToast("Could not open logs folder.", "error");
        });
        break;

      default:
        debugLog(`nav: unhandled action "${id}"`, "WARN");
        showToast(`Action: ${id}`, "info");
        break;
    }
  }

  // ── Theme ───────────────────────────────────────────────────────────────

  function applyThemeAndSave(theme: UiTheme) {
    debugLog(`theme: applying "${theme}"`);
    setTheme(theme);
    getUiStore()
      .then((s) => s.set("uiTheme", theme))
      .catch((err) => {
        debugLog(`theme: failed to save "${theme}" — ${err}`, "ERROR");
      });
  }

  function syncThemeMenuIcons(activeTheme: UiTheme) {
    const themeNavIds: Record<UiTheme, string> = {
      goblin: "set-theme-goblin",
      dark: "set-theme-dark",
      light: "set-theme-light",
    };
    for (const [theme, navId] of Object.entries(themeNavIds)) {
      const btn = document.querySelector<HTMLElement>(
        `[data-nav-id="${navId}"] .nav-option-icon i`,
      );
      if (btn) {
        btn.setAttribute("data-lucide", theme === activeTheme ? "circle-dot" : "circle");
      } else {
        debugLog(`syncThemeMenuIcons: icon element not found for navId="${navId}"`, "WARN");
      }
    }
    applyIcons();
  }

  // ── Sidebar toggle ──────────────────────────────────────────────────────

  function toggleSidebar() {
    const isCollapsed = dom.appSidebar.classList.contains("is-collapsed");
    const collapsed = !isCollapsed;
    debugLog(`sidebar: ${collapsed ? "collapsing" : "expanding"}`);
    dom.appSidebar.classList.toggle("is-collapsed", collapsed);
    dom.toggleSidebarNavLabel.textContent = collapsed ? "Show sidebar" : "Hide sidebar";

    const icon = dom.toggleSidebarNav.querySelector<HTMLElement>("i[data-lucide]");
    if (icon) {
      icon.setAttribute("data-lucide", collapsed ? "panel-left-open" : "panel-left-close");
      applyIcons();
    } else {
      debugLog("sidebar: toggle icon element not found", "WARN");
    }

    getUiStore()
      .then((s) => s.set("sidebarCollapsed", collapsed))
      .catch((err) => {
        debugLog(`sidebar: failed to save collapsed=${collapsed} — ${err}`, "ERROR");
      });
  }

  // ── View switching ──────────────────────────────────────────────────────

  function switchView(view: string) {
    const panels = document.querySelectorAll<HTMLElement>(".view-panel");
    let found = false;
    panels.forEach((panel) => {
      const match = panel.id === `view-${view}`;
      panel.hidden = !match;
      panel.classList.toggle("is-active", match);
      if (match) found = true;
    });
    if (!found) {
      debugLog(`switchView: no panel found for view "${view}"`, "WARN");
    }
  }

  // ── Modal openers ───────────────────────────────────────────────────────

  function openCaptureSettings() {
    const settings = getSettings();
    debugLog(`capture settings: opening (clipboardMonitoring=${settings.clipboardMonitoring})`);
    dom.clipboardMonitoringCheckbox.checked = settings.clipboardMonitoring;
    openModal({ backdrop: dom.captureSettingsModal });
  }

  function openDebugSettings() {
    const settings = getSettings();
    debugLog(`debug settings: opening (debugLoggingEnabled=${settings.debugLoggingEnabled})`);
    dom.debugLoggingCheckbox.checked = settings.debugLoggingEnabled;
    updateDebugLogHint();
    openModal({ backdrop: dom.debugSettingsModal });
  }

  // ── Debug log hint ──────────────────────────────────────────────────────

  function updateDebugLogHint() {
    if (!isDebugLoggingEnabled()) {
      dom.debugLogPath.textContent = "Debug logs are disabled.";
      dom.openDebugFolderBtn.disabled = true;
    } else {
      dom.debugLogPath.textContent = "Debug logs are enabled.";
      dom.openDebugFolderBtn.disabled = false;
    }
  }

  // ── Overlay ─────────────────────────────────────────────────────────────

  async function showOverlay() {
    debugLog("overlay: showOverlay() called");
    try {
      debugLog("overlay: calling WebviewWindow.getByLabel('overlay')");
      const overlay = await WebviewWindow.getByLabel("overlay");
      if (!overlay) {
        debugLog("overlay: getByLabel returned null — window not registered", "ERROR");
        showToast("Overlay window not found.", "error");
        return;
      }
      debugLog("overlay: window found, emitting show-overlay event");
      await emit("show-overlay");
      debugLog("overlay: calling overlay.show()");
      await overlay.show();
      debugLog("overlay: calling overlay.setFocus()");
      await overlay.setFocus();
      debugLog("overlay: shown and focused");
    } catch (err) {
      debugLog(`overlay: showOverlay() threw — ${err}`, "ERROR");
      console.error("Failed to show overlay:", err);
      showToast("Could not open overlay.", "error");
    }
  }

  // ── Apply settings to UI ────────────────────────────────────────────────

  async function applySettingsToUI(settings: Settings) {
    debugLog(`applySettingsToUI: debug=${settings.debugLoggingEnabled}`);

    // Theme
    const store = await getUiStore();
    const storedTheme = await store.get<string>("uiTheme");
    const theme: UiTheme = storedTheme === "goblin" || storedTheme === "dark" || storedTheme === "light"
      ? storedTheme
      : "goblin";
    debugLog(`applySettingsToUI: theme="${theme}"`);
    setTheme(theme);
    syncThemeMenuIcons(theme);

    // Sidebar
    const sidebarCollapsed = await store.get<boolean>("sidebarCollapsed");
    if (sidebarCollapsed) {
      debugLog("applySettingsToUI: sidebar collapsed");
      dom.appSidebar.classList.add("is-collapsed");
      dom.toggleSidebarNavLabel.textContent = "Show sidebar";
      const icon = dom.toggleSidebarNav.querySelector<HTMLElement>("i[data-lucide]");
      if (icon) {
        icon.setAttribute("data-lucide", "panel-left-open");
        applyIcons();
      }
    }

    // Debug
    dom.debugLoggingCheckbox.checked = settings.debugLoggingEnabled;
    updateDebugLogHint();
  }

  return { applySettingsToUI };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function bindModalRejectButtons(modal: HTMLElement, name: string) {
  modal.querySelectorAll<HTMLElement>(".modal-btn-reject").forEach((btn) => {
    btn.addEventListener("click", () => {
      debugLog(`modal "${name}": closed via button`);
      closeModal({ backdrop: modal });
    });
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      debugLog(`modal "${name}": closed via backdrop click`);
      closeModal({ backdrop: modal });
    }
  });
}

// ── Global augmentation ─────────────────────────────────────────────────────

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: (cmd: string) => Promise<void> };
    };
  }
}
