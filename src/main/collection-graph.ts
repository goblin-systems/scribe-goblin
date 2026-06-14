/**
 * Collection graph view.
 *
 * Renders a force-directed, navigable graph of every entry in the active
 * list (notes collection or clipboard) when no specific entry is selected.
 *
 * Design notes:
 *   - Self-bootstraps. The only inputs from the rest of the app are a
 *     `getContext()` callback (so the engine knows whether the active
 *     surface is a collection or the clipboard) and an `onSelectEntry()`
 *     callback (so clicking a node hands control back to the existing
 *     selection flow).
 *   - Reads entries directly via Tauri commands the controllers already
 *     expose (`db_list_collection_entries`, `db_list_entries`).
 *   - Mirrors placeholder visibility via MutationObserver — never modifies
 *     the placeholder element itself.
 *   - Subscribes to the secret-reveal controller so masked node labels
 *     follow the same Alt-to-reveal contract used everywhere else.
 *
 * Visuals are inspired by the Scribe Goblin product animation
 * (`goblin-web/src/components/animations/ScribeAnimation.tsx`):
 * dark technical canvas, glowing nodes, faint grid, monospace labels.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EntryRow, ManualBadge, SearchFilters } from "../store";
import { parseManualBadges } from "../store";
import {
  isSecretRevealActive,
  subscribeSecretReveal,
} from "./secret-reveal-controller";
import { searchEntries } from "./search-controller";
import { parseCollectionSearchInput } from "./collection-controller";

// ── Public API ──────────────────────────────────────────────────────────────

export type CollectionGraphContextKind = "collection" | "clipboard";

export interface CollectionGraphContext {
  kind: CollectionGraphContextKind;
  /** Active collection id when kind === "collection". */
  collectionId: string | null;
  /** Current search query for filtering. */
  searchQuery?: string;
}

export interface MountCollectionGraphOptions {
  hostId: string;
  /** Existing placeholder element. Hidden while the graph is showing. */
  placeholderId: string;
  /** Detail pane id whose hidden attribute signals "an entry is selected". */
  detailId: string;
  /** List element whose child count signals "this view has entries". */
  listId: string;
  getContext: () => CollectionGraphContext;
  getSettings: () => any;
  onSelectEntry: (entryId: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
}

export type CollectionGraphHandle = {
  refresh: () => Promise<void>;
  isVisible: () => boolean;
  setHoveredEntry: (entryId: string | null) => void;
  focusEntry: (entryId: string) => void;
  revealAndFocusEntry: (entryId: string) => Promise<void>;
  toggleFocusFilter: (entryId: string) => void;
  destroy: () => void;
};

export function mountCollectionGraph(
  options: MountCollectionGraphOptions,
): CollectionGraphHandle {
  const host = document.getElementById(options.hostId);
  const placeholder = document.getElementById(options.placeholderId);
  const detail = document.getElementById(options.detailId);
  const list = document.getElementById(options.listId);
  if (!host) throw new Error(`Missing graph host #${options.hostId}`);
  if (!placeholder)
    throw new Error(`Missing placeholder #${options.placeholderId}`);
  if (!detail) throw new Error(`Missing detail pane #${options.detailId}`);
  if (!list) throw new Error(`Missing list element #${options.listId}`);

  const view = new CollectionGraphView(
    host,
    placeholder,
    detail,
    list,
    options,
  );
  view.start();

  return {
    refresh: () => view.refresh(),
    isVisible: () => view.isVisible(),
    setHoveredEntry: (entryId) => view.setHoveredEntry(entryId),
    focusEntry: (entryId) => view.focusEntry(entryId),
    revealAndFocusEntry: (entryId) => view.revealAndFocusEntry(entryId),
    toggleFocusFilter: (entryId) => view.toggleFocusFilter(entryId),
    destroy: () => view.destroy(),
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

const ENTRY_LIMIT = 200;
const PREVIEW_MAX_CHARS = 36;
const HOVER_PREVIEW_MAX_CHARS = 80;

const COLOR = {
  purple: "rgba(167, 139, 250, ",
  teal: "rgba(45, 212, 191, ",
  red: "rgba(248, 113, 113, ",
  blue: "rgba(122, 162, 247, ",
  green: "rgba(158, 206, 106, ",
  orange: "rgba(224, 175, 104, ",
  slate: "rgba(148, 163, 184, ",
} as const;

type ColorKey = keyof typeof COLOR;

function badgeColor(badge: ManualBadge): ColorKey {
  switch (badge.color) {
    case "blue":
      return "blue";
    case "green":
      return "green";
    case "red":
      return "red";
    case "orange":
      return "orange";
    default:
      return "purple";
  }
}

function isSecretEntry(entry: EntryRow): boolean {
  return Boolean(entry.secret_verdict && entry.secret_verdict !== "not_secret");
}

function getRawPreview(entry: EntryRow): string {
  const basis =
    (entry.import_name ?? "").trim() ||
    entry.content.replace(/\s+/g, " ").trim();
  return basis;
}

function getDisplayLabel(entry: EntryRow, revealSecrets: boolean, max: number): string {
  if (isSecretEntry(entry) && !revealSecrets) {
    const length = Math.min(getRawPreview(entry).length || 12, 24);
    return "•".repeat(length);
  }
  const raw = getRawPreview(entry);
  if (raw.length === 0) return "(empty)";
  if (raw.length <= max) return raw;
  return raw.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

interface GraphNode {
  id: string;
  entry: EntryRow;
  badges: ManualBadge[];
  primaryColor: ColorKey;
  isSecret: boolean;
  // Physics
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
  // Display
  baseRadius: number;
  pulse: number;
  pulseSpeed: number;
}

interface GraphEdge {
  a: number;
  b: number;
  weight: number;
  reason: "semantic" | "badge" | "source-app" | "import-origin" | "neighbour";
  /** Cosine similarity in [0,1] for semantic edges; undefined otherwise. */
  score?: number;
}

interface SemanticGraphEdge {
  source: string;
  target: string;
  similarity: number;
}

class CollectionGraphView {
  private readonly host: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly list: HTMLElement;
  private readonly options: MountCollectionGraphOptions;

  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private statsEl!: HTMLElement;
  private statsCount!: HTMLElement;
  private statsSecret!: HTMLElement;
  private toolbar!: HTMLElement;
  private liveDot!: HTMLElement;
  private emptyState!: HTMLElement;

  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];

  /** When true, edges show their similarity score (debug logging setting). */
  private debugEnabled = false;

  private W = 0;
  private H = 0;
  private dpr = Math.max(1, window.devicePixelRatio || 1);

  // Camera
  private camX = 0;
  private camY = 0;
  private camZoom = 1;

  // Interaction
  private hoveredIdx: number | null = null;
  private selectedEntryId: string | null = null;
  private draggingIdx: number | null = null;
  private dragMoved = false;
  private dragOrigin: { sx: number; sy: number } | null = null;
  private panOrigin: {
    sx: number;
    sy: number;
    camX: number;
    camY: number;
  } | null = null;

  // Loop
  private rafId = 0;
  private lastFrameMs = performance.now();
  private animTime = 0;

  // Lifecycle
  private destroyed = false;
  private resizeObs: ResizeObserver | null = null;
  private detailObs: MutationObserver | null = null;
  private listObs: MutationObserver | null = null;
  private unsubscribeSecret: (() => void) | null = null;
  private unlistenEntries: (() => void) | null = null;
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null;
  private isLoading = false;
  private loadToken = 0;
  private revealedSecrets = false;
  private externalHoveredEntryId: string | null = null;
  private focusFilterEntryId: string | null = null;
  private pendingFocusEntryId: string | null = null;

  constructor(
    host: HTMLElement,
    placeholder: HTMLElement,
    detail: HTMLElement,
    list: HTMLElement,
    options: MountCollectionGraphOptions,
  ) {
    this.host = host;
    this.placeholder = placeholder;
    this.detail = detail;
    this.list = list;
    this.options = options;
  }

  start(): void {
    this.host.classList.add("collection-graph-host");
    this.host.replaceChildren();

    this.canvas = document.createElement("canvas");
    this.canvas.className = "collection-graph-canvas";
    this.host.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    // Toolbar (zoom controls)
    this.toolbar = document.createElement("div");
    this.toolbar.className = "collection-graph-toolbar";
    const zoomIn = this.makeToolbarBtn("+", "Zoom in");
    const zoomOut = this.makeToolbarBtn("−", "Zoom out");
    const reset = this.makeToolbarBtn("⌂", "Reset view");
    zoomIn.addEventListener("click", () => this.zoomBy(1.25));
    zoomOut.addEventListener("click", () => this.zoomBy(1 / 1.25));
    reset.addEventListener("click", () => this.resetCamera());
    this.toolbar.append(zoomIn, zoomOut, reset);
    this.host.appendChild(this.toolbar);

    // Stats
    this.statsEl = document.createElement("div");
    this.statsEl.className = "collection-graph-stats";
    const countWrap = document.createElement("div");
    countWrap.className = "collection-graph-stat";
    this.statsCount = document.createElement("span");
    this.statsCount.className = "collection-graph-stat-value";
    this.statsCount.textContent = "0";
    countWrap.append(this.statsCount, document.createTextNode(" indexed"));
    const secretWrap = document.createElement("div");
    secretWrap.className = "collection-graph-stat collection-graph-stat--secret";
    this.statsSecret = document.createElement("span");
    this.statsSecret.className = "collection-graph-stat-value";
    this.statsSecret.textContent = "0";
    secretWrap.append(this.statsSecret, document.createTextNode(" secrets"));
    this.statsEl.append(countWrap, secretWrap);
    this.host.appendChild(this.statsEl);

    // Live dot
    this.liveDot = document.createElement("div");
    this.liveDot.className = "collection-graph-live-dot";
    this.liveDot.textContent = "LIVE";
    this.host.appendChild(this.liveDot);

    // Empty state
    this.emptyState = document.createElement("div");
    this.emptyState.className = "collection-graph-empty";
    this.emptyState.hidden = true;
    const emptyTitle = document.createElement("div");
    emptyTitle.className = "collection-graph-empty-title";
    emptyTitle.textContent = "No graph data yet";
    const emptyHint = document.createElement("div");
    emptyHint.className = "collection-graph-empty-hint";
    emptyHint.textContent =
      "Capture or add a few entries to see the constellation.";
    this.emptyState.append(emptyTitle, emptyHint);
    this.host.appendChild(this.emptyState);

    // Resize tracking
    this.resizeObs = new ResizeObserver(() => this.handleResize());
    this.resizeObs.observe(this.host);
    this.handleResize();

    // Pointer / wheel events
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });

    // The graph appears whenever the detail pane is hidden (no selection)
    // *and* the list has rendered entries. We observe both signals — never
    // the placeholder itself — so the controller's placeholder toggling
    // can't fight with our own.
    this.detailObs = new MutationObserver(() => this.syncVisibility());
    this.detailObs.observe(this.detail, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
    this.listObs = new MutationObserver(() => this.syncVisibility());
    this.listObs.observe(this.list, { childList: true });
    queueMicrotask(() => this.syncVisibility());

    // Re-render on secret reveal toggle
    this.revealedSecrets = isSecretRevealActive();
    this.unsubscribeSecret = subscribeSecretReveal(() => {
      const next = isSecretRevealActive();
      if (next === this.revealedSecrets) return;
      this.revealedSecrets = next;
      // Labels are derived per frame, so a redraw is enough; nothing to mutate.
    });

    // Refresh on entries-changed
    void listen("entries-changed", () => this.scheduleRefresh()).then(
      (unlisten) => {
        if (this.destroyed) {
          unlisten();
          return;
        }
        this.unlistenEntries = unlisten;
      },
    );

    // Kick off render loop
    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    if (this.refreshDebounce !== null) {
      clearTimeout(this.refreshDebounce);
      this.refreshDebounce = null;
    }
    this.resizeObs?.disconnect();
    this.detailObs?.disconnect();
    this.listObs?.disconnect();
    this.unsubscribeSecret?.();
    this.unlistenEntries?.();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.host.replaceChildren();
  }

  async refresh(): Promise<void> {
    if (this.host.hidden) return;
    await this.loadEntries();
  }

  isVisible(): boolean {
    return !this.host.hidden;
  }

  setHoveredEntry(entryId: string | null): void {
    this.externalHoveredEntryId = entryId;
  }

  focusEntry(entryId: string): void {
    this.pendingFocusEntryId = entryId;
    const index = this.findNodeIndexById(entryId);
    if (index === null) return;
    this.selectedEntryId = entryId;
    this.pendingFocusEntryId = null;
    this.centerOnNode(this.nodes[index]!);
  }

  async revealAndFocusEntry(entryId: string): Promise<void> {
    this.pendingFocusEntryId = entryId;
    if (this.host.hidden) {
      this.host.hidden = false;
      this.placeholder.hidden = true;
      this.options.onVisibilityChange?.(true);
      this.applyListGraphState();
    }
    await this.loadEntries();
    this.focusEntry(entryId);
  }

  toggleFocusFilter(entryId: string): void {
    this.focusFilterEntryId = this.focusFilterEntryId === entryId ? null : entryId;
    this.selectedEntryId = this.focusFilterEntryId ?? entryId;
    const index = this.findNodeIndexById(this.selectedEntryId);
    if (index !== null) {
      this.centerOnNode(this.nodes[index]!);
    }
    this.applyListGraphState();
  }

  // ── Visibility ───────────────────────────────────────────────────────────

  private syncVisibility(): void {
    const noSelection = this.detail.hidden;
    const hasEntries = this.list.childElementCount > 0;
    const shouldShow = noSelection && hasEntries;

    if (shouldShow) {
      // Force the placeholder out of the way; the graph displaces it.
      // We never observe the placeholder, so flipping its hidden flag
      // here can't trigger our own observers.
      if (!this.placeholder.hidden) this.placeholder.hidden = true;
      if (this.host.hidden) {
        this.host.hidden = false;
        this.options.onVisibilityChange?.(true);
        this.applyListGraphState();
        void this.loadEntries();
      }
      return;
    }

    if (!this.host.hidden) {
      this.host.hidden = true;
      this.draggingIdx = null;
      this.hoveredIdx = null;
      this.selectedEntryId = null;
      this.externalHoveredEntryId = null;
      this.focusFilterEntryId = null;
      this.panOrigin = null;
      this.applyListGraphState();
      this.options.onVisibilityChange?.(false);
    }
  }

  // ── Data loading ─────────────────────────────────────────────────────────

  private scheduleRefresh(): void {
    if (this.refreshDebounce !== null) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = null;
      void this.loadEntries();
    }, 150);
  }

  private async loadEntries(): Promise<void> {
    if (this.host.hidden) return;
    const ctx = this.options.getContext();
    const token = ++this.loadToken;
    this.isLoading = true;

    try {
      const { query, filters } = parseCollectionSearchInput(
        ctx.searchQuery ?? "",
        ctx.collectionId,
      );

      // Override collection_id for clipboard
      if (ctx.kind === "clipboard") {
        delete filters.collection_id;
        filters.is_note = false;
      }

      const results = await searchEntries(
        { query, filters, limit: ENTRY_LIMIT },
        this.options.getSettings(),
      );

      if (token !== this.loadToken) return;

      const entries = results.map((r) => r.entry);

      // Semantic (KNN) edges from the embedding space — the primary graph
      // structure. Failure here is non-fatal; we fall back to metadata edges.
      let semanticEdges: SemanticGraphEdge[] = [];
      try {
        semanticEdges = await invoke<SemanticGraphEdge[]>("build_semantic_graph", {
          entryIds: entries.map((e) => e.id),
        });
      } catch (err) {
        console.error("collection-graph: semantic edge query failed", err);
      }

      if (token !== this.loadToken) return;
      this.debugEnabled = Boolean(this.options.getSettings()?.debugLoggingEnabled);
      this.buildGraph(entries, semanticEdges);
    } catch (err) {
      console.error("collection-graph: failed to load entries", err);
    } finally {
      if (token === this.loadToken) this.isLoading = false;
    }
  }

  private buildGraph(
    entries: EntryRow[],
    semanticEdges: SemanticGraphEdge[] = [],
  ): void {
    const previousById = new Map<string, GraphNode>();
    for (const node of this.nodes) previousById.set(node.id, node);

    const cx = this.W / 2;
    const cy = this.H / 2;
    const radius = Math.min(this.W, this.H) * 0.32 || 200;

    this.nodes = entries.map((entry, idx) => {
      const previous = previousById.get(entry.id);
      const badges = parseManualBadges(entry.manual_badges);
      const isSecret = isSecretEntry(entry);
      const primaryColor: ColorKey = isSecret
        ? "red"
        : badges.length > 0
          ? badgeColor(badges[0]!)
          : "purple";

      // Initial position: golden-angle spiral around centre, so layout
      // settles quickly without all nodes starting on top of each other.
      const angle = idx * 2.39996;
      const r = radius * Math.sqrt(idx / Math.max(1, entries.length));
      const initX = cx + Math.cos(angle) * r;
      const initY = cy + Math.sin(angle) * r;

      return {
        id: entry.id,
        entry,
        badges,
        primaryColor,
        isSecret,
        x: previous?.x ?? initX,
        y: previous?.y ?? initY,
        vx: previous?.vx ?? 0,
        vy: previous?.vy ?? 0,
        pinned: false,
        baseRadius: 5 + Math.min(badges.length, 4) * 0.6,
        pulse: Math.random() * Math.PI * 2,
        pulseSpeed: 1.1 + Math.random() * 1.0,
      };
    });

    this.edges = buildEdges(this.nodes, semanticEdges);
    this.statsCount.textContent = String(this.nodes.length);
    this.statsSecret.textContent = String(
      this.nodes.reduce((acc, n) => acc + (n.isSecret ? 1 : 0), 0),
    );
    this.emptyState.hidden = this.nodes.length > 0;

    if (!previousById.size) {
      this.resetCamera();
      this.selectedEntryId = null;
    } else if (
      this.selectedEntryId &&
      !this.nodes.some((node) => node.id === this.selectedEntryId)
    ) {
      this.selectedEntryId = null;
    }

    if (
      this.focusFilterEntryId &&
      !this.nodes.some((node) => node.id === this.focusFilterEntryId)
    ) {
      this.focusFilterEntryId = null;
    }

    if (this.pendingFocusEntryId) {
      const index = this.findNodeIndexById(this.pendingFocusEntryId);
      if (index !== null) {
        this.selectedEntryId = this.pendingFocusEntryId;
        this.centerOnNode(this.nodes[index]!);
        this.pendingFocusEntryId = null;
      }
    }

    this.applyListGraphState();
  }

  private findNodeIndexById(entryId: string | null): number | null {
    if (!entryId) return null;
    const index = this.nodes.findIndex((node) => node.id === entryId);
    return index >= 0 ? index : null;
  }

  private getEffectiveHoveredIndex(): number | null {
    return this.hoveredIdx ?? this.findNodeIndexById(this.externalHoveredEntryId);
  }

  private getSelectedIndex(): number | null {
    return this.findNodeIndexById(this.selectedEntryId);
  }

  private getFocusVisibleIds(): Set<string> | null {
    const focusIndex = this.findNodeIndexById(this.focusFilterEntryId);
    if (focusIndex === null) return null;
    const visible = new Set<string>();
    visible.add(this.nodes[focusIndex]!.id);
    const neighbours = collectNeighbours(this.edges, focusIndex);
    neighbours.forEach((index) => {
      const node = this.nodes[index];
      if (node) visible.add(node.id);
    });
    return visible;
  }

  private applyListGraphState(): void {
    const graphVisible = !this.host.hidden;
    this.list.classList.toggle("is-graph-visible", graphVisible);
    const visibleIds = graphVisible ? this.getFocusVisibleIds() : null;
    this.list.querySelectorAll<HTMLElement>(".note-item").forEach((item) => {
      const entryId = item.dataset.id ?? "";
      item.hidden = visibleIds ? !visibleIds.has(entryId) : false;
    });
  }

  private centerOnNode(node: GraphNode): void {
    this.camX = this.W / 2 - node.x * this.camZoom;
    this.camY = this.H / 2 - node.y * this.camZoom;
  }

  // ── Camera ───────────────────────────────────────────────────────────────

  private resetCamera(): void {
    this.camX = 0;
    this.camY = 0;
    this.camZoom = 1;
  }

  private zoomBy(factor: number): void {
    const cx = this.W / 2;
    const cy = this.H / 2;
    this.applyZoom(factor, cx, cy);
  }

  private applyZoom(factor: number, sx: number, sy: number): void {
    const nextZoom = clamp(this.camZoom * factor, 0.35, 4);
    if (nextZoom === this.camZoom) return;
    // Keep the world point under (sx, sy) anchored.
    const wx = (sx - this.camX) / this.camZoom;
    const wy = (sy - this.camY) / this.camZoom;
    this.camZoom = nextZoom;
    this.camX = sx - wx * this.camZoom;
    this.camY = sy - wy * this.camZoom;
  }

  // ── Resize ───────────────────────────────────────────────────────────────

  private handleResize(): void {
    const rect = this.host.getBoundingClientRect();
    const W = Math.max(1, rect.width);
    const H = Math.max(1, rect.height);
    if (W === this.W && H === this.H) return;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.W = W;
    this.H = H;
    this.canvas.width = Math.floor(W * this.dpr);
    this.canvas.height = Math.floor(H * this.dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // ── Frame loop ───────────────────────────────────────────────────────────

  private readonly frame = (now: number) => {
    if (this.destroyed) return;
    const dt = Math.min(0.05, (now - this.lastFrameMs) / 1000);
    this.lastFrameMs = now;
    this.animTime += dt;

    if (!this.host.hidden) {
      simulate(this.nodes, this.edges, this.W, this.H, dt, this.draggingIdx);
      this.draw();
    }
    this.rafId = requestAnimationFrame(this.frame);
  };

  // ── Drawing ──────────────────────────────────────────────────────────────

  private draw(): void {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);

    // Camera transform (DPR is already baked into ctx via setTransform).
    ctx.save();
    ctx.translate(this.camX, this.camY);
    ctx.scale(this.camZoom, this.camZoom);

    this.drawGrid();
    this.drawEdges();
    this.drawNodes();

    ctx.restore();
  }

  private drawGrid(): void {
    const { ctx, W, H, camX, camY, camZoom } = this;
    // Visible world bounds
    const left = -camX / camZoom;
    const top = -camY / camZoom;
    const right = (W - camX) / camZoom;
    const bottom = (H - camY) / camZoom;
    const step = 32;
    ctx.strokeStyle = "rgba(167, 139, 250, 0.05)";
    ctx.lineWidth = 1 / camZoom;
    const startX = Math.floor(left / step) * step;
    const startY = Math.floor(top / step) * step;
    ctx.beginPath();
    for (let x = startX; x <= right; x += step) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = startY; y <= bottom; y += step) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  }

  private drawEdges(): void {
    const { ctx } = this;
    const hovered = this.getEffectiveHoveredIndex();
    const selected = this.getSelectedIndex();
    const activeIdx = hovered !== null ? hovered : selected;
    const focusVisibleIds = this.getFocusVisibleIds();
    const neighbourSet =
      activeIdx !== null ? collectNeighbours(this.edges, activeIdx) : null;

    for (const edge of this.edges) {
      const a = this.nodes[edge.a];
      const b = this.nodes[edge.b];
      if (!a || !b) continue;
      if (
        focusVisibleIds &&
        (!focusVisibleIds.has(a.id) || !focusVisibleIds.has(b.id))
      ) continue;

      const isHighlighted =
        neighbourSet !== null &&
        (edge.a === activeIdx ||
          edge.b === activeIdx ||
          (neighbourSet.has(edge.a) && neighbourSet.has(edge.b)));
      const dim = neighbourSet !== null && !isHighlighted;

      const baseColor =
        a.isSecret || b.isSecret ? COLOR.red : COLOR.purple;
      const baseAlpha = dim
        ? 0.04
        : isHighlighted
          ? 0.32
          : 0.1 + Math.min(0.18, edge.weight * 0.05);

      ctx.lineWidth = dim
        ? 0.6
        : isHighlighted
          ? 1.4
          : 0.8 + Math.min(0.6, edge.weight * 0.2);

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const cx = (a.x + b.x) / 2 + dy * 0.08;
      const cy = (a.y + b.y) / 2 - dx * 0.08;

      ctx.strokeStyle = `${baseColor}${baseAlpha})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();

      if (isHighlighted) {
        // Travelling pulse along the highlighted edge.
        const t = (this.animTime * 0.5 + (edge.a + edge.b) * 0.07) % 1;
        const u = 1 - t;
        const px = u * u * a.x + 2 * u * t * cx + t * t * b.x;
        const py = u * u * a.y + 2 * u * t * cy + t * t * b.y;
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = `${baseColor}0.9)`;
        ctx.shadowBlur = 10;
        ctx.shadowColor = `${baseColor}0.9)`;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Debug: connection-strength score (KNN cosine similarity) at the edge
      // midpoint. Only shown for semantic edges and when not dimmed.
      if (this.debugEnabled && edge.score !== undefined && !dim) {
        // Midpoint of the quadratic curve at t = 0.5.
        const mx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x;
        const my = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
        const label = edge.score.toFixed(2);
        ctx.save();
        ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const w = ctx.measureText(label).width + 6;
        ctx.fillStyle = "rgba(10, 12, 20, 0.78)";
        ctx.fillRect(mx - w / 2, my - 7, w, 14);
        ctx.fillStyle = isHighlighted
          ? "rgba(220, 230, 255, 0.95)"
          : "rgba(180, 190, 215, 0.75)";
        ctx.fillText(label, mx, my);
        ctx.restore();
      }
    }
  }

  private drawNodes(): void {
    const { ctx } = this;
    const hovered = this.getEffectiveHoveredIndex();
    const selected = this.getSelectedIndex();
    const activeIdx = hovered !== null ? hovered : selected;
    const focusVisibleIds = this.getFocusVisibleIds();
    const neighbourSet =
      activeIdx !== null ? collectNeighbours(this.edges, activeIdx) : null;
    const reveal = this.revealedSecrets;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      if (focusVisibleIds && !focusVisibleIds.has(node.id)) continue;
      const dim =
        neighbourSet !== null && i !== activeIdx && !neighbourSet.has(i);
      const isHovered = i === hovered;
      const isSelected = i === selected;
      const isActive = isHovered || isSelected;

      const pulse = (Math.sin(this.animTime * node.pulseSpeed + node.pulse) + 1) * 0.5;
      const radius = node.baseRadius + (isActive ? 2.5 : 0) + pulse * 0.6;
      const colorBase = COLOR[node.primaryColor];
      const alphaScale = dim ? 0.35 : 1;

      // Outer halo
      for (let ring = 2; ring >= 1; ring--) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + ring * 4 + pulse * 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = `${colorBase}${0.05 * pulse * alphaScale})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Filled body with shadow glow
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `${colorBase}${0.22 * alphaScale})`;
      ctx.shadowBlur = (isActive ? 22 : 12) + pulse * 6;
      ctx.shadowColor = `${colorBase}${(isActive ? 0.95 : 0.7) * alphaScale})`;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Crisp ring
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `${colorBase}${(0.55 + pulse * 0.35) * alphaScale})`;
      ctx.lineWidth = isActive ? 1.8 : 1.3;
      ctx.stroke();

      // Selection indicator (thicker outer ring for selection)
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = `${colorBase}${0.4 * alphaScale})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Secret indicator dot above the node
      if (node.isSecret) {
        ctx.beginPath();
        ctx.arc(node.x, node.y - radius - 4, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = `${COLOR.red}${0.95 * alphaScale})`;
        ctx.shadowBlur = 6;
        ctx.shadowColor = `${COLOR.red}${0.85 * alphaScale})`;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Label + badges
      const labelText = getDisplayLabel(
        node.entry,
        reveal,
        isActive ? HOVER_PREVIEW_MAX_CHARS : PREVIEW_MAX_CHARS,
      );
      this.drawLabel(node, radius, labelText, dim, isActive);
      if (node.badges.length > 0) {
        this.drawBadges(node, radius, dim);
      }
    }
  }

  private drawLabel(
    node: GraphNode,
    radius: number,
    text: string,
    dim: boolean,
    isHovered: boolean,
  ): void {
    const { ctx } = this;
    const labelY = node.y + radius + 14;
    ctx.font = `${isHovered ? "11px" : "10px"} ui-monospace, "JetBrains Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    const metrics = ctx.measureText(text);
    const padX = 6;
    const padY = 3;
    const boxW = metrics.width + padX * 2;
    const boxH = (isHovered ? 14 : 12) + padY * 2;
    const boxX = node.x - boxW / 2;
    const boxY = labelY - (isHovered ? 11 : 9) - padY;
    const alpha = dim ? 0.35 : 1;

    // Subtle background pill so labels remain legible over edges.
    ctx.fillStyle = `rgba(8, 12, 18, ${0.55 * alpha})`;
    roundRect(ctx, boxX, boxY, boxW, boxH, 3);
    ctx.fill();

    ctx.fillStyle = isHovered
      ? `rgba(255, 255, 255, ${0.92 * alpha})`
      : node.isSecret
        ? `${COLOR.red}${0.85 * alpha})`
        : `rgba(220, 222, 232, ${0.78 * alpha})`;
    ctx.fillText(text, node.x, labelY);
    ctx.textAlign = "left";
  }

  private drawBadges(node: GraphNode, radius: number, dim: boolean): void {
    const { ctx } = this;
    const visible = node.badges.slice(0, 4);
    if (visible.length === 0) return;

    ctx.font = "9px ui-monospace, monospace";
    const padX = 5;
    const gap = 4;
    const heights = 13;

    const widths = visible.map((b) => ctx.measureText(b.name).width + padX * 2);
    const totalWidth = widths.reduce((acc, w) => acc + w, 0) + gap * (visible.length - 1);
    let x = node.x - totalWidth / 2;
    const y = node.y + radius + 24;
    const alpha = dim ? 0.35 : 1;

    for (let i = 0; i < visible.length; i++) {
      const badge = visible[i]!;
      const w = widths[i]!;
      const color = COLOR[badgeColor(badge)];
      ctx.fillStyle = `${color}${0.18 * alpha})`;
      roundRect(ctx, x, y, w, heights, 3);
      ctx.fill();
      ctx.strokeStyle = `${color}${0.55 * alpha})`;
      ctx.lineWidth = 0.8;
      roundRect(ctx, x, y, w, heights, 3);
      ctx.stroke();
      ctx.fillStyle = `${color}${0.95 * alpha})`;
      ctx.textBaseline = "middle";
      ctx.fillText(badge.name, x + padX, y + heights / 2 + 0.5);
      x += w + gap;
    }

    if (node.badges.length > visible.length) {
      const overflow = `+${node.badges.length - visible.length}`;
      ctx.fillStyle = `${COLOR.slate}${0.7 * alpha})`;
      ctx.fillText(overflow, x + 4, y + heights / 2 + 0.5);
    }
    ctx.textBaseline = "alphabetic";
  }

  // ── Pointer events ───────────────────────────────────────────────────────

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.camX) / this.camZoom,
      y: (sy - this.camY) / this.camZoom,
    };
  }

  private localPoint(e: PointerEvent): { sx: number; sy: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  }

  private hitTest(sx: number, sy: number): number | null {
    const world = this.screenToWorld(sx, sy);
    const focusVisibleIds = this.getFocusVisibleIds();
    let best: { idx: number; dist: number } | null = null;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      if (focusVisibleIds && !focusVisibleIds.has(n.id)) continue;
      const dx = n.x - world.x;
      const dy = n.y - world.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const hitR = (n.baseRadius + 8) * 1; // padding for easier hits
      if (d <= hitR && (best === null || d < best.dist)) {
        best = { idx: i, dist: d };
      }
    }
    return best ? best.idx : null;
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const { sx, sy } = this.localPoint(e);
    const hit = this.hitTest(sx, sy);
    if (hit !== null) {
      this.draggingIdx = hit;
      this.dragMoved = false;
      this.dragOrigin = { sx, sy };
      const node = this.nodes[hit]!;
      node.pinned = true;
      this.canvas.classList.add("is-grabbing");
    } else {
      this.panOrigin = { sx, sy, camX: this.camX, camY: this.camY };
      this.canvas.classList.add("is-grabbing");
    }
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    const { sx, sy } = this.localPoint(e);
    if (this.draggingIdx !== null) {
      const node = this.nodes[this.draggingIdx]!;
      const world = this.screenToWorld(sx, sy);
      node.x = world.x;
      node.y = world.y;
      node.vx = 0;
      node.vy = 0;
      if (this.dragOrigin) {
        const dx = sx - this.dragOrigin.sx;
        const dy = sy - this.dragOrigin.sy;
        if (dx * dx + dy * dy > 9) this.dragMoved = true;
      }
      return;
    }
    if (this.panOrigin) {
      this.camX = this.panOrigin.camX + (sx - this.panOrigin.sx);
      this.camY = this.panOrigin.camY + (sy - this.panOrigin.sy);
      return;
    }
    const hit = this.hitTest(sx, sy);
    if (hit !== this.hoveredIdx) {
      this.hoveredIdx = hit;
      this.canvas.classList.toggle("is-pointer", hit !== null);
    }
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    this.canvas.classList.remove("is-grabbing");
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (this.draggingIdx !== null) {
      const idx = this.draggingIdx;
      const node = this.nodes[idx]!;
      this.draggingIdx = null;

      // Tap (no drag) = select or open.
      if (!this.dragMoved) {
        node.pinned = false;
        if (this.selectedEntryId === node.id) {
          this.options.onSelectEntry(node.id);
        } else {
          this.selectedEntryId = node.id;
          this.centerOnNode(node);
        }
      }
      this.dragOrigin = null;
      return;
    }
    this.panOrigin = null;
  };

  private readonly onPointerLeave = () => {
    if (this.draggingIdx === null && this.panOrigin === null) {
      this.hoveredIdx = null;
      this.canvas.classList.remove("is-pointer");
    }
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { sx, sy } = this.localPoint(e as unknown as PointerEvent);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.applyZoom(factor, sx, sy);
  };

  // ── Helpers ──────────────────────────────────────────────────────────────

  private makeToolbarBtn(label: string, title: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "collection-graph-toolbar-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.textContent = label;
    return btn;
  }
}

// ── Edge construction ──────────────────────────────────────────────────────

function buildEdges(
  nodes: GraphNode[],
  semanticEdges: SemanticGraphEdge[] = [],
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  if (nodes.length < 2) return edges;

  const seen = new Set<string>();
  const addEdge = (
    a: number,
    b: number,
    weight: number,
    reason: GraphEdge["reason"],
    score?: number,
  ) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, weight, reason, score });
  };

  // ── Primary: semantic similarity (KNN over embeddings) ──────────────────
  // This is the meaningful structure — entries about the same thing connect,
  // regardless of which app they were copied from. Edge weight scales with
  // similarity so stronger matches pull harder in the layout.
  const indexById = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) indexById.set(nodes[i]!.id, i);
  const semanticallyConnected = new Set<number>();
  for (const edge of semanticEdges) {
    const a = indexById.get(edge.source);
    const b = indexById.get(edge.target);
    if (a === undefined || b === undefined) continue;
    // Map similarity (typically 0.55–1.0) onto a spring weight ~1.5–4.0.
    const weight = 1.5 + edge.similarity * 2.5;
    addEdge(a, b, weight, "semantic", edge.similarity);
    semanticallyConnected.add(a);
    semanticallyConnected.add(b);
  }

  // ── Secondary: metadata edges (badge / source-app / import-origin) ──────
  // These only add structure where semantics didn't already connect nodes.
  // Index nodes by badge name for shared-badge edges.
  const byBadge = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    for (const badge of node.badges) {
      const key = badge.name.toLowerCase();
      if (!byBadge.has(key)) byBadge.set(key, []);
      byBadge.get(key)!.push(i);
    }
  }

  for (const indices of byBadge.values()) {
    if (indices.length < 2) continue;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        addEdge(indices[i]!, indices[j]!, 2.2, "badge");
      }
    }
  }

  // Same source app — fallback only. Sharing a source app (e.g. both copied
  // from a browser) is not a meaningful relationship, so these edges are only
  // drawn for nodes that semantics left unconnected, preventing spurious links
  // like "morning"→"email" from dominating the graph.
  const bySourceApp = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    if (semanticallyConnected.has(i)) continue;
    const sa = nodes[i]!.entry.source_app?.trim();
    if (!sa) continue;
    const key = sa.toLowerCase();
    if (!bySourceApp.has(key)) bySourceApp.set(key, []);
    bySourceApp.get(key)!.push(i);
  }
  for (const indices of bySourceApp.values()) {
    if (indices.length < 2) continue;
    // Cap to avoid quadratic blow-up: link each in a ring.
    for (let i = 0; i < indices.length; i++) {
      const a = indices[i]!;
      const b = indices[(i + 1) % indices.length]!;
      addEdge(a, b, 0.8, "source-app");
    }
  }

  // Same import origin — fallback only, same rationale as source app.
  const byImport = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    if (semanticallyConnected.has(i)) continue;
    const origin = nodes[i]!.entry.import_origin?.trim();
    if (!origin) continue;
    if (!byImport.has(origin)) byImport.set(origin, []);
    byImport.get(origin)!.push(i);
  }
  for (const indices of byImport.values()) {
    if (indices.length < 2) continue;
    for (let i = 0; i < indices.length; i++) {
      const a = indices[i]!;
      const b = indices[(i + 1) % indices.length]!;
      addEdge(a, b, 0.5, "import-origin");
    }
  }

  // Ensure isolates get one weak edge to a temporal neighbour, so the layout
  // still feels coherent.
  const connected = new Set<number>();
  for (const e of edges) {
    connected.add(e.a);
    connected.add(e.b);
  }
  const ordered = nodes
    .map((n, i) => ({ i, t: n.entry.created_at }))
    .sort((a, b) => b.t - a.t);
  for (let k = 0; k < ordered.length; k++) {
    const idx = ordered[k]!.i;
    if (connected.has(idx)) continue;
    const neighbour = ordered[k - 1]?.i ?? ordered[k + 1]?.i;
    if (neighbour === undefined) continue;
    addEdge(idx, neighbour, 0.3, "neighbour");
    connected.add(idx);
    connected.add(neighbour);
  }

  return edges;
}

function collectNeighbours(edges: GraphEdge[], idx: number): Set<number> {
  const result = new Set<number>();
  result.add(idx);
  for (const edge of edges) {
    if (edge.a === idx) result.add(edge.b);
    else if (edge.b === idx) result.add(edge.a);
  }
  return result;
}

// ── Force simulation ───────────────────────────────────────────────────────

function simulate(
  nodes: GraphNode[],
  edges: GraphEdge[],
  W: number,
  H: number,
  dt: number,
  draggingIdx: number | null,
): void {
  if (nodes.length === 0) return;
  const cx = W / 2;
  const cy = H / 2;

  const repulsion = 1800;
  const springLength = 110;
  const springK = 0.04;
  const centerK = 0.0035;
  const damping = 0.86;
  const maxSpeed = 220;

  // Reset accelerations
  const ax = new Array<number>(nodes.length).fill(0);
  const ay = new Array<number>(nodes.length).fill(0);

  // Repulsion (O(N^2), capped for safety)
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let dist2 = dx * dx + dy * dy;
      if (dist2 < 0.01) {
        dx = (Math.random() - 0.5) * 0.5;
        dy = (Math.random() - 0.5) * 0.5;
        dist2 = dx * dx + dy * dy + 0.01;
      }
      const dist = Math.sqrt(dist2);
      const force = repulsion / dist2;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      ax[i] += fx;
      ay[i] += fy;
      ax[j] -= fx;
      ay[j] -= fy;
    }
  }

  // Springs
  for (const edge of edges) {
    const a = nodes[edge.a]!;
    const b = nodes[edge.b]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const target = springLength / Math.max(0.6, edge.weight * 0.5);
    const delta = dist - target;
    const force = springK * delta * Math.min(2.4, edge.weight * 0.7 + 0.6);
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    ax[edge.a] += fx;
    ay[edge.a] += fy;
    ax[edge.b] -= fx;
    ay[edge.b] -= fy;
  }

  // Centring
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    ax[i] += (cx - node.x) * centerK;
    ay[i] += (cy - node.y) * centerK;
  }

  // Integrate
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (i === draggingIdx || node.pinned) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx = (node.vx + ax[i]! * dt) * damping;
    node.vy = (node.vy + ay[i]! * dt) * damping;
    const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (speed > maxSpeed) {
      node.vx = (node.vx / speed) * maxSpeed;
      node.vy = (node.vy / speed) * maxSpeed;
    }
    node.x += node.vx * dt;
    node.y += node.vy * dt;
  }
}

// ── Geometry helpers ───────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
