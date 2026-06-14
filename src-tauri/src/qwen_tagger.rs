use crate::debug_log::{write_debug_log_internal, DebugLogState};
use mistralrs::{
    GgufModelBuilder, IsqType, Model, RequestBuilder, Response, StopTokens, TextMessageRole,
    TextModelBuilder,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;

const QWEN_MODEL_DIR: &str = "qwen-25-05b";
const QWEN_MODEL_FILE: &str = "qwen2.5-0.5b-instruct-q4_0.gguf";
const DEFAULT_MAX_TOKENS: usize = 40;
const MAX_ALLOWED_TOKENS: usize = 96;
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(35);

struct LoadedLlm {
    path: PathBuf,
    model: Model,
}

pub struct QwenTaggerState {
    default_model_path: PathBuf,
    inner: AsyncMutex<Option<LoadedLlm>>,
    loaded_path: StdMutex<Option<PathBuf>>,
}

impl QwenTaggerState {
    pub fn new(default_model_path: PathBuf) -> Self {
        Self {
            default_model_path,
            inner: AsyncMutex::new(None),
            loaded_path: StdMutex::new(None),
        }
    }

    pub fn default_model_path(&self) -> PathBuf {
        self.default_model_path.clone()
    }

    /// A non-empty explicit path wins; otherwise fall back to the legacy
    /// bundled location.
    pub fn resolve_model_path(&self, requested: Option<&str>) -> PathBuf {
        match requested {
            Some(path) if !path.trim().is_empty() => PathBuf::from(path),
            _ => self.default_model_path(),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded_path
            .lock()
            .map(|p| p.is_some())
            .unwrap_or(false)
    }

    pub fn loaded_model_path(&self) -> Option<PathBuf> {
        self.loaded_path.lock().ok().and_then(|p| p.clone())
    }

    fn set_loaded_path(&self, path: Option<PathBuf>) {
        if let Ok(mut guard) = self.loaded_path.lock() {
            *guard = path;
        }
    }
}

impl Default for QwenTaggerState {
    fn default() -> Self {
        Self::new(default_model_dir().join(QWEN_MODEL_FILE))
    }
}

fn default_model_dir() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for candidate in [
        cwd.join("resources").join(QWEN_MODEL_DIR),
        cwd.parent()
            .map(|parent| parent.join("resources").join(QWEN_MODEL_DIR))
            .unwrap_or_else(|| cwd.join("..").join("resources").join(QWEN_MODEL_DIR)),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join(QWEN_MODEL_DIR),
    ] {
        if candidate.join(QWEN_MODEL_FILE).exists() {
            return candidate;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("resources")
        .join(QWEN_MODEL_DIR)
}

pub(crate) fn model_id_for_path(path: &Path) -> String {
    if path.is_dir() {
        // HF cache snapshot dirs look like .../models--Org--Name/snapshots/<rev>;
        // recover the human-readable repo name when present.
        for component in path.components().rev() {
            let part = component.as_os_str().to_string_lossy();
            if let Some(repo) = part.strip_prefix("models--") {
                return repo.replace("--", "/");
            }
        }
        return path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
    }
    path.file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

pub(crate) async fn load_model(path: &Path) -> Result<Model, String> {
    let is_gguf = path.is_file()
        && path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false);

    if is_gguf {
        let dir = path
            .parent()
            .ok_or_else(|| format!("Model path has no parent directory: {}", path.display()))?
            .to_string_lossy()
            .to_string();
        let file = path
            .file_name()
            .ok_or_else(|| format!("Model path has no file name: {}", path.display()))?
            .to_string_lossy()
            .to_string();

        GgufModelBuilder::new(dir, vec![file])
            .build()
            .await
            .map_err(|e| format!("Failed to load local GGUF model: {e}"))
    } else if path.is_dir() {
        // Hugging Face-format directory (config.json + safetensors). Quantize
        // in place to Q4K so larger models fit in memory.
        TextModelBuilder::new(path.to_string_lossy().to_string())
            .with_isq(IsqType::Q4K)
            .build()
            .await
            .map_err(|e| format!("Failed to load local safetensors model: {e}"))
    } else {
        Err(format!(
            "Unsupported model path (expected a .gguf file or a Hugging Face model directory): {}",
            path.display()
        ))
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QwenTagResult {
    pub raw_response: String,
    pub model_id: String,
    pub prompt_tps: f32,
    pub completion_tps: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QwenStatus {
    pub loaded: bool,
    pub model_id: String,
    pub model_path: String,
    pub model_exists: bool,
}

pub(crate) fn missing_model_error(path: &Path) -> String {
    format!(
        "Local LLM model file not found at {}. Open Settings → Local AI Models to download one.",
        path.display()
    )
}

#[tauri::command]
pub async fn qwen_generate_tags(
    text: String,
    system_prompt: String,
    max_tokens: Option<usize>,
    model_path: Option<String>,
    app: AppHandle,
    state: State<'_, QwenTaggerState>,
    debug_state: State<'_, DebugLogState>,
) -> Result<QwenTagResult, String> {
    if text.trim().is_empty() {
        return Err("Input text is empty".to_string());
    }
    if system_prompt.trim().is_empty() {
        return Err("System prompt is empty".to_string());
    }

    let path = state.resolve_model_path(model_path.as_deref());
    if !path.exists() {
        let err = missing_model_error(&path);
        write_debug_log_internal(&app, &debug_state, "ERROR", &err);
        return Err(err);
    }
    let model_id = model_id_for_path(&path);

    let max_tokens = max_tokens
        .unwrap_or(DEFAULT_MAX_TOKENS)
        .clamp(1, MAX_ALLOWED_TOKENS);
    write_debug_log_internal(
        &app,
        &debug_state,
        "INFO",
        &format!(
            "qwen_generate_tags requested: text_chars={}, system_prompt_chars={}, max_tokens={}, loaded={}, model_path={}",
            text.len(),
            system_prompt.len(),
            max_tokens,
            state.is_loaded(),
            path.display(),
        ),
    );

    // The model lock both serializes inference and guards (re)loading.
    let mut guard = state.inner.lock().await;
    let load_start = Instant::now();

    let needs_load = guard.as_ref().map(|llm| llm.path != path).unwrap_or(true);
    if needs_load {
        // Drop any previously loaded model first so we never hold two in memory.
        if guard.is_some() {
            write_debug_log_internal(
                &app,
                &debug_state,
                "INFO",
                "qwen_generate_tags unloading previous model before switch",
            );
            *guard = None;
            state.set_loaded_path(None);
        }
        let model = load_model(&path).await.map_err(|err| {
            write_debug_log_internal(
                &app,
                &debug_state,
                "ERROR",
                &format!("qwen_generate_tags load failed: {err}"),
            );
            err
        })?;
        *guard = Some(LoadedLlm {
            path: path.clone(),
            model,
        });
        state.set_loaded_path(Some(path.clone()));
    }
    let model = &guard
        .as_ref()
        .expect("model loaded above")
        .model;
    write_debug_log_internal(
        &app,
        &debug_state,
        "INFO",
        &format!(
            "qwen_generate_tags model ready in {}ms",
            load_start.elapsed().as_millis()
        ),
    );

    let request = RequestBuilder::new()
        .set_deterministic_sampler()
        .set_sampler_stop_toks(StopTokens::Seqs(vec!["<|im_end|>".to_string()]))
        .set_sampler_max_len(max_tokens)
        .add_message(TextMessageRole::System, system_prompt)
        .add_message(TextMessageRole::User, text);

    let inference_start = Instant::now();
    write_debug_log_internal(
        &app,
        &debug_state,
        "INFO",
        "qwen_generate_tags inference start",
    );

    let mut stream = model
        .stream_chat_request(request)
        .await
        .map_err(|e| {
            let err = format!("Qwen stream start failed: {e}");
            write_debug_log_internal(&app, &debug_state, "ERROR", &err);
            err
        })?;

    let mut raw_response = String::new();
    let mut chunks = 0usize;
    let mut prompt_tps = 0.0f32;
    let mut completion_tps = 0.0f32;
    let mut first_chunk_logged = false;

    let stream_result = timeout(INFERENCE_TIMEOUT, async {
        while let Some(response) = stream.next().await {
            match response {
                Response::Chunk(chunk) => {
                    chunks += 1;
                    if let Some(usage) = chunk.usage {
                        prompt_tps = usage.avg_prompt_tok_per_sec;
                        completion_tps = usage.avg_compl_tok_per_sec;
                    }

                    let delta = chunk
                        .choices
                        .first()
                        .and_then(|choice| choice.delta.content.clone())
                        .unwrap_or_default();

                    if !delta.is_empty() {
                        if !first_chunk_logged {
                            first_chunk_logged = true;
                            write_debug_log_internal(
                                &app,
                                &debug_state,
                                "INFO",
                                &format!(
                                    "qwen_generate_tags first token in {}ms",
                                    inference_start.elapsed().as_millis()
                                ),
                            );
                        }
                        raw_response.push_str(&delta);

                        if let Some(json) = extract_complete_json_object(&raw_response) {
                            return Ok(json);
                        }
                    }

                    if let Some(finish_reason) = chunk
                        .choices
                        .first()
                        .and_then(|choice| choice.finish_reason.clone())
                    {
                        if finish_reason != "null" {
                            break;
                        }
                    }
                }
                Response::Done(response) => {
                    prompt_tps = response.usage.avg_prompt_tok_per_sec;
                    completion_tps = response.usage.avg_compl_tok_per_sec;
                    if let Some(content) = response
                        .choices
                        .first()
                        .and_then(|choice| choice.message.content.clone())
                    {
                        raw_response.push_str(&content);
                    }
                    break;
                }
                Response::ModelError(message, _) => {
                    return Err(format!("Qwen model error: {message}"));
                }
                Response::InternalError(err) => {
                    return Err(format!("Qwen internal error: {err}"));
                }
                Response::ValidationError(err) => {
                    return Err(format!("Qwen validation error: {err}"));
                }
                other => {
                    return Err(format!("Unexpected Qwen response type: {}", response_kind(&other)));
                }
            }
        }

        extract_complete_json_object(&raw_response).ok_or_else(|| {
            format!(
                "Qwen stream ended without a complete JSON object; chunks={}, response_chars={}, raw_preview={}",
                chunks,
                raw_response.len(),
                preview_for_log(&raw_response),
            )
        })
    })
    .await;

    let content = match stream_result {
        Ok(Ok(content)) => content,
        Ok(Err(err)) => {
            write_debug_log_internal(&app, &debug_state, "ERROR", &err);
            return Err(err);
        }
        Err(_) => {
            let err = format!(
                "Qwen inference timed out after {}s; chunks={}, response_chars={}, raw_preview={}",
                INFERENCE_TIMEOUT.as_secs(),
                chunks,
                raw_response.len(),
                preview_for_log(&raw_response),
            );
            write_debug_log_internal(&app, &debug_state, "ERROR", &err);
            return Err(err);
        }
    };

    write_debug_log_internal(
        &app,
        &debug_state,
        "INFO",
        &format!(
            "qwen_generate_tags inference completed in {}ms, chunks={}, response_chars={}, prompt_tps={:.2}, completion_tps={:.2}, raw_preview={}",
            inference_start.elapsed().as_millis(),
            chunks,
            content.len(),
            prompt_tps,
            completion_tps,
            preview_for_log(&content),
        ),
    );

    Ok(QwenTagResult {
        raw_response: content,
        model_id,
        prompt_tps,
        completion_tps,
    })
}

fn response_kind(response: &Response) -> &'static str {
    match response {
        Response::InternalError(_) => "InternalError",
        Response::ValidationError(_) => "ValidationError",
        Response::ModelError(_, _) => "ModelError",
        Response::Done(_) => "Done",
        Response::Chunk(_) => "Chunk",
        Response::CompletionModelError(_, _) => "CompletionModelError",
        Response::CompletionDone(_) => "CompletionDone",
        Response::CompletionChunk(_) => "CompletionChunk",
        Response::ImageGeneration(_) => "ImageGeneration",
        Response::Speech { .. } => "Speech",
        Response::Raw { .. } => "Raw",
        Response::Embeddings { .. } => "Embeddings",
    }
}

fn preview_for_log(value: &str) -> String {
    value.chars().take(180).collect::<String>().replace('\n', "\\n")
}

fn extract_complete_json_object(value: &str) -> Option<String> {
    let start = value.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, ch) in value[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let end = start + offset + ch.len_utf8();
                    return Some(value[start..end].to_string());
                }
            }
            _ => {}
        }
    }

    None
}

#[tauri::command]
pub async fn qwen_status(
    model_path: Option<String>,
    state: State<'_, QwenTaggerState>,
) -> Result<QwenStatus, String> {
    let path = state.resolve_model_path(model_path.as_deref());
    let loaded = state
        .loaded_model_path()
        .map(|loaded| loaded == path)
        .unwrap_or(false);
    Ok(QwenStatus {
        loaded,
        model_id: model_id_for_path(&path),
        model_path: path.to_string_lossy().to_string(),
        model_exists: path.exists(),
    })
}

#[tauri::command]
pub async fn qwen_prefetch(
    model_path: Option<String>,
    state: State<'_, QwenTaggerState>,
) -> Result<(), String> {
    let path = state.resolve_model_path(model_path.as_deref());
    if !path.exists() {
        return Err(missing_model_error(&path));
    }
    let mut guard = state.inner.lock().await;
    let needs_load = guard.as_ref().map(|llm| llm.path != path).unwrap_or(true);
    if needs_load {
        if guard.is_some() {
            *guard = None;
            state.set_loaded_path(None);
        }
        let model = load_model(&path).await?;
        *guard = Some(LoadedLlm {
            path: path.clone(),
            model,
        });
        state.set_loaded_path(Some(path));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn fresh_state_reports_not_loaded() {
        let state = QwenTaggerState::default();
        assert!(!state.is_loaded());
    }

    #[test]
    fn default_model_path_uses_bundled_filename() {
        let state = QwenTaggerState::default();
        assert_eq!(
            state
                .default_model_path()
                .file_name()
                .and_then(|name| name.to_str()),
            Some(QWEN_MODEL_FILE),
        );
    }

    #[test]
    fn resolve_model_path_prefers_explicit_path() {
        let state = QwenTaggerState::default();
        assert_eq!(
            state.resolve_model_path(Some("/tmp/custom.gguf")),
            PathBuf::from("/tmp/custom.gguf"),
        );
        assert_eq!(state.resolve_model_path(None), state.default_model_path());
        assert_eq!(
            state.resolve_model_path(Some("   ")),
            state.default_model_path(),
        );
    }

    #[test]
    fn model_id_is_derived_from_filename() {
        assert_eq!(
            model_id_for_path(Path::new("/models/qwen2.5-0.5b-instruct-q4_0.gguf")),
            "qwen2.5-0.5b-instruct-q4_0",
        );
    }

    #[test]
    fn extracts_complete_json_object_from_stream_prefix() {
        assert_eq!(
            extract_complete_json_object("assistant: {\"tags\":[\"rust\",\"tauri\"]} trailing"),
            Some("{\"tags\":[\"rust\",\"tauri\"]}".to_string()),
        );
    }

    #[test]
    fn waits_for_balanced_json_and_ignores_braces_in_strings() {
        assert_eq!(
            extract_complete_json_object("{\"tags\":[\"rust-{tauri}\",\"json\"]"),
            None,
        );
        assert_eq!(
            extract_complete_json_object("{\"tags\":[\"rust-{tauri}\",\"json\"]}"),
            Some("{\"tags\":[\"rust-{tauri}\",\"json\"]}".to_string()),
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires local Qwen GGUF; run explicitly when changing local inference"]
    async fn qwen_local_inference_completes_under_60s() {
        let state = QwenTaggerState::default();
        let model_path = state.default_model_path();
        assert!(
            model_path.exists(),
            "missing Qwen model at {}",
            model_path.display(),
        );

        let started = Instant::now();
        let result = timeout(Duration::from_secs(60), async {
            let load_started = Instant::now();
            let model = load_model(&model_path).await?;
            eprintln!(
                "qwen local test: model loaded in {}ms",
                load_started.elapsed().as_millis()
            );
            let request = RequestBuilder::new()
                .set_deterministic_sampler()
                .set_sampler_stop_toks(StopTokens::Seqs(vec!["<|im_end|>".to_string()]))
                .set_sampler_max_len(32)
                .add_message(
                    TextMessageRole::System,
                    "You are a tagging assistant. Given text, respond with JSON only. Format: {\"tags\":[\"tag1\",\"tag2\"]}. Use 2-4 lowercase content tags.",
                )
                .add_message(
                    TextMessageRole::User,
                    "Rust Tauri clipboard app hangs while streaming local Qwen GGUF inference.",
                );

            let mut stream = model
                .stream_chat_request(request)
                .await
                .map_err(|err| err.to_string())?;
            eprintln!(
                "qwen local test: stream opened in {}ms",
                started.elapsed().as_millis()
            );
            let mut raw = String::new();
            let mut chunks = 0usize;
            while let Some(response) = stream.next().await {
                match response {
                    Response::Chunk(chunk) => {
                        chunks += 1;
                        if let Some(delta) = chunk
                            .choices
                            .first()
                            .and_then(|choice| choice.delta.content.clone())
                        {
                            if chunks == 1 {
                                eprintln!(
                                    "qwen local test: first chunk in {}ms",
                                    started.elapsed().as_millis()
                                );
                            }
                            raw.push_str(&delta);
                            if let Some(json) = extract_complete_json_object(&raw) {
                                eprintln!(
                                    "qwen local test: complete JSON in {}ms over {} chunks",
                                    started.elapsed().as_millis(),
                                    chunks,
                                );
                                return Ok::<String, String>(json);
                            }
                        }
                    }
                    Response::Done(response) => {
                        if let Some(content) = response
                            .choices
                            .first()
                            .and_then(|choice| choice.message.content.clone())
                        {
                            raw.push_str(&content);
                        }
                        break;
                    }
                    Response::InternalError(err) => return Err(err.to_string()),
                    Response::ValidationError(err) => return Err(err.to_string()),
                    Response::ModelError(message, _) => return Err(message),
                    other => return Err(format!("unexpected response: {}", response_kind(&other))),
                }
            }

            extract_complete_json_object(&raw)
                .ok_or_else(|| format!("no complete JSON in response: {raw}"))
        })
        .await
        .expect("local Qwen inference exceeded 60 seconds")
        .expect("local Qwen inference failed");

        let parsed: Value = serde_json::from_str(&result).expect("Qwen returned invalid JSON");
        let tags = parsed
            .get("tags")
            .and_then(|tags| tags.as_array())
            .expect("Qwen JSON did not contain tags array");
        assert!(!tags.is_empty(), "Qwen returned no tags: {result}");
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "local Qwen inference took {:?}",
            started.elapsed(),
        );
    }
}
