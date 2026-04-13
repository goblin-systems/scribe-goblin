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
          manual_badges: null,
          embedding: null,
          secret_verdict: null,
          secret_type: null,
          secret_source: null,
          is_note: false
        };
        mockEntries.push(entry);
        return id;
      }

      if (command === 'db_list_entries') {
        let results = [...mockEntries];
        if (args.isNote === true) {
          results = results.filter(e => e.is_note === true);
        } else if (args.isNote === false) {
          results = results.filter(e => e.is_note === false);
        }
        if (args.search) {
          const q = args.search.toLowerCase();
          results = results.filter(e => 
            e.content.toLowerCase().includes(q) || 
            (e.label && e.label.toLowerCase().includes(q)) ||
            (e.manual_badges && e.manual_badges.toLowerCase().includes(q))
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

      if (command === 'db_update_entry_secret') {
        const entry = mockEntries.find(e => e.id === args.id);
        if (entry) {
          entry.secret_verdict = args.secretVerdict;
          entry.secret_type = args.secretType;
          entry.secret_source = args.secretSource;
        }
        return;
      }

      if (command === 'db_clear_entry_label') {
        const entry = mockEntries.find(e => e.id === args.id);
        if (entry) {
          entry.label = null;
          entry.label_score = null;
        }
        return;
      }

      if (command === 'db_add_manual_badge') {
        const entry = mockEntries.find(e => e.id === args.id);
        if (entry) {
          const normalized = String(args.badge ?? '').trim().toLowerCase();
          if (!normalized) return;
          const existing: Array<{name: string; color: string}> = entry.manual_badges ? JSON.parse(entry.manual_badges) : [];
          if (!existing.some(b => typeof b === 'string' ? b === normalized : b.name === normalized)) {
            existing.push({ name: normalized, color: args.color || "default" });
            entry.manual_badges = JSON.stringify(existing);
          }
        }
        return;
      }

      if (command === 'db_remove_manual_badge') {
        const entry = mockEntries.find(e => e.id === args.id);
        if (entry) {
          const normalized = String(args.badge ?? '').trim().toLowerCase();
          const existing: Array<{name: string; color: string} | string> = entry.manual_badges ? JSON.parse(entry.manual_badges) : [];
          const updated = existing.filter((b) => (typeof b === 'string' ? b : b.name) !== normalized);
          entry.manual_badges = updated.length > 0 ? JSON.stringify(updated) : null;
        }
        return;
      }

      if (command === 'db_promote_to_note') {
        const entry = mockEntries.find(e => e.id === args.id);
        if (entry) {
          entry.is_note = true;
        }
        return;
      }

      if (command === 'db_demote_from_note') {
        const entry = mockEntries.find(e => e.id === args.id);
        if (entry) {
          entry.is_note = false;
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

vi.mock('@tauri-apps/api/event', () => {
  return {
    listen: async () => () => {},
    emit: async () => {},
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
