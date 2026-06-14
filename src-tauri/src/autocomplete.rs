//! Local-LLM-backed search autocomplete.
//!
//! Generates a short continuation of a partial search query. The actual
//! generation runs through `inference`, so it works with either engine
//! (mistral.rs or llama.cpp) and any GPU offload the user selected. This engine
//! keeps its own model slot (separate from the tagging LLM in `qwen_tagger`) so
//! switching the autocomplete model never thrashes the enrichment model. Cloud
//! completion (OpenAI/Gemini) is handled on the frontend via the HTTP proxy;
//! this module only serves the offline path.

use crate::debug_log::{write_debug_log_internal, DebugLogState};
use crate::inference::{self, EngineKind, GenRequest, LoadedEngine};
use crate::qwen_tagger::missing_model_error;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::Instant;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

/// Completions are short by construction — finish the current word plus a few.
const MAX_TOKENS: usize = 16;
/// Don't bother the model with near-empty prefixes.
const MIN_PREFIX_CHARS: usize = 2;
/// Cap the suffix we hand back to the ghost overlay.
const MAX_SUFFIX_CHARS: usize = 80;

const SYSTEM_PROMPT: &str = "You are a search autocomplete engine. The user sends a partial search query. \
Reply with ONLY the single most likely completed query as plain text and nothing else: no quotes, no explanation, no list, no markdown. \
Your reply MUST begin with the user's exact input text and then continue it. \
Finish the current word and add at most a few more words.";

/// Grounding preamble appended to the system prompt when matching records exist.
const CONTEXT_PREAMBLE: &str = "\n\nThese are the user's matching saved entries — use them as grounding so the \
completion reflects their actual history. Prefer continuations consistent with them, but you may extend beyond them when sensible:\n";

/// Cap the grounding context so the prompt stays small/fast.
const MAX_CONTEXT_CHARS: usize = 1200;

fn system_prompt_with_context(context: Option<&str>) -> String {
    match context.map(str::trim).filter(|c| !c.is_empty()) {
        Some(ctx) => {
            let ctx: String = ctx.chars().take(MAX_CONTEXT_CHARS).collect();
            format!("{SYSTEM_PROMPT}{CONTEXT_PREAMBLE}{ctx}")
        }
        None => SYSTEM_PROMPT.to_string(),
    }
}

/// A loaded engine, keyed on everything that would require a reload.
struct LoadedSlot {
    path: PathBuf,
    kind: EngineKind,
    gpu_layers: u32,
    engine: LoadedEngine,
}

/// Reloadable autocomplete model state with its own slot so it doesn't evict
/// the enrichment model.
pub struct AutocompleteState {
    default_model_path: PathBuf,
    inner: AsyncMutex<Option<LoadedSlot>>,
    loaded_path: StdMutex<Option<PathBuf>>,
}

impl AutocompleteState {
    pub fn new(default_model_path: PathBuf) -> Self {
        Self {
            default_model_path,
            inner: AsyncMutex::new(None),
            loaded_path: StdMutex::new(None),
        }
    }

    /// A non-empty explicit path wins; otherwise fall back to the default LLM.
    pub fn resolve_model_path(&self, requested: Option<&str>) -> PathBuf {
        match requested {
            Some(path) if !path.trim().is_empty() => PathBuf::from(path),
            _ => self.default_model_path.clone(),
        }
    }

    fn set_loaded_path(&self, path: Option<PathBuf>) {
        if let Ok(mut guard) = self.loaded_path.lock() {
            *guard = path;
        }
    }

    /// Load the model into the slot if the path, engine, or GPU offload changed.
    async fn ensure_loaded<'a>(
        &'a self,
        path: &Path,
        kind: EngineKind,
        gpu_layers: u32,
    ) -> Result<tokio::sync::MutexGuard<'a, Option<LoadedSlot>>, String> {
        let mut guard = self.inner.lock().await;
        let needs_load = guard
            .as_ref()
            .map(|slot| slot.path != path || slot.kind != kind || slot.gpu_layers != gpu_layers)
            .unwrap_or(true);
        if needs_load {
            if guard.is_some() {
                *guard = None;
                self.set_loaded_path(None);
            }
            let engine = inference::load_engine(path, kind, gpu_layers).await?;
            *guard = Some(LoadedSlot {
                path: path.to_path_buf(),
                kind,
                gpu_layers,
                engine,
            });
            self.set_loaded_path(Some(path.to_path_buf()));
        }
        Ok(guard)
    }
}

/// Compute the part of `completion` that extends `prefix`, matching the prefix
/// case-insensitively. Returns an empty string when the model didn't echo the
/// prefix (so the caller shows no ghost rather than garbage).
fn completion_suffix(prefix: &str, completion: &str) -> String {
    let cleaned = completion
        .trim()
        .trim_matches(|c| c == '"' || c == '`' || c == '\'')
        .trim_start();
    let cleaned = cleaned.lines().next().unwrap_or("");

    let mut idx = 0usize;
    for pc in prefix.chars() {
        let rest = &cleaned[idx..];
        let Some(rc) = rest.chars().next() else {
            return String::new();
        };
        if !chars_eq_ci(pc, rc) {
            return String::new();
        }
        idx += rc.len_utf8();
    }

    cleaned[idx..].chars().take(MAX_SUFFIX_CHARS).collect()
}

fn chars_eq_ci(a: char, b: char) -> bool {
    a == b || a.eq_ignore_ascii_case(&b) || a.to_lowercase().eq(b.to_lowercase())
}

#[tauri::command]
pub async fn autocomplete_complete(
    prefix: String,
    context: Option<String>,
    model_path: Option<String>,
    engine: Option<String>,
    gpu_layers: Option<u32>,
    app: AppHandle,
    state: State<'_, AutocompleteState>,
    debug_state: State<'_, DebugLogState>,
) -> Result<String, String> {
    if prefix.trim().chars().count() < MIN_PREFIX_CHARS {
        return Ok(String::new());
    }

    let kind = EngineKind::parse(engine.as_deref());
    let gpu_layers = gpu_layers.unwrap_or(0);
    let path = state.resolve_model_path(model_path.as_deref());
    if !path.exists() {
        return Err(missing_model_error(&path));
    }

    let started = Instant::now();
    let guard = state.ensure_loaded(&path, kind, gpu_layers).await.map_err(|err| {
        write_debug_log_internal(
            &app,
            &debug_state,
            "ERROR",
            &format!("autocomplete_complete load failed: {err}"),
        );
        err
    })?;
    let slot = guard.as_ref().expect("engine loaded above");

    let output = inference::generate(
        &slot.engine,
        GenRequest {
            system: system_prompt_with_context(context.as_deref()),
            user: prefix.clone(),
            max_tokens: MAX_TOKENS,
            stop: vec!["<|im_end|>".to_string()],
        },
    )
    .await;
    drop(guard);

    let raw = match output {
        Ok(out) => out.text,
        Err(err) => {
            write_debug_log_internal(
                &app,
                &debug_state,
                "WARN",
                &format!("autocomplete_complete generation failed: {err}"),
            );
            return Err(err);
        }
    };

    let suffix = completion_suffix(&prefix, &raw);
    write_debug_log_internal(
        &app,
        &debug_state,
        "INFO",
        &format!(
            "autocomplete_complete: engine={}, prefix_chars={}, suffix_chars={}, took_ms={}",
            kind.as_str(),
            prefix.chars().count(),
            suffix.chars().count(),
            started.elapsed().as_millis(),
        ),
    );
    Ok(suffix)
}

/// Warm the autocomplete model so the first keystroke isn't slow.
#[tauri::command]
pub async fn autocomplete_prefetch(
    model_path: Option<String>,
    engine: Option<String>,
    gpu_layers: Option<u32>,
    state: State<'_, AutocompleteState>,
) -> Result<(), String> {
    let kind = EngineKind::parse(engine.as_deref());
    let gpu_layers = gpu_layers.unwrap_or(0);
    let path = state.resolve_model_path(model_path.as_deref());
    if !path.exists() {
        return Err(missing_model_error(&path));
    }
    let _guard = state.ensure_loaded(&path, kind, gpu_layers).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_returns_continuation_when_prefix_echoed() {
        assert_eq!(completion_suffix("good mor", "good morning"), "ning");
    }

    #[test]
    fn suffix_is_case_insensitive_on_prefix() {
        assert_eq!(completion_suffix("Good Mor", "good morning"), "ning");
    }

    #[test]
    fn suffix_strips_wrapping_quotes() {
        assert_eq!(completion_suffix("hel", "\"hello world\""), "lo world");
    }

    #[test]
    fn suffix_empty_when_completion_diverges() {
        assert_eq!(completion_suffix("good mor", "afternoon nap"), "");
    }

    #[test]
    fn suffix_takes_first_line_only() {
        assert_eq!(completion_suffix("ab", "abc\ndef"), "c");
    }

    #[test]
    fn system_prompt_appends_context_when_present() {
        assert_eq!(system_prompt_with_context(None), SYSTEM_PROMPT);
        assert_eq!(system_prompt_with_context(Some("   ")), SYSTEM_PROMPT);
        let p = system_prompt_with_context(Some("rust tauri notes"));
        assert!(p.starts_with(SYSTEM_PROMPT));
        assert!(p.contains("rust tauri notes"));
    }

    #[test]
    fn resolve_prefers_explicit_path() {
        let state = AutocompleteState::new(PathBuf::from("/default.gguf"));
        assert_eq!(
            state.resolve_model_path(Some("/custom.gguf")),
            PathBuf::from("/custom.gguf"),
        );
        assert_eq!(state.resolve_model_path(None), PathBuf::from("/default.gguf"));
        assert_eq!(
            state.resolve_model_path(Some("  ")),
            PathBuf::from("/default.gguf"),
        );
    }
}
