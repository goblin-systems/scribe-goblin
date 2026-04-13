import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./settings";
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
}

const SYSTEM_PROMPT = `You are a tagging assistant. Given a piece of text, respond with JSON only.
Format: {"summary": "one sentence summary", "tags": ["tag1", "tag2", "tag3"]}
Rules:
- summary: max 120 characters, plain prose
- tags: 2-5 lowercase single-word or short hyphenated tags
- respond with JSON only, no markdown fences`;

export async function enrichEntry(
  content: string,
  settings: Settings
): Promise<EnrichmentResult> {
  const input = content.slice(0, 4000);
  debugLog(`enrichEntry: provider=${settings.enrichmentProvider}, model=${settings.enrichmentModel}`, "INFO");

  switch (settings.enrichmentProvider) {
    case "openai":
      if (!settings.providers.openai.apiKey) {
        debugLog("enrichEntry: OpenAI key is missing", "ERROR");
        throw new Error("OpenAI API key is missing");
      }
      return enrichWithOpenAI(input, settings);
    case "gemini":
      if (!settings.providers.gemini.apiKey) {
        debugLog("enrichEntry: Gemini key is missing", "ERROR");
        throw new Error("Gemini API key is missing");
      }
      return enrichWithGemini(input, settings);
    default:
      debugLog(`enrichEntry: Unknown provider ${settings.enrichmentProvider}`, "ERROR");
      throw new Error("No enrichment provider configured");
  }
}

async function enrichWithOpenAI(content: string, settings: Settings): Promise<EnrichmentResult> {
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
        { role: "system", content: SYSTEM_PROMPT },
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
    return parseEnrichmentJson(json.choices[0].message.content);
  } catch (err) {
    debugLog(`Failed to parse OpenAI enrichment response: ${err}`, "ERROR");
    throw new Error(`Failed to parse OpenAI enrichment response: ${err}`);
  }
}

async function enrichWithGemini(content: string, settings: Settings): Promise<EnrichmentResult> {
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
            { text: SYSTEM_PROMPT + "\n\nText to analyse:\n" + content },
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
    return parseEnrichmentJson(json.candidates[0].content.parts[0].text);
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
    const result = {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === "string")
        : [],
    };
    debugLog(`parseEnrichmentJson output: ${JSON.stringify(result)}`, "INFO");
    return result;
  } catch (err) {
    debugLog(`parseEnrichmentJson parsing error: ${err}`, "ERROR");
    return { summary: "", tags: [] };
  }
}
