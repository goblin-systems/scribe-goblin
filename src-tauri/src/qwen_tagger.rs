use crate::debug_log::{write_debug_log_internal, DebugLogState};
use mistralrs::{GgufModelBuilder, Model, RequestBuilder, Response, StopTokens, TextMessageRole};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::sync::{Mutex as AsyncMutex, OnceCell};
use tokio::time::timeout;

const QWEN_MODEL_DIR: &str = "qwen-25-05b";
const QWEN_MODEL_FILE: &str = "qwen2.5-0.5b-instruct-q4_0.gguf";
const QWEN_CHAT_TEMPLATE_FILE: &str = "chat_template.jinja";
const QWEN_MODEL_ID: &str = "Qwen2.5-0.5B-Instruct GGUF q4_0";
const DEFAULT_MAX_TOKENS: usize = 40;
const MAX_ALLOWED_TOKENS: usize = 96;
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(35);

pub struct QwenTaggerState {
    model: OnceCell<Model>,
    model_dir: PathBuf,
    inference_lock: AsyncMutex<()>,
}

impl QwenTaggerState {
    pub fn new(model_dir: PathBuf) -> Self {
        Self {
            model: OnceCell::new(),
            model_dir,
            inference_lock: AsyncMutex::new(()),
        }
    }

    async fn ensure_loaded(&self) -> Result<&Model, String> {
        if !self.model_path().exists() {
            return Err(format!(
                "Qwen model file not found at {}",
                self.model_path().display()
            ));
        }

        let model_dir = self.model_dir.to_string_lossy().to_string();
        self.model
            .get_or_try_init(|| async {
                GgufModelBuilder::new(model_dir, vec![QWEN_MODEL_FILE])
                    .with_force_cpu()
                    .build()
                    .await
                    .map_err(|e| format!("Failed to load Qwen model: {e}"))
            })
            .await
    }

    pub fn is_loaded(&self) -> bool {
        self.model.initialized()
    }

    pub fn model_path(&self) -> PathBuf {
        self.model_dir.join(QWEN_MODEL_FILE)
    }

    pub fn chat_template_path(&self) -> PathBuf {
        self.model_dir.join(QWEN_CHAT_TEMPLATE_FILE)
    }
}

impl Default for QwenTaggerState {
    fn default() -> Self {
        Self::new(default_model_dir())
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
    pub chat_template_path: String,
    pub chat_template_exists: bool,
}

#[tauri::command]
pub async fn qwen_generate_tags(
    text: String,
    system_prompt: String,
    max_tokens: Option<usize>,
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

    let max_tokens = max_tokens
        .unwrap_or(DEFAULT_MAX_TOKENS)
        .clamp(1, MAX_ALLOWED_TOKENS);
    write_debug_log_internal(
        &app,
        &debug_state,
        "INFO",
        &format!(
            "qwen_generate_tags requested: text_chars={}, system_prompt_chars={}, max_tokens={}, loaded={}, model_path={}, model_exists={}, chat_template_path={}, chat_template_exists={}",
            text.len(),
            system_prompt.len(),
            max_tokens,
            state.is_loaded(),
            state.model_path().display(),
            state.model_path().exists(),
            state.chat_template_path().display(),
            state.chat_template_path().exists(),
        ),
    );

    let _guard = state.inference_lock.lock().await;
    let load_start = Instant::now();
    write_debug_log_internal(
        &app,
        &debug_state,
        "INFO",
        "qwen_generate_tags acquired local inference lock",
    );

    let model = state.ensure_loaded().await.map_err(|err| {
        write_debug_log_internal(
            &app,
            &debug_state,
            "ERROR",
            &format!("qwen_generate_tags load failed: {err}"),
        );
        err
    })?;
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
        model_id: QWEN_MODEL_ID.to_string(),
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
pub async fn qwen_status(state: State<'_, QwenTaggerState>) -> Result<QwenStatus, String> {
    Ok(QwenStatus {
        loaded: state.is_loaded(),
        model_id: QWEN_MODEL_ID.to_string(),
        model_path: state.model_path().to_string_lossy().to_string(),
        model_exists: state.model_path().exists(),
        chat_template_path: state.chat_template_path().to_string_lossy().to_string(),
        chat_template_exists: state.chat_template_path().exists(),
    })
}

#[tauri::command]
pub async fn qwen_prefetch(state: State<'_, QwenTaggerState>) -> Result<(), String> {
    state.ensure_loaded().await.map(|_| ())
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
    fn model_id_is_stable() {
        assert!(QWEN_MODEL_ID.contains("Qwen2.5-0.5B-Instruct"));
        assert!(QWEN_MODEL_ID.contains("q4_0"));
    }

    #[test]
    fn default_model_path_uses_bundled_filename() {
        let state = QwenTaggerState::default();
        assert_eq!(
            state.model_path().file_name().and_then(|name| name.to_str()),
            Some(QWEN_MODEL_FILE),
        );
    }

    #[test]
    fn default_chat_template_path_uses_bundled_filename() {
        let state = QwenTaggerState::default();
        assert_eq!(
            state
                .chat_template_path()
                .file_name()
                .and_then(|name| name.to_str()),
            Some(QWEN_CHAT_TEMPLATE_FILE),
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
        assert!(
            state.model_path().exists(),
            "missing Qwen model at {}",
            state.model_path().display(),
        );
        assert!(
            state.chat_template_path().exists(),
            "missing Qwen chat template at {}",
            state.chat_template_path().display(),
        );

        let started = Instant::now();
        let result = timeout(Duration::from_secs(60), async {
            let load_started = Instant::now();
            let model = state.ensure_loaded().await?;
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

    #[derive(Debug)]
    struct QwenTiming {
        stream_open_ms: u128,
        first_chunk_ms: Option<u128>,
        finished_ms: u128,
        complete_json: bool,
        chunks: usize,
        chars: usize,
        response: String,
    }

    async fn time_qwen_request(
        model: &Model,
        label: &str,
        text: &str,
        max_tokens: usize,
    ) -> Result<QwenTiming, String> {
        let started = Instant::now();
        let request = RequestBuilder::new()
            .set_deterministic_sampler()
            .set_sampler_stop_toks(StopTokens::Seqs(vec!["<|im_end|>".to_string()]))
            .set_sampler_max_len(max_tokens)
            .add_message(
                TextMessageRole::System,
                "You are a tagging assistant. Given text, respond with JSON only. Format: {\"tags\":[\"tag1\",\"tag2\"]}. Use 2-4 lowercase content tags.",
            )
            .add_message(TextMessageRole::User, text);

        let mut stream = model
            .stream_chat_request(request)
            .await
            .map_err(|err| err.to_string())?;
        let stream_open_ms = started.elapsed().as_millis();
        eprintln!("{label}: stream opened in {stream_open_ms}ms");

        let mut raw = String::new();
        let mut chunks = 0usize;
        let mut first_chunk_ms = None;

        while let Some(response) = stream.next().await {
            match response {
                Response::Chunk(chunk) => {
                    chunks += 1;
                    if let Some(delta) = chunk
                        .choices
                        .first()
                        .and_then(|choice| choice.delta.content.clone())
                    {
                        if first_chunk_ms.is_none() {
                            first_chunk_ms = Some(started.elapsed().as_millis());
                            eprintln!(
                                "{label}: first chunk in {}ms",
                                first_chunk_ms.unwrap()
                            );
                        }
                        raw.push_str(&delta);
                        if let Some(json) = extract_complete_json_object(&raw) {
                            let complete_json_ms = started.elapsed().as_millis();
                            eprintln!(
                                "{label}: complete JSON in {complete_json_ms}ms over {chunks} chunks, chars={}, json={json}",
                                raw.len(),
                            );
                            return Ok(QwenTiming {
                                stream_open_ms,
                                first_chunk_ms,
                                finished_ms: complete_json_ms,
                                complete_json: true,
                                chunks,
                                chars: raw.len(),
                                response: json,
                            });
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

        if let Some(json) = extract_complete_json_object(&raw) {
            Ok(QwenTiming {
                stream_open_ms,
                first_chunk_ms,
                finished_ms: started.elapsed().as_millis(),
                complete_json: true,
                chunks,
                chars: raw.len(),
                response: json,
            })
        } else {
            let finished_ms = started.elapsed().as_millis();
            eprintln!(
                "{label}: stream ended without complete JSON in {finished_ms}ms over {chunks} chunks, chars={}, raw={raw}",
                raw.len(),
            );
            Ok(QwenTiming {
                stream_open_ms,
                first_chunk_ms,
                finished_ms,
                complete_json: false,
                chunks,
                chars: raw.len(),
                response: raw,
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "manual local Qwen timing experiment"]
    async fn qwen_local_inference_timing_experiment() {
        let state = QwenTaggerState::default();
        assert!(
            state.model_path().exists(),
            "missing Qwen model at {}",
            state.model_path().display(),
        );

        let load_started = Instant::now();
        let model = state.ensure_loaded().await.expect("Qwen model failed to load");
        eprintln!(
            "timing: model loaded in {}ms",
            load_started.elapsed().as_millis()
        );

        let short_text =
            "Rust Tauri clipboard app hangs while streaming local Qwen GGUF inference.";
        let realistic_text = r#"2026-04-27T22:57:30 [INFO] clipboard-capture event received
2026-04-27T22:57:30 [INFO] clipboard-capture processed successfully
2026-04-27T22:57:30 [INFO] enrichEntry: provider=local-qwen, model=qwen2.5-0.5b-instruct
2026-04-27T22:57:34 [INFO] qwen_generate_tags requested: text_chars=1209, system_prompt_chars=537, max_tokens=32, loaded=false
2026-04-27T22:57:53 [INFO] qwen_generate_tags inference start
2026-04-27T22:58:32 [WARN] enrichWithLocalQwen: still waiting after 60s
The application is migrating from MNLI classification to open-ended local language-model tagging. Heuristic tags are split into a separate process and local Qwen is expected to generate JSON tags."#;

        let runs = [
            ("short-run-1", short_text),
            ("short-run-2", short_text),
            ("realistic-run-1", realistic_text),
            ("realistic-run-2", realistic_text),
        ];

        for (label, text) in runs {
            let timing = timeout(
                Duration::from_secs(240),
                time_qwen_request(model, label, text, 32),
            )
            .await
            .unwrap_or_else(|_| Err(format!("{label}: exceeded 240s")))
            .expect("Qwen timing request failed");

            if timing.complete_json {
                let parsed: Value =
                    serde_json::from_str(&timing.response).expect("Qwen returned invalid JSON");
                assert!(
                    parsed.get("tags").and_then(|tags| tags.as_array()).is_some(),
                    "{label}: Qwen JSON did not contain tags array: {}",
                    timing.response
                );
            }
            eprintln!("{label}: summary {timing:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "manual local Qwen realistic timing experiment"]
    async fn qwen_local_realistic_timing_experiment() {
        let state = QwenTaggerState::default();
        let load_started = Instant::now();
        let model = state.ensure_loaded().await.expect("Qwen model failed to load");
        eprintln!(
            "realistic timing: model loaded in {}ms",
            load_started.elapsed().as_millis()
        );

        let realistic_text = r#"2026-04-27T22:57:30 [INFO] clipboard-capture event received
2026-04-27T22:57:30 [INFO] clipboard-capture processed successfully
2026-04-27T22:57:30 [INFO] enrichEntry: provider=local-qwen, model=qwen2.5-0.5b-instruct
2026-04-27T22:57:34 [INFO] qwen_generate_tags requested: text_chars=1209, system_prompt_chars=537, max_tokens=32, loaded=false
2026-04-27T22:57:53 [INFO] qwen_generate_tags inference start
2026-04-27T22:58:32 [WARN] enrichWithLocalQwen: still waiting after 60s
The application is migrating from MNLI classification to open-ended local language-model tagging. Heuristic tags are split into a separate process and local Qwen is expected to generate JSON tags."#;

        for label in ["realistic-repeat-1", "realistic-repeat-2"] {
            let timing = timeout(
                Duration::from_secs(300),
                time_qwen_request(model, label, realistic_text, 32),
            )
            .await
            .unwrap_or_else(|_| Err(format!("{label}: exceeded 300s")))
            .expect("Qwen timing request failed");
            eprintln!("{label}: summary {timing:?}");
        }
    }
}
