import { vi } from 'vitest';

// In-memory mock DB
let mockEntries: any[] = [];
let nextId = 1;

vi.mock('@tauri-apps/api/core', () => {
  return {
    invoke: async (command: string, args: any) => {
      if (command === 'http_fetch') {
        const req = args.request;
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body || undefined
        });
        const body = await res.text();
        return {
          status: res.status,
          body: body
        };
      }

      if (command === 'db_add_entry') {
        const id = "mock-" + nextId++;
        const entry = {
          id,
          content: args.content,
          html_content: args.htmlContent,
          source: args.source,
          source_app: args.sourceApp || null,
          created_at: args.createdAt,
          label: null,
          label_score: null,
          embedding: null
        };
        mockEntries.push(entry);
        return id;
      }

      if (command === 'db_list_entries') {
        let results = [...mockEntries];
        if (args.search) {
          const q = args.search.toLowerCase();
          results = results.filter(e => 
            e.content.toLowerCase().includes(q) || 
            (e.label && e.label.toLowerCase().includes(q))
          );
        }
        return results.slice(0, args.limit).sort((a: any, b: any) => b.created_at - a.created_at);
      }

      if (command === 'db_update_entry_classification') {
        const entry = mockEntries.find(e => e.id === args.id);
        if (entry) {
          entry.label = args.label;
          entry.label_score = args.labelScore;
          entry.embedding = args.embedding;
        }
        return;
      }

      if (command === 'db_delete_entry') {
        mockEntries = mockEntries.filter(e => e.id !== args.id);
        return;
      }

      if (command === 'db_get_embeddings') {
        return mockEntries.filter(e => e.embedding !== null);
      }

      if (command === 'classify_text') {
        return { label: "other", label_score: 0.5, embedding: new Array(384).fill(0.0) };
      }

      if (command === 'db_init') return;

      throw new Error(`Mocked invoke does not support ${command}`);
    }
  };
});

vi.mock('../src/logger', () => {
  return {
    debugLog: (msg: string, level: string) => console.log(`[${level}] ${msg}`),
    configureDebugLogging: () => {},
    isDebugLoggingEnabled: () => true,
    openDebugLogFolder: async () => {},
  };
});
