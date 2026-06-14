/**
 * Lightweight determinate progress bar for long-running batch operations
 * (regenerate embeddings, retag all items). Renders a fill bar plus a live
 * "<done>/<total> · <rate>/s · ~<eta> left" readout and tracks its own timing
 * to compute throughput.
 */

export interface ProgressBarHandle {
  /** Report progress. Call before the first item with done=0 to show 0%. */
  update: (done: number, total: number) => void;
  /** Show a terminal message (e.g. "Done") and stop the rate readout. */
  finish: (message?: string) => void;
  /** Hide and clear the bar. */
  reset: () => void;
}

function formatRate(itemsPerSec: number): string {
  if (!Number.isFinite(itemsPerSec) || itemsPerSec <= 0) return "—/s";
  if (itemsPerSec >= 10) return `${Math.round(itemsPerSec)}/s`;
  return `${itemsPerSec.toFixed(1)}/s`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 1) return "<1s left";
  if (seconds < 60) return `~${Math.round(seconds)}s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `~${m}m ${s}s left`;
}

export function createProgressBar(host: HTMLElement): ProgressBarHandle {
  host.hidden = false;
  host.replaceChildren();

  const fillTrack = document.createElement("div");
  fillTrack.className = "progress-track";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  fill.style.width = "0%";
  fillTrack.appendChild(fill);

  const label = document.createElement("p");
  label.className = "hint progress-label";
  label.style.margin = "4px 0 0 0";
  label.textContent = "Starting…";

  host.append(fillTrack, label);

  const startMs = Date.now();

  return {
    update(done: number, total: number) {
      const safeTotal = Math.max(total, 1);
      const pct = Math.min(100, Math.round((done / safeTotal) * 100));
      fill.style.width = `${pct}%`;

      const elapsedSec = (Date.now() - startMs) / 1000;
      const rate = elapsedSec > 0 ? done / elapsedSec : 0;
      const remaining = rate > 0 ? (total - done) / rate : Infinity;

      const parts = [`${done}/${total}`, formatRate(rate)];
      const eta = formatEta(remaining);
      if (eta && done < total) parts.push(eta);
      label.textContent = parts.join(" · ");
    },
    finish(message = "Done") {
      fill.style.width = "100%";
      const elapsedSec = (Date.now() - startMs) / 1000;
      label.textContent =
        elapsedSec >= 1 ? `${message} · ${elapsedSec.toFixed(1)}s total` : message;
    },
    reset() {
      host.hidden = true;
      host.replaceChildren();
    },
  };
}
