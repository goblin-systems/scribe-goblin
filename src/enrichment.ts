import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./settings";
import { LOCAL_QWEN_MODEL_ID } from "./settings";
import { debugLog } from "./logger";

interface HttpProxyResponse {
  status: number;
  body: string;
}

async function httpFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<HttpProxyResponse> {
  debugLog(`httpFetch [${method}] ${url}`, "INFO");
  if (body) {
    debugLog(`Request body preview: ${body.substring(0, 200)}...`, "INFO");
  }
  try {
    const response = await invoke<HttpProxyResponse>("http_fetch", {
      request: { url, method, headers, body: body ?? null },
    });
    debugLog(`httpFetch response status: ${response.status}`, "INFO");
    debugLog(`Response body preview: ${response.body.substring(0, 200)}...`, "INFO");
    return response;
  } catch (err) {
    debugLog(`httpFetch exception: ${err}`, "ERROR");
    throw err;
  }
}

export interface EnrichmentResult {
  summary: string;
  tags: string[];
  source?: "provider" | "heuristic";
  provider?: string;
  model?: string | null;
}

const SUMMARY_PROMPT = `You are a summarization assistant. Given a piece of text, respond with JSON only.
Format: {"summary": "one sentence summary"}
Rules:
- summary: max 120 characters, plain prose
- capture the main meaning, not formatting details
- no markdown, no bullet points, no prefacing text
- respond with JSON only`;

const TAGGING_PROMPT = `You are a tagging assistant. Given a piece of text, respond with JSON only.
Format: {"tags": ["tag1", "tag2", "tag3"]}
Rules:
- tags: 2-6 lowercase tags, specific and content-bearing
- choose open-ended tags from the content; do not choose from a fixed label list
- avoid generic junk like note, text, content, misc, other, general, clipboard, item, info
- dedupe semantically similar tags
- include format, technology, project, domain, intent, or problem tags when they are actually relevant
- respond with JSON only, no markdown fences`;

const GENERIC_TAGS = new Set([
  "note", "notes", "text", "content", "misc", "other", "general", "clipboard", "item", "items",
  "info", "information", "summary", "document", "entry",
]);

function normalizeTag(tag: string): string | null {
  const normalized = tag
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!normalized || GENERIC_TAGS.has(normalized)) return null;
  if (normalized.length < 2 || normalized.length > 32) return null;
  return normalized;
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const next = normalizeTag(tag);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

export function normalizeEnrichmentResult(result: EnrichmentResult): EnrichmentResult {
  return {
    ...result,
    summary: typeof result.summary === "string" ? result.summary.trim() : "",
    tags: dedupeTags(Array.isArray(result.tags) ? result.tags : []),
  };
}

export async function summarizeEntry(
  content: string,
  settings: Settings,
): Promise<EnrichmentResult> {
  const input = content.slice(0, 6000);
  debugLog(`summarizeEntry: provider=${settings.enrichmentProvider}, model=${settings.enrichmentModel}`, "INFO");

  switch (settings.enrichmentProvider) {
    case "openai":
      if (!settings.providers.openai.apiKey) {
        throw new Error("OpenAI API key is missing");
      }
      return enrichWithOpenAI(input, settings, "summary");
    case "gemini":
      if (!settings.providers.gemini.apiKey) {
        throw new Error("Gemini API key is missing");
      }
      return enrichWithGemini(input, settings, "summary");
    case "local-qwen":
      return enrichWithLocalQwen(input, "summary");
    default:
      throw new Error("No enrichment provider configured");
  }
}

export async function enrichEntry(
  content: string,
  settings: Settings
): Promise<EnrichmentResult> {
  const input = settings.enrichmentProvider === "local-qwen"
    ? content.slice(0, 1400)
    : content.slice(0, 4000);
  debugLog(`enrichEntry: provider=${settings.enrichmentProvider}, model=${settings.enrichmentModel}`, "INFO");

  switch (settings.enrichmentProvider) {
    case "openai":
      if (!settings.providers.openai.apiKey) {
        debugLog("enrichEntry: OpenAI key is missing", "ERROR");
        throw new Error("OpenAI API key is missing");
      }
      return enrichWithOpenAI(input, settings, "tags");
    case "gemini":
      if (!settings.providers.gemini.apiKey) {
        debugLog("enrichEntry: Gemini key is missing", "ERROR");
        throw new Error("Gemini API key is missing");
      }
      return enrichWithGemini(input, settings, "tags");
    case "local-qwen":
      return enrichWithLocalQwen(input, "tags");
    default:
      debugLog(`enrichEntry: Unknown provider ${settings.enrichmentProvider}`, "ERROR");
      throw new Error("No enrichment provider configured");
  }
}

async function enrichWithOpenAI(
  content: string,
  settings: Settings,
  mode: "summary" | "tags",
): Promise<EnrichmentResult> {
  const apiKey = settings.providers.openai.apiKey;
  debugLog(`enrichWithOpenAI: model=${settings.enrichmentModel}`, "INFO");

  const res = await httpFetch(
    "https://api.openai.com/v1/chat/completions",
    "POST",
    {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    JSON.stringify({
      model: settings.enrichmentModel || "gpt-4o-mini",
      messages: [
        { role: "system", content: mode === "summary" ? SUMMARY_PROMPT : TAGGING_PROMPT },
        { role: "user", content },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" }
    })
  );

  if (res.status !== 200) {
    debugLog(`OpenAI enrichment error ${res.status}: ${res.body}`, "ERROR");
    throw new Error(`OpenAI enrichment error ${res.status}: ${res.body}`);
  }

  try {
    const json = JSON.parse(res.body) as {
      choices: { message: { content: string } }[];
    };
    return {
      ...parseEnrichmentJson(json.choices[0].message.content),
      source: "provider",
      provider: "openai",
      model: settings.enrichmentModel || "gpt-4o-mini",
    };
  } catch (err) {
    debugLog(`Failed to parse OpenAI enrichment response: ${err}`, "ERROR");
    throw new Error(`Failed to parse OpenAI enrichment response: ${err}`);
  }
}

async function enrichWithLocalQwen(
  content: string,
  mode: "summary" | "tags",
): Promise<EnrichmentResult> {
  debugLog(`enrichWithLocalQwen: mode=${mode}`, "INFO");

  try {
    const status = await invoke<{
      loaded: boolean;
      model_id: string;
      model_path?: string;
      model_exists?: boolean;
      chat_template_path?: string;
      chat_template_exists?: boolean;
    }>("qwen_status").catch((err) => {
      debugLog(`enrichWithLocalQwen: qwen_status failed: ${err}`, "WARN");
      return null;
    });
    if (status) {
      debugLog(
        `enrichWithLocalQwen: status loaded=${status.loaded}, model_exists=${status.model_exists}, template_exists=${status.chat_template_exists}, model_path=${status.model_path ?? "unknown"}`,
        "INFO",
      );
    }

    const started = Date.now();
    const pendingTimers = [10_000, 30_000, 60_000, 120_000].map((delayMs) =>
      globalThis.setTimeout(() => {
        debugLog(
          `enrichWithLocalQwen: still waiting after ${Math.round((Date.now() - started) / 1000)}s, mode=${mode}`,
          "WARN",
        );
      }, delayMs),
    );

    let result: {
      raw_response: string;
      model_id: string;
      prompt_tps: number;
      completion_tps: number;
    };
    try {
      result = await invoke<{
        raw_response: string;
        model_id: string;
        prompt_tps: number;
        completion_tps: number;
      }>("qwen_generate_tags", {
        text: content,
        systemPrompt: mode === "summary" ? SUMMARY_PROMPT : TAGGING_PROMPT,
        maxTokens: mode === "summary" ? 48 : 32,
      });
    } finally {
      pendingTimers.forEach((timer) => globalThis.clearTimeout(timer));
    }

    debugLog(
      `enrichWithLocalQwen: completed in ${Date.now() - started}ms, model=${result.model_id}, prompt_tps=${result.prompt_tps.toFixed(2)}, completion_tps=${result.completion_tps.toFixed(2)}, raw=${result.raw_response.slice(0, 180).replace(/\s+/g, " ")}`,
      "INFO",
    );

    return {
      ...parseEnrichmentJson(result.raw_response),
      source: "provider",
      provider: "local-qwen",
      model: result.model_id || LOCAL_QWEN_MODEL_ID,
    };
  } catch (err) {
    debugLog(`enrichWithLocalQwen failed: ${err}`, "ERROR");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function enrichWithGemini(
  content: string,
  settings: Settings,
  mode: "summary" | "tags",
): Promise<EnrichmentResult> {
  const apiKey = settings.providers.gemini.apiKey;
  const model = settings.enrichmentModel || "gemini-2.5-flash";
  debugLog(`enrichWithGemini: model=${model}`, "INFO");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await httpFetch(
    url,
    "POST",
    { "Content-Type": "application/json" },
    JSON.stringify({
      contents: [
        {
          parts: [
            { text: (mode === "summary" ? SUMMARY_PROMPT : TAGGING_PROMPT) + "\n\nText to analyse:\n" + content },
          ],
        },
      ],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    })
  );

  if (res.status !== 200) {
    debugLog(`Gemini enrichment error ${res.status}: ${res.body}`, "ERROR");
    throw new Error(`Gemini enrichment error ${res.status}: ${res.body}`);
  }

  try {
    const json = JSON.parse(res.body) as {
      candidates: { content: { parts: { text: string }[] } }[];
    };
    return {
      ...parseEnrichmentJson(json.candidates[0].content.parts[0].text),
      source: "provider",
      provider: "gemini",
      model,
    };
  } catch (err) {
    debugLog(`Failed to parse Gemini enrichment response: ${err}`, "ERROR");
    throw new Error(`Failed to parse Gemini enrichment response: ${err}`);
  }
}

function parseEnrichmentJson(raw: string): EnrichmentResult {
  debugLog(`parseEnrichmentJson input: ${raw}`, "INFO");
  const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as { summary?: string; tags?: string[] };
    const result = normalizeEnrichmentResult({
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === "string")
        : [],
      source: "provider",
    });
    debugLog(`parseEnrichmentJson output: ${JSON.stringify(result)}`, "INFO");
    return result;
  } catch (err) {
    debugLog(`parseEnrichmentJson parsing error: ${err}`, "ERROR");
    return { summary: "", tags: [], source: "provider" };
  }
}
