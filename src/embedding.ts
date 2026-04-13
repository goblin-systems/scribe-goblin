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
export async function getEmbedding(text: string, settings: Settings): Promise<number[]> {
  const input = text.slice(0, 8192); // guard against oversized inputs
  debugLog(`getEmbedding: provider=${settings.embeddingProvider}, model=${settings.embeddingModel}`, "INFO");

  switch (settings.embeddingProvider) {
    case "local":
      return getLocalEmbedding(input);
    case "openai":
      if (!settings.providers.openai.apiKey) {
        debugLog("getEmbedding: OpenAI key is missing", "ERROR");
        throw new Error("OpenAI API key is missing");
      }
      return getOpenAIEmbedding(input, settings.providers.openai.apiKey, settings.embeddingModel);
    case "gemini":
      if (!settings.providers.gemini.apiKey) {
        debugLog("getEmbedding: Gemini key is missing", "ERROR");
        throw new Error("Gemini API key is missing");
      }
      return getGeminiEmbedding(input, settings.providers.gemini.apiKey, settings.embeddingModel);
    case "ollama":
      if (!settings.providers.ollama.baseUrl) {
        debugLog("getEmbedding: Ollama base URL is missing", "ERROR");
        throw new Error("Ollama base URL is missing");
      }
      return getOllamaEmbedding(input, settings.providers.ollama.baseUrl, settings.embeddingModel);
    default:
      debugLog(`getEmbedding: Unknown provider ${settings.embeddingProvider}`, "ERROR");
      throw new Error("No embedding provider configured");
  }
}

async function getLocalEmbedding(text: string): Promise<number[]> {
  debugLog("getLocalEmbedding using classify_text backend", "INFO");
  const result = await invoke<{ embedding: number[] }>("classify_text", { text });
  return result.embedding;
}

async function getOpenAIEmbedding(text: string, apiKey: string, model: string): Promise<number[]> {
  debugLog(`getOpenAIEmbedding: model=${model}`, "INFO");
  const res = await httpFetch(
    "https://api.openai.com/v1/embeddings",
    "POST",
    {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    JSON.stringify({ input: text, model })
  );

  if (res.status !== 200) {
    debugLog(`OpenAI embeddings error ${res.status}: ${res.body}`, "ERROR");
    throw new Error(`OpenAI embeddings error ${res.status}: ${res.body}`);
  }

  try {
    const json = JSON.parse(res.body) as { data: { embedding: number[] }[] };
    return json.data[0].embedding;
  } catch (err) {
    debugLog(`Failed to parse OpenAI embedding response: ${err}`, "ERROR");
    throw new Error(`Failed to parse OpenAI embedding response: ${err}`);
  }
}

async function getGeminiEmbedding(text: string, apiKey: string, model: string): Promise<number[]> {
  debugLog(`getGeminiEmbedding: model=${model}`, "INFO");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
  const res = await httpFetch(
    url,
    "POST",
    { "Content-Type": "application/json" },
    JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] } })
  );

  if (res.status !== 200) {
    debugLog(`Gemini embeddings error ${res.status}: ${res.body}`, "ERROR");
    throw new Error(`Gemini embeddings error ${res.status}: ${res.body}`);
  }

  try {
    const json = JSON.parse(res.body) as { embedding: { values: number[] } };
    return json.embedding.values;
  } catch (err) {
    debugLog(`Failed to parse Gemini embedding response: ${err}`, "ERROR");
    throw new Error(`Failed to parse Gemini embedding response: ${err}`);
  }
}

async function getOllamaEmbedding(text: string, baseUrl: string, model: string): Promise<number[]> {
  debugLog(`getOllamaEmbedding: baseUrl=${baseUrl}, model=${model}`, "INFO");
  const url = `${baseUrl.replace(/\/$/, "")}/api/embeddings`;
  const res = await httpFetch(
    url,
    "POST",
    { "Content-Type": "application/json" },
    JSON.stringify({ model, prompt: text })
  );

  if (res.status !== 200) {
    debugLog(`Ollama embeddings error ${res.status}: ${res.body}`, "ERROR");
    throw new Error(`Ollama embeddings error ${res.status}: ${res.body}`);
  }

  try {
    const json = JSON.parse(res.body) as { embedding: number[] };
    return json.embedding;
  } catch (err) {
    debugLog(`Failed to parse Ollama embedding response: ${err}`, "ERROR");
    throw new Error(`Failed to parse Ollama embedding response: ${err}`);
  }
}

export async function testEmbeddingConnection(settings: Settings): Promise<string> {
  debugLog(`testEmbeddingConnection invoked for provider: ${settings.embeddingProvider}`, "INFO");
  try {
    await getEmbedding("test", settings);
    debugLog("testEmbeddingConnection: Connection successful", "INFO");
    return "ok";
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    debugLog(`testEmbeddingConnection failed: ${errMsg}`, "ERROR");
    return errMsg;
  }
}
