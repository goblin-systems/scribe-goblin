# Epic 006 - Provider and settings management

## Goal
Support bring-your-own AI configuration with clear setup, validation, and model management.

## Scope
- Embedding provider configuration.
- Enrichment provider configuration.
- Model discovery, caching, and validation.
- User preferences for processing and privacy-related behavior.

## Status

### Done
- Provider abstraction in place for OpenAI, Gemini, Ollama, and local MiniLM SetFit (settings, key storage, base-URL for Ollama).
- Embedding settings and Enrichment settings live in separate modals.
- Model discovery via "Refresh model list" buttons in both modals.
- Test Connection button with status indicator on the AI Providers modal.
- Ranking settings expose hybrid weights (short / medium / long buckets), semantic relevance threshold, recency max boost, RRF k.
- Per-feature toggles exist for: clipboard monitoring, enrichment, secret masker, debug logging.
- TruffleHog binary path / auto-detect with Test action.

### Open
- Harden model-discovery cache invalidation when credentials or base URL change (currently only manual refresh).
- Better error reporting in the UI for invalid keys, unsupported models, network failures, and quota errors (today errors mostly surface in logs).
- Document recommended defaults for local-first and low-cost setups inside the app (Help / About) rather than only in code.
- Surface which provider is currently in use for embeddings vs enrichment in a single status pane.
- Validate that a model selected in settings is actually capable of the requested task (embedding vs chat) before saving.

## Done when
- Users can configure providers without guesswork.
- Connection testing and model refresh are reliable.
- Settings clearly communicate tradeoffs between privacy, cost, and capability.
