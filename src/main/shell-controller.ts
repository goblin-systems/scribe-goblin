import {
  applyIcons,
  bindNavigation,
  closeModal,
  openModal,
  setTheme,
  showToast,
  type UiTheme,
} from "@goblin-systems/goblin-design-system";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { openImportModal } from "./import-controller";

// ── Public interface ────────────────────────────────────────────────────────

export interface ShellControllerOptions {
  dom: ScribeDom;
  getSettings: () => Settings;
  setSettings: (s: Settings) => void;
  onOpenQuickAdd?: () => void;
  onOpenShortcutsSettings?: () => void;
  onOpenAiModelsSettings?: () => void;
}

// ── Setup ───────────────────────────────────────────────────────────────────

export function setupShell(options: ShellControllerOptions) {
  const { dom, getSettings, setSettings, onOpenQuickAdd, onOpenShortcutsSettings, onOpenAiModelsSettings } = options;

  let uiStore: Store | null = null;

  async function getUiStore(): Promise<Store> {
    if (!uiStore) {
      uiStore = await load("settings.json", { autoSave: true, defaults: {} });
    }
    return uiStore;
  }

  // ── Window controls ─────────────────────────────────────────────────────
  debugLog("setupShell: initialising window controls");
  setupDesktopWindowControls();

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

  // ── Modal reject buttons ────────────────────────────────────────────────
  bindModalRejectButtons(dom.captureSettingsModal, "capture-settings");
  bindModalRejectButtons(dom.shortcutsSettingsModal, "shortcuts-settings");
  bindModalRejectButtons(dom.providersSettingsModal, "providers-settings");
  bindModalRejectButtons(dom.embeddingsSettingsModal, "embeddings-settings");
  bindModalRejectButtons(dom.enrichmentSettingsModal, "enrichment-settings");
  bindModalRejectButtons(dom.aiModelsSettingsModal, "ai-models-settings");
  bindModalRejectButtons(dom.rankingSettingsModal, "ranking-settings");
  bindModalRejectButtons(dom.secretMaskerSettingsModal, "secret-masker-settings");
  bindModalRejectButtons(dom.debugSettingsModal, "debug-settings");
  bindModalRejectButtons(dom.aboutModal, "about");
  bindModalRejectButtons(dom.addBadgeModal, "add-badge");
  bindModalRejectButtons(dom.importModal, "import");
  bindModalRejectButtons(dom.createCollectionModal, "create-collection");
  bindModalRejectButtons(dom.renameCollectionModal, "rename-collection");
  bindModalRejectButtons(dom.deleteCollectionModal, "delete-collection");

  // ── Overlay buttons ─────────────────────────────────────────────────────
  debugLog("setupShell: done");

  // ── Nav handler ─────────────────────────────────────────────────────────

  function handleNavSelect(id: string) {
    switch (id) {
      case "new-note":
        debugLog("nav: new note");
        onOpenQuickAdd?.();
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

      case "open-import":
        debugLog("nav: opening import modal");
        openImportModal();
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

      case "open-shortcuts-settings":
        debugLog("nav: opening shortcuts settings modal");
        onOpenShortcutsSettings?.();
        break;

      case "open-embeddings-settings":
        debugLog("nav: opening embeddings settings modal");
        openModal({ backdrop: dom.embeddingsSettingsModal });
        break;

      case "open-enrichment-settings":
        debugLog("nav: opening enrichment settings modal");
        openModal({ backdrop: dom.enrichmentSettingsModal });
        break;

      case "open-ai-models-settings":
        debugLog("nav: opening local AI models modal");
        openModal({ backdrop: dom.aiModelsSettingsModal });
        onOpenAiModelsSettings?.();
        break;

      case "open-ranking-settings":
        debugLog("nav: opening ranking settings modal");
        openModal({ backdrop: dom.rankingSettingsModal });
        break;

      case "open-secret-masker-settings":
        debugLog("nav: opening secret detection settings modal");
        openModal({ backdrop: dom.secretMaskerSettingsModal });
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

function setupDesktopWindowControls() {
  const win = getCurrentWindow();
  const minimizeBtn = document.getElementById("window-minimize-btn") as HTMLButtonElement | null;
  const maximizeBtn = document.getElementById("window-maximize-btn") as HTMLButtonElement | null;
  const closeBtn = document.getElementById("window-close-btn") as HTMLButtonElement | null;

  minimizeBtn?.addEventListener("click", async () => {
    try {
      await win.minimize();
    } catch (err) {
      debugLog(`window-controls: minimize failed â€” ${err}`, "ERROR");
      console.error("Failed to minimize window:", err);
    }
  });

  closeBtn?.addEventListener("click", async () => {
    try {
      await win.hide();
    } catch (err) {
      debugLog(`window-controls: hide failed â€” ${err}`, "ERROR");
      console.error("Failed to hide window to tray:", err);
      showToast("Could not minimize window to tray.", "error");
    }
  });

  if (!maximizeBtn) return;

  maximizeBtn.addEventListener("click", async () => {
    try {
      const maximized = await win.isMaximized();
      if (maximized) {
        await win.unmaximize();
      } else {
        await win.maximize();
      }
      syncMaximizeButtonIcon(maximizeBtn, !maximized);
    } catch (err) {
      debugLog(`window-controls: maximize toggle failed â€” ${err}`, "ERROR");
      console.error("Failed to toggle maximize:", err);
    }
  });

  win.isMaximized()
    .then((maximized) => syncMaximizeButtonIcon(maximizeBtn, maximized))
    .catch(() => {});
  win
    .onResized(async () => {
      try {
        const maximized = await win.isMaximized();
        syncMaximizeButtonIcon(maximizeBtn, maximized);
      } catch {
        // Ignore resize sync failures.
      }
    })
    .catch(() => {});
}

function syncMaximizeButtonIcon(
  button: HTMLButtonElement,
  isMaximized: boolean,
) {
  button.dataset["maximized"] = String(isMaximized);
  const svg = button.querySelector("svg");
  if (!svg) return;

  const iconParts = isMaximized
    ? [
        ["polyline", "points", "4 14 10 14 10 20"],
        ["polyline", "points", "20 10 14 10 14 4"],
        ["line", "x1,y1,x2,y2", "10,20,3,13"],
        ["line", "x1,y1,x2,y2", "21,3,14,10"],
      ]
    : [
        ["polyline", "points", "15 3 21 3 21 9"],
        ["polyline", "points", "9 21 3 21 3 15"],
        ["line", "x1,y1,x2,y2", "21,3,14,10"],
        ["line", "x1,y1,x2,y2", "3,21,10,14"],
      ];

  svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";
  for (const [tag, attrNames, attrValues] of iconParts) {
    const el = document.createElementNS(ns, tag);
    const names = attrNames.split(",");
    const values = attrValues.split(",");
    names.forEach((name, index) => el.setAttribute(name, values[index] ?? ""));
    svg.appendChild(el);
  }
}

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: (cmd: string) => Promise<void> };
    };
  }
}
