import { describe, test, expect } from "vitest";
import { getEmbedding, testEmbeddingConnection } from "../src/embedding";
import { enrichEntry } from "../src/enrichment";
import type { Settings } from "../src/settings";

const baseSettings: Settings = {
  clipboardMonitoring: true,
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY || "", modelCache: null },
    gemini: { apiKey: process.env.GEMINI_API_KEY || "", modelCache: null },
    ollama: { baseUrl: "http://localhost:11434" },
  },
  embeddingProvider: "none",
  embeddingModel: "",
  enrichmentEnabled: true,
  enrichmentProvider: "none",
  enrichmentModel: "",
  debugLoggingEnabled: true,
};

describe("Integration: API Providers", () => {
  describe("OpenAI", () => {
    test("getEmbedding works with text-embedding-3-small", async () => {
      const settings: Settings = {
        ...baseSettings,
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
      };
      if (!settings.providers.openai.apiKey) {
        console.warn("Skipping OpenAI tests because OPENAI_API_KEY is not set.");
        return;
      }
      
      const result = await getEmbedding("This is a test document.", settings);
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBeGreaterThan(0);
      expect(typeof result[0]).toBe("number");
    });

    test("enrichEntry works with gpt-4o-mini", async () => {
      const settings: Settings = {
        ...baseSettings,
        enrichmentProvider: "openai",
        enrichmentModel: "gpt-4o-mini",
      };
      if (!settings.providers.openai.apiKey) return;
      
      const result = await enrichEntry("The goblin walked into the cave and found a shiny gold coin.", settings);
      expect(typeof result.summary).toBe("string");
      expect(result.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(result.tags)).toBe(true);
    });
  });

  describe("Gemini", () => {
    test("getEmbedding works with gemini-embedding-001", async () => {
      const settings: Settings = {
        ...baseSettings,
        embeddingProvider: "gemini",
        embeddingModel: "gemini-embedding-001",
      };
      if (!settings.providers.gemini.apiKey) {
        console.warn("Skipping Gemini tests because GEMINI_API_KEY is not set.");
        return;
      }
      
      const result = await getEmbedding("This is a test document.", settings);
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBeGreaterThan(0);
      expect(typeof result[0]).toBe("number");
    });

    test("enrichEntry works with gemini-2.5-flash", async () => {
      const settings: Settings = {
        ...baseSettings,
        enrichmentProvider: "gemini",
        enrichmentModel: "gemini-2.5-flash",
      };
      if (!settings.providers.gemini.apiKey) return;
      
      const result = await enrichEntry("The goblin walked into the cave and found a shiny gold coin.", settings);
      expect(typeof result.summary).toBe("string");
      expect(result.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(result.tags)).toBe(true);
    });
  });
});
