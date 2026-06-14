//! Local LLM-backed search autocomplete.
//!
//! Generates a short continuation of a partial search query using a local
//! mistral.rs model. It keeps its own model slot (separate from the tagging
//! LLM in `qwen_tagger`) so switching the autocomplete model never thrashes the
//! enrichment model, at the cost of a second model resident in memory when the
//! two differ. Cloud completion (OpenAI/Gemini) is handled on the frontend via
//! the HTTP proxy; this module only serves the offline path.

use crate::debug_log::{write_debug_log_internal, DebugLogState};
use crate::qwen_tagger::{load_model, missing_model_error};
use mistralrs::{Model, RequestBuilder, Response, StopTokens, TextMessageRole};
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;

/// Completions are short by construction — finish the current word plus a few.
const MAX_TOKENS: usize = 16;
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(20);
/// Don't bother the model with near-empty prefixes.
const MIN_PREFIX_CHARS: usize = 2;
/// Cap the suffix we hand back to the ghost overlay.
const MAX_SUFFIX_CHARS: usize = 80;

const SYSTEM_PROMPT: &str = "You are a search autocomplete engine. The user sends a partial search query. \
Reply with ONLY the single most likely completed query as plain text and nothing else: no quotes, no explanation, no list, no markdown. \
Your reply MUST begin with the user's exact input text and then continue it. \
Finish the current word and add at most a few more words.";

struct LoadedLlm {
    path: PathBuf,
    model: Model,
}

/// Reloadable autocomplete model state, mirroring `QwenTaggerState` but with its
/// own slot so the two engines don't evict each other.
pub struct AutocompleteState {
    default_model_path: PathBuf,
    inner: AsyncMutex<Option<LoadedLlm>>,
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

    /// Load `path` into the slot if a different model (or nothing) is loaded.
    async fn ensure_loaded<'a>(
        &'a self,
        path: &Path,
    ) -> Result<tokio::sync::MutexGuard<'a, Option<LoadedLlm>>, String> {
        let mut guard = self.inner.lock().await;
        let needs_load = guard.as_ref().map(|llm| llm.path != path).unwrap_or(true);
        if needs_load {
            if guard.is_some() {
                *guard = None;
                self.set_loaded_path(None);
            }
            let model = load_model(path).await?;
            *guard = Some(LoadedLlm {
                path: path.to_path_buf(),
                model,
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
    // Models sometimes wrap the answer in quotes or a code fence; strip those.
    let cleaned = completion
        .trim()
        .trim_matches(|c| c == '"' || c == '`' || c == '\'')
        .trim_start();
    // Only the first line is a query continuation.
    let cleaned = cleaned.lines().next().unwrap_or("");

    let mut idx = 0usize; // byte offset into `cleaned`
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
    model_path: Option<String>,
    app: AppHandle,
    state: State<'_, AutocompleteState>,
    debug_state: State<'_, DebugLogState>,
) -> Result<String, String> {
    if prefix.trim().chars().count() < MIN_PREFIX_CHARS {
        return Ok(String::new());
    }

    let path = state.resolve_model_path(model_path.as_deref());
    if !path.exists() {
        return Err(missing_model_error(&path));
    }

    let guard = state.ensure_loaded(&path).await.map_err(|err| {
        write_debug_log_internal(
            &app,
            &debug_state,
            "ERROR",
            &format!("autocomplete_complete load failed: {err}"),
        );
        err
    })?;
    let model = &guard.as_ref().expect("model loaded above").model;

    let request = RequestBuilder::new()
        .set_deterministic_sampler()
        .set_sampler_stop_toks(StopTokens::Seqs(vec!["<|im_end|>".to_string()]))
        .set_sampler_max_len(MAX_TOKENS)
        .add_message(TextMessageRole::System, SYSTEM_PROMPT)
        .add_message(TextMessageRole::User, prefix.clone());

    let started = Instant::now();
    let mut stream = model
        .stream_chat_request(request)
        .await
        .map_err(|e| format!("Autocomplete stream start failed: {e}"))?;

    let mut raw = String::new();
    let stream_result = timeout(INFERENCE_TIMEOUT, async {
        while let Some(response) = stream.next().await {
            match response {
                Response::Chunk(chunk) => {
                    if let Some(delta) = chunk
                        .choices
                        .first()
                        .and_then(|choice| choice.delta.content.clone())
                    {
                        raw.push_str(&delta);
                    }
                    if chunk
                        .choices
                        .first()
                        .and_then(|choice| choice.finish_reason.clone())
                        .map(|reason| reason != "null")
                        .unwrap_or(false)
                    {
                        break;
                    }
                }
                Response::Done(done) => {
                    if let Some(content) = done
                        .choices
                        .first()
                        .and_then(|choice| choice.message.content.clone())
                    {
                        raw.push_str(&content);
                    }
                    break;
                }
                Response::ModelError(message, _) => return Err(format!("model error: {message}")),
                Response::InternalError(err) => return Err(format!("internal error: {err}")),
                Response::ValidationError(err) => return Err(format!("validation error: {err}")),
                _ => {}
            }
        }
        Ok(())
    })
    .await;

    // Free the model lock before logging/parsing.
    drop(guard);

    match stream_result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let err = format!("Autocomplete inference failed: {err}");
            write_debug_log_internal(&app, &debug_state, "ERROR", &err);
            return Err(err);
        }
        Err(_) => {
            // A timeout is best-effort here: return whatever we collected.
            write_debug_log_internal(
                &app,
                &debug_state,
                "WARN",
                &format!(
                    "autocomplete_complete timed out after {}s",
                    INFERENCE_TIMEOUT.as_secs()
                ),
            );
        }
    }

    let suffix = completion_suffix(&prefix, &raw);
    write_debug_log_internal(
        &app,
        &debug_state,
        "INFO",
        &format!(
            "autocomplete_complete: prefix_chars={}, suffix_chars={}, took_ms={}",
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
    state: State<'_, AutocompleteState>,
) -> Result<(), String> {
    let path = state.resolve_model_path(model_path.as_deref());
    if !path.exists() {
        return Err(missing_model_error(&path));
    }
    let _guard = state.ensure_loaded(&path).await?;
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
    fn resolve_prefers_explicit_path() {
        let state = AutocompleteState::new(PathBuf::from("/default.gguf"));
        assert_eq!(
            state.resolve_model_path(Some("/custom.gguf")),
            PathBuf::from("/custom.gguf"),
        );
        assert_eq!(
            state.resolve_model_path(None),
            PathBuf::from("/default.gguf"),
        );
        assert_eq!(
            state.resolve_model_path(Some("  ")),
            PathBuf::from("/default.gguf"),
        );
    }
}
