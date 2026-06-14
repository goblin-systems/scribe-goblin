/**
 * Inline "ghost text" autocomplete for search inputs (main window + overlay).
 *
 * A suggestion is rendered in pale text immediately after the caret; pressing
 * Tab accepts it. The completion comes from the configured model: a local LLM
 * (via the `autocomplete_complete` Tauri command) or a cloud chat model
 * (OpenAI/Gemini, via the `http_fetch` proxy). The model is only asked when the
 * caret is at the end of the input — the standard ghost-completion behavior.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./settings";
import { normalizeSearchEntryResults, type SearchEntryResultPayload } from "./store";

export interface AutocompleteHandle {
  /** Re-evaluate enabled state / refresh the suggestion for the current value. */
  refresh(): void;
  /** Remove listeners and the ghost element. */
  detach(): void;
}

const MIN_PREFIX_CHARS = 2;
const DEBOUNCE_MS = 300;
const MAX_CACHE = 100;
const GHOST_STYLE_ID = "autocomplete-ghost-style";

const SYSTEM_PROMPT =
  "You are a search autocomplete engine. The user sends a partial search query. " +
  "Reply with ONLY the single most likely completed query as plain text and nothing else: " +
  "no quotes, no explanation, no list, no markdown. Your reply MUST begin with the user's exact " +
  "input text and then continue it. Finish the current word and add at most a few more words.";

/** How many matching records to feed as grounding context, and how much of each. */
const CONTEXT_RECORDS = 6;
const CONTEXT_SNIPPET_CHARS = 200;
const CONTEXT_TOTAL_CHARS = 1200;

interface HttpProxyResponse {
  status: number;
  body: string;
}

/** Fetch the user's currently-matching records (cheap keyword search) to ground
 *  the completion in their actual history. Empty string on any failure. */
async function fetchContext(prefix: string, settings: Settings): Promise<string> {
  try {
    const results = await invoke<SearchEntryResultPayload[]>("search_entries", {
      query: prefix,
      filters: {},
      limit: CONTEXT_RECORDS,
      mode: "keyword",
      queryEmbedding: null,
      rankingConfig: settings.ranking,
    });
    const lines = normalizeSearchEntryResults(results)
      .map((r) => r.entry.content.replace(/\s+/g, " ").trim().slice(0, CONTEXT_SNIPPET_CHARS))
      .filter((s) => s.length > 0);
    return lines.join("\n").slice(0, CONTEXT_TOTAL_CHARS);
  } catch {
    return "";
  }
}

/** System prompt augmented with the matching records as grounding. */
function systemWithContext(context: string): string {
  if (!context) return SYSTEM_PROMPT;
  return (
    `${SYSTEM_PROMPT}\n\n` +
    "These are the user's matching saved entries — use them as grounding so the completion " +
    "reflects their actual history. Prefer continuations consistent with them, but you may " +
    `extend beyond them when sensible:\n${context}`
  );
}

// ── Suffix extraction (mirrors the Rust `completion_suffix`) ────────────────

/** The part of `completion` that extends `prefix` (prefix matched
 *  case-insensitively); empty when the model didn't echo the prefix. */
export function completionSuffix(prefix: string, completion: string): string {
  let cleaned = completion.trim().replace(/^["'`]+/, "").replace(/["'`]+$/, "").trimStart();
  cleaned = cleaned.split("\n")[0] ?? "";

  const prefixChars = [...prefix];
  const completionChars = [...cleaned];
  if (completionChars.length < prefixChars.length) return "";
  for (let i = 0; i < prefixChars.length; i++) {
    if (prefixChars[i].toLowerCase() !== completionChars[i].toLowerCase()) return "";
  }
  return completionChars.slice(prefixChars.length).join("");
}

// ── Model calls ─────────────────────────────────────────────────────────────

async function requestCompletion(prefix: string, settings: Settings): Promise<string> {
  // Ground the completion in the user's actual matching records.
  const context = await fetchContext(prefix, settings);
  switch (settings.autocompleteProvider) {
    case "local-qwen":
      return invoke<string>("autocomplete_complete", {
        prefix,
        context: context || null,
        modelPath: settings.autocompleteModelPath?.trim() || null,
        engine: settings.inferenceEngine,
        gpuLayers: settings.inferenceGpuLayers,
      });
    case "openai":
      return cloudOpenAI(prefix, context, settings);
    case "gemini":
      return cloudGemini(prefix, context, settings);
    default:
      return "";
  }
}

async function cloudOpenAI(prefix: string, context: string, settings: Settings): Promise<string> {
  const apiKey = settings.providers.openai.apiKey;
  if (!apiKey) return "";
  const res = await invoke<HttpProxyResponse>("http_fetch", {
    request: {
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.autocompleteModel || "gpt-4o-mini",
        messages: [
          { role: "system", content: systemWithContext(context) },
          { role: "user", content: prefix },
        ],
        temperature: 0,
        max_tokens: 16,
      }),
    },
  });
  if (res.status !== 200) return "";
  const json = JSON.parse(res.body) as { choices?: { message?: { content?: string } }[] };
  return completionSuffix(prefix, json.choices?.[0]?.message?.content ?? "");
}

async function cloudGemini(prefix: string, context: string, settings: Settings): Promise<string> {
  const apiKey = settings.providers.gemini.apiKey;
  if (!apiKey) return "";
  const model = settings.autocompleteModel || "gemini-2.5-flash";
  const res = await invoke<HttpProxyResponse>("http_fetch", {
    request: {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemWithContext(context)}\n\nPartial query:\n${prefix}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      }),
    },
  });
  if (res.status !== 200) return "";
  const json = JSON.parse(res.body) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return completionSuffix(prefix, json.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
}

// ── Ghost overlay ─────────────────────────────────────────────────────────

const GEOMETRY_PROPS = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
  "textIndent", "textTransform", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth", "textAlign", "color",
] as const;

function ensureGhostStyles(): void {
  if (document.getElementById(GHOST_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = GHOST_STYLE_ID;
  style.textContent = `
.autocomplete-ghost {
  position: absolute;
  pointer-events: none;
  z-index: 2;
  overflow: hidden;
  white-space: pre;
  box-sizing: border-box;
  border-style: solid;
  border-color: transparent;
  background: transparent;
  margin: 0;
}
.autocomplete-ghost__typed { visibility: hidden; }
.autocomplete-ghost__suffix { opacity: 0.45; }
`;
  document.head.appendChild(style);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Attachment ──────────────────────────────────────────────────────────────

export interface AttachOptions {
  /** Live settings accessor; ghost stays inert while it returns null. */
  getSettings: () => Settings | null;
}

export function attachAutocomplete(
  input: HTMLInputElement,
  options: AttachOptions,
): AutocompleteHandle {
  ensureGhostStyles();

  const parent = input.parentElement;
  if (!parent) {
    return { refresh: () => {}, detach: () => {} };
  }
  if (getComputedStyle(parent).position === "static") {
    parent.style.position = "relative";
  }

  const ghost = document.createElement("div");
  ghost.className = "autocomplete-ghost";
  ghost.setAttribute("aria-hidden", "true");
  parent.insertBefore(ghost, input.nextSibling);

  let suffix = "";
  let requestSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let prefetched = false;
  const cache = new Map<string, string>();

  const isEnabled = (): boolean => options.getSettings()?.autocompleteEnabled ?? false;

  const caretAtEnd = (): boolean =>
    input.selectionStart === input.value.length &&
    input.selectionEnd === input.value.length;

  function clearGhost(): void {
    suffix = "";
    ghost.replaceChildren();
    ghost.style.display = "none";
  }

  function syncGeometry(): void {
    const cs = getComputedStyle(input);
    ghost.style.left = `${input.offsetLeft}px`;
    ghost.style.top = `${input.offsetTop}px`;
    ghost.style.width = `${input.offsetWidth}px`;
    ghost.style.height = `${input.offsetHeight}px`;
    for (const prop of GEOMETRY_PROPS) {
      ghost.style[prop] = cs[prop];
    }
    // Inputs vertically center single-line text in their content box; match it
    // by setting line-height to the content height.
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    ghost.style.lineHeight = `${input.clientHeight - padTop - padBottom}px`;
    ghost.scrollLeft = input.scrollLeft;
  }

  function renderGhost(): void {
    if (!suffix) {
      clearGhost();
      return;
    }
    ghost.innerHTML =
      `<span class="autocomplete-ghost__typed">${escapeHtml(input.value)}</span>` +
      `<span class="autocomplete-ghost__suffix">${escapeHtml(suffix)}</span>`;
    ghost.style.display = "block";
    syncGeometry();
  }

  function showSuffix(value: string): void {
    suffix = value;
    renderGhost();
  }

  function cacheKey(settings: Settings, prefix: string): string {
    return `${settings.autocompleteProvider}|${settings.autocompleteModel}|${prefix}`;
  }

  function update(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const settings = options.getSettings();
    const prefix = input.value;

    if (
      !settings ||
      !settings.autocompleteEnabled ||
      document.activeElement !== input ||
      !caretAtEnd() ||
      prefix.trim().length < MIN_PREFIX_CHARS
    ) {
      clearGhost();
      return;
    }

    const key = cacheKey(settings, prefix);
    const cached = cache.get(key);
    if (cached !== undefined) {
      showSuffix(cached);
      return;
    }

    // Drop a stale suffix while we wait for the new request.
    clearGhost();

    const seq = ++requestSeq;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void requestCompletion(prefix, settings)
        .then((result) => {
          if (seq !== requestSeq || input.value !== prefix) return;
          if (cache.size >= MAX_CACHE) cache.clear();
          cache.set(key, result);
          showSuffix(result);
        })
        .catch(() => {
          // Model missing / network error: just show no suggestion.
        });
    }, DEBOUNCE_MS);
  }

  function accept(): void {
    if (!suffix) return;
    input.value += suffix;
    input.setSelectionRange(input.value.length, input.value.length);
    clearGhost();
    // Let the host's own search listeners react to the accepted text.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  const onInput = () => update();
  const onKeyup = (event: KeyboardEvent) => {
    // Caret moves (arrows, Home/End) can hide/show the ghost.
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) update();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Tab" && !event.shiftKey && suffix && caretAtEnd()) {
      event.preventDefault();
      event.stopPropagation();
      accept();
    }
  };
  const onFocus = () => {
    const settings = options.getSettings();
    if (isEnabled() && !prefetched && settings?.autocompleteProvider === "local-qwen") {
      prefetched = true;
      void invoke("autocomplete_prefetch", {
        modelPath: settings.autocompleteModelPath?.trim() || null,
        engine: settings.inferenceEngine,
        gpuLayers: settings.inferenceGpuLayers,
      }).catch(() => {});
    }
    update();
  };
  const onBlur = () => clearGhost();
  const onScroll = () => {
    if (suffix) ghost.scrollLeft = input.scrollLeft;
  };
  const onResize = () => {
    if (suffix) syncGeometry();
  };

  input.addEventListener("input", onInput);
  input.addEventListener("keyup", onKeyup);
  input.addEventListener("keydown", onKeydown);
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  input.addEventListener("scroll", onScroll);
  window.addEventListener("resize", onResize);

  clearGhost();

  return {
    refresh() {
      // Settings (model/provider/enabled) may have changed.
      prefetched = false;
      cache.clear();
      update();
    },
    detach() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      input.removeEventListener("input", onInput);
      input.removeEventListener("keyup", onKeyup);
      input.removeEventListener("keydown", onKeydown);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("blur", onBlur);
      input.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      ghost.remove();
    },
  };
}
