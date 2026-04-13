# Scribe Goblin — Product Brief

A local-first second brain that captures everything you copy, say, or type — and makes it permanently searchable through semantic embeddings. No account, no subscription, no vendor cloud. Your knowledge base lives on your machine.

---

## The problem

Knowledge work produces a constant stream of fragments: things you copy, articles you skim, ideas you speak aloud, code snippets you save. Most of it disappears. What survives ends up scattered across browser bookmarks, notes apps, chat history, and documents that are never searched again.

Existing tools fail in one of two ways:
- **Too passive** — clipboard managers just store a list. Nothing is organised, nothing is connected, nothing is findable a week later.
- **Too demanding** — second brain tools (Obsidian, Roam, Notion) require constant manual effort to tag, link, and maintain. Most people abandon them.

Scribe Goblin closes this gap. Capture is automatic. Organisation is handled by AI. Everything is semantically searchable forever.

---

## What it does

### Capture

Scribe Goblin runs in the background and captures:

- **Clipboard** — every copy is recorded automatically. Text, URLs, code snippets, images. No action required from the user.
- **Voice notes** — hold a hotkey, speak, release. Transcribed locally via Whisper and added to the store. Same push-to-talk model as Prompt Goblin.
- **Manual entries** — a quick-entry panel (hotkey-triggered) for typing a thought directly.
- **Imports** — drag in files, paste long-form content, or pipe in transcripts from Recorder Goblin.

Every entry is timestamped, source-tagged (clipboard / voice / manual / import), and stored locally.

### Processing pipeline

When a new entry arrives, it goes through a background pipeline:

1. **Chunking** — long content is split into meaningful chunks (paragraph-aware, not arbitrary character counts)
2. **Embedding** — each chunk is embedded using the user's configured embedding model and stored in the local vector database
3. **AI enrichment** — an LLM generates a short summary, extracts keywords, and suggests tags. This runs asynchronously and does not block capture.
4. **Deduplication** — near-duplicate entries (same URL copied twice, repeated clipboard item) are detected via embedding similarity and collapsed

### Search and retrieval

Two search modes work together:

- **Keyword search** — fast full-text search across all stored content via SQLite FTS
- **Semantic search** — query by meaning, not exact words. "things I read about distributed systems" finds relevant fragments even if those words never appeared. Powered by vector similarity against the local embedding store.

Results can be filtered by date range, source type, tag, or application of origin. Related items surface automatically alongside any search result.

### The knowledge graph

Over time, Scribe builds a graph of connections between entries based on embedding proximity. This is not a manually maintained wiki — it is inferred automatically from the content.

- View clusters of related fragments
- See how a topic has evolved over time
- Surface forgotten context when working on something new ("you saved 12 things related to this 3 months ago")

### Sync (optional)

The local database and vector store can be encrypted and synced to a user-provided S3 bucket via Storage Goblin integration. This enables multi-machine access without any Scribe Goblin server involvement. The encryption key never leaves the user's machine.

---

## Bring Your Own AI — Embeddings

Embeddings are the core intelligence layer. Every piece of content is converted into a high-dimensional vector that captures its meaning. This vector is what enables semantic search and automatic connection-finding.

Scribe Goblin does not bundle an embedding model. The user configures their own provider:

### Supported embedding providers

**OpenAI**
- `text-embedding-3-small` — fast, cheap, strong quality. Recommended default for most users.
- `text-embedding-3-large` — higher dimensional, better for nuanced retrieval. Higher cost.
- Requires an OpenAI API key with billing enabled.

**Google Gemini**
- `text-embedding-004` — Google's current embedding model via the Gemini API.
- Available on the AI Studio free tier — no billing required for moderate use.

**Local (via Ollama)**
- `nomic-embed-text` — strong general-purpose embedding model, runs entirely on-device.
- `mxbai-embed-large` — higher quality, requires more VRAM.
- Zero API cost. Works fully offline. Recommended for users who want no data leaving the machine.

### How embeddings are stored

Embeddings are stored in a local vector database alongside the SQLite content store. Candidate: [sqlite-vec](https://github.com/asg017/sqlite-vec) — keeps everything in a single SQLite file with no additional infrastructure. Alternative: [LanceDB](https://lancedb.github.io/lancedb/) for larger knowledge bases that benefit from more sophisticated indexing.

On first run, existing content is batch-embedded. Incremental updates are embedded in the background as new content arrives.

### LLM provider (for summarisation and tagging)

Separate from embeddings, an LLM is used for summarisation, tag generation, and action item extraction. This follows the same BYOAI pattern as other Goblin tools — any OpenAI-compatible endpoint, any model. A small fast model (`gpt-4o-mini`, `gemini-2.0-flash`) is sufficient for this task. Runs asynchronously; the app is fully usable while enrichment processes in the background.

---

## Local data storage

All data lives in the user's app data directory:

```
~/.scribe-goblin/
  db.sqlite          # full-text content, metadata, tags, summaries
  vectors.db         # embedding vectors (sqlite-vec) or vectors/ (LanceDB)
  config.json        # provider settings, hotkeys, preferences
  attachments/       # binary captures (images, files)
```

No data is written anywhere else unless the user explicitly enables S3 sync.

---

## Application architecture

Desktop app built with Tauri (Rust backend, React frontend) — consistent with the rest of the Goblin ecosystem.

**Backend (Rust/Tauri):**
- Clipboard monitor (OS-level hook, runs as a background process)
- Hotkey listener for voice capture and quick entry
- Whisper integration for voice transcription (local binary or remote API)
- Embedding pipeline — batching, retries, provider abstraction
- LLM client for enrichment
- SQLite + vector store management
- S3 sync client (shared with Storage Goblin)

**Frontend (React):**
- Always-available quick entry panel (hotkey-triggered, floats above other windows)
- Main app: search, browse, timeline, graph view
- Settings: provider configuration, hotkeys, sync

---

## Key user flows

**Passive capture (zero effort)**
User copies something → it appears in Scribe in the background → embedding generated → searchable immediately.

**Voice note**
User hits hotkey → speaks → releases → transcript appears as a new entry → embedded and tagged.

**Retrieval**
User opens Scribe, types a concept or question in natural language → semantic search returns relevant fragments from weeks or months ago, ranked by relevance.

**Context surfacing**
User is working on a document or project → Scribe suggests related entries from the knowledge base based on what's currently in the clipboard or active window title.

---

## What it is not

- Not a full document editor — entries are fragments, not pages. Long-form writing belongs in a dedicated tool.
- Not a browser extension — captures from the OS clipboard, not from page content directly.
- Not a RAG system for querying documents — that is a separate use case and a separate tool.
- Not a synced cloud service — sync is optional, user-owned, and end-to-end encrypted.
