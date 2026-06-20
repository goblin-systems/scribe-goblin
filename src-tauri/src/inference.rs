//! Pluggable local-LLM engine layer.
//!
//! The enrichment tagger and the search autocomplete both need to turn a
//! (system, user) prompt into a short text completion. This module hides which
//! engine does that work so the choice lives in one place:
//!
//! - **mistral.rs** (candle) — the default; GPU only on NVIDIA (CUDA) / Apple
//!   (Metal). Always compiled in.
//! - **llama.cpp** (`llamacpp` feature) — opt-in; cross-vendor GPU via Vulkan,
//!   plus CUDA/ROCm. GPU offload is a runtime `gpu_layers` count.
//!
//! Which GPU *vendor* is fixed at build time (a llama.cpp backend is a compile
//! feature); the engine and the offload layer count are runtime choices.

use mistralrs::{Model, RequestBuilder, Response, StopTokens, TextMessageRole};
use serde::Serialize;
use std::path::Path;
use std::time::Instant;
use tauri::State;

use crate::qwen_tagger::QwenTaggerState;

/// Which engine runs local LLM generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    MistralRs,
    LlamaCpp,
}

impl EngineKind {
    /// Parse the engine selector sent from the frontend. Falls back to
    /// mistral.rs for unknown values or when the binary wasn't built with
    /// llama.cpp, so a stale setting can never wedge generation.
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("llamacpp") if cfg!(feature = "llamacpp") => EngineKind::LlamaCpp,
            _ => EngineKind::MistralRs,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            EngineKind::MistralRs => "mistralrs",
            EngineKind::LlamaCpp => "llamacpp",
        }
    }
}

/// A single generation request, engine-agnostic.
pub struct GenRequest {
    pub system: String,
    pub user: String,
    pub max_tokens: usize,
    /// Stop sequences (e.g. the Qwen `<|im_end|>` turn terminator).
    pub stop: Vec<String>,
}

/// Generation output plus throughput for diagnostics.
pub struct GenOutput {
    pub text: String,
    /// Prompt-processing throughput; only surfaced on the llama.cpp path, so it
    /// can be unread in a default (mistral.rs-only) build.
    #[allow(dead_code)]
    pub prompt_tps: f32,
    pub completion_tps: f32,
}

/// A loaded engine instance. The llama.cpp variant only exists when the feature
/// is compiled in; the match arms below stay exhaustive in both configs.
pub enum LoadedEngine {
    MistralRs(Model),
    #[cfg(feature = "llamacpp")]
    LlamaCpp(crate::llamacpp::LlamaEngine),
}

/// Load `path` with the requested engine. `gpu_layers` is only meaningful for
/// llama.cpp (0 = CPU; higher offloads more transformer layers to the GPU).
pub async fn load_engine(
    path: &Path,
    kind: EngineKind,
    gpu_layers: u32,
) -> Result<LoadedEngine, String> {
    match kind {
        EngineKind::MistralRs => Ok(LoadedEngine::MistralRs(
            crate::qwen_tagger::load_model(path).await?,
        )),
        #[cfg(feature = "llamacpp")]
        EngineKind::LlamaCpp => Ok(LoadedEngine::LlamaCpp(crate::llamacpp::LlamaEngine::load(
            path, gpu_layers,
        )?)),
        #[cfg(not(feature = "llamacpp"))]
        EngineKind::LlamaCpp => {
            let _ = gpu_layers;
            Err(
                "llama.cpp engine is not included in this build. Download the GPU \
                 build (llama.cpp + Vulkan) or rebuild with --features llamacpp-vulkan."
                    .to_string(),
            )
        }
    }
}

/// Run a single generation on a loaded engine.
pub async fn generate(engine: &LoadedEngine, req: GenRequest) -> Result<GenOutput, String> {
    match engine {
        LoadedEngine::MistralRs(model) => mistralrs_generate(model, &req).await,
        #[cfg(feature = "llamacpp")]
        LoadedEngine::LlamaCpp(eng) => {
            // llama.cpp decoding is blocking; keep it off the async workers.
            tokio::task::block_in_place(|| eng.generate(&req))
        }
    }
}

/// mistral.rs streaming generation, collected into a full response.
async fn mistralrs_generate(model: &Model, req: &GenRequest) -> Result<GenOutput, String> {
    let mut builder = RequestBuilder::new()
        .set_deterministic_sampler()
        .set_sampler_max_len(req.max_tokens);
    if !req.stop.is_empty() {
        builder = builder.set_sampler_stop_toks(StopTokens::Seqs(req.stop.clone()));
    }
    builder = builder
        .add_message(TextMessageRole::System, req.system.clone())
        .add_message(TextMessageRole::User, req.user.clone());

    let mut stream = model
        .stream_chat_request(builder)
        .await
        .map_err(|e| format!("mistral.rs stream start failed: {e}"))?;

    let mut text = String::new();
    let mut prompt_tps = 0.0f32;
    let mut completion_tps = 0.0f32;

    while let Some(response) = stream.next().await {
        match response {
            Response::Chunk(chunk) => {
                if let Some(usage) = chunk.usage {
                    prompt_tps = usage.avg_prompt_tok_per_sec;
                    completion_tps = usage.avg_compl_tok_per_sec;
                }
                if let Some(delta) = chunk
                    .choices
                    .first()
                    .and_then(|choice| choice.delta.content.clone())
                {
                    text.push_str(&delta);
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
                prompt_tps = done.usage.avg_prompt_tok_per_sec;
                completion_tps = done.usage.avg_compl_tok_per_sec;
                if let Some(content) = done
                    .choices
                    .first()
                    .and_then(|choice| choice.message.content.clone())
                {
                    text.push_str(&content);
                }
                break;
            }
            Response::ModelError(message, _) => {
                return Err(format!("mistral.rs model error: {message}"))
            }
            Response::InternalError(err) => {
                return Err(format!("mistral.rs internal error: {err}"))
            }
            Response::ValidationError(err) => {
                return Err(format!("mistral.rs validation error: {err}"))
            }
            _ => {}
        }
    }

    Ok(GenOutput {
        text,
        prompt_tps,
        completion_tps,
    })
}

// ---------------------------------------------------------------------------
// Backend identification (for the UI + diagnostics)
// ---------------------------------------------------------------------------

fn mistralrs_backend() -> &'static str {
    if cfg!(feature = "metal") {
        "metal (Apple GPU)"
    } else if cfg!(target_os = "macos") {
        "cpu (Accelerate)"
    } else {
        "cpu"
    }
}

/// The compiled llama.cpp backend, or `None` when the feature is absent.
pub fn llamacpp_backend() -> Option<&'static str> {
    #[cfg(feature = "llamacpp")]
    {
        if cfg!(feature = "llamacpp-vulkan") {
            Some("vulkan (AMD/NVIDIA/Intel GPU)")
        } else if cfg!(feature = "llamacpp-cuda") {
            Some("cuda (NVIDIA GPU)")
        } else if cfg!(feature = "llamacpp-rocm") {
            Some("rocm (AMD GPU)")
        } else {
            Some("cpu")
        }
    }
    #[cfg(not(feature = "llamacpp"))]
    {
        None
    }
}

fn backend_for(kind: EngineKind) -> String {
    match kind {
        EngineKind::MistralRs => mistralrs_backend().to_string(),
        EngineKind::LlamaCpp => llamacpp_backend().unwrap_or("unavailable").to_string(),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct InferenceCapabilities {
    /// Engines this binary can actually run.
    pub engines: Vec<String>,
    /// Compiled llama.cpp backend, or null when not built in.
    pub llamacpp_backend: Option<String>,
    pub mistralrs_backend: String,
}

/// What the running binary supports — drives the Inference settings UI (e.g.
/// greying out llama.cpp on a default build).
#[tauri::command]
pub fn inference_capabilities() -> InferenceCapabilities {
    let mut engines = vec!["mistralrs".to_string()];
    if cfg!(feature = "llamacpp") {
        engines.push("llamacpp".to_string());
    }
    InferenceCapabilities {
        engines,
        llamacpp_backend: llamacpp_backend().map(str::to_string),
        mistralrs_backend: mistralrs_backend().to_string(),
    }
}

#[derive(Serialize)]
pub struct InferenceTestResult {
    pub ok: bool,
    pub engine: String,
    pub backend: String,
    pub gpu_layers: u32,
    pub tokens_per_sec: f32,
    pub elapsed_ms: u128,
    pub sample: String,
    pub error: Option<String>,
}

/// Load the chosen engine/model and run a tiny generation so the user can
/// confirm the engine works and see which device + throughput it gets.
#[tauri::command]
pub async fn inference_test(
    engine: Option<String>,
    model_path: Option<String>,
    gpu_layers: Option<u32>,
    qwen: State<'_, QwenTaggerState>,
) -> Result<InferenceTestResult, String> {
    let kind = EngineKind::parse(engine.as_deref());
    let gpu_layers = gpu_layers.unwrap_or(0);
    let path = qwen.resolve_model_path(model_path.as_deref());
    let backend = backend_for(kind);

    if !path.exists() {
        return Ok(InferenceTestResult {
            ok: false,
            engine: kind.as_str().to_string(),
            backend,
            gpu_layers,
            tokens_per_sec: 0.0,
            elapsed_ms: 0,
            sample: String::new(),
            error: Some(format!(
                "Model file not found at {}. Open Settings → Local AI Models to download one.",
                path.display()
            )),
        });
    }

    let started = Instant::now();
    let run = async {
        let loaded = load_engine(&path, kind, gpu_layers).await?;
        generate(
            &loaded,
            GenRequest {
                system: "You are a helpful assistant.".to_string(),
                user: "Reply with exactly: ready".to_string(),
                max_tokens: 8,
                stop: vec!["<|im_end|>".to_string()],
            },
        )
        .await
    };

    match run.await {
        Ok(output) => Ok(InferenceTestResult {
            ok: true,
            engine: kind.as_str().to_string(),
            backend,
            gpu_layers,
            tokens_per_sec: output.completion_tps,
            elapsed_ms: started.elapsed().as_millis(),
            sample: output.text.trim().chars().take(120).collect(),
            error: None,
        }),
        Err(err) => Ok(InferenceTestResult {
            ok: false,
            engine: kind.as_str().to_string(),
            backend,
            gpu_layers,
            tokens_per_sec: 0.0,
            elapsed_ms: started.elapsed().as_millis(),
            sample: String::new(),
            error: Some(err),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_defaults_to_mistralrs() {
        assert_eq!(EngineKind::parse(None), EngineKind::MistralRs);
        assert_eq!(EngineKind::parse(Some("")), EngineKind::MistralRs);
        assert_eq!(EngineKind::parse(Some("nonsense")), EngineKind::MistralRs);
        assert_eq!(EngineKind::parse(Some("mistralrs")), EngineKind::MistralRs);
    }

    #[test]
    fn parse_llamacpp_only_when_compiled() {
        let parsed = EngineKind::parse(Some("llamacpp"));
        if cfg!(feature = "llamacpp") {
            assert_eq!(parsed, EngineKind::LlamaCpp);
        } else {
            // Without the feature a stale "llamacpp" setting falls back safely.
            assert_eq!(parsed, EngineKind::MistralRs);
        }
    }

    #[test]
    fn capabilities_always_lists_mistralrs() {
        let caps = inference_capabilities();
        assert!(caps.engines.iter().any(|e| e == "mistralrs"));
        assert_eq!(caps.llamacpp_backend.is_some(), cfg!(feature = "llamacpp"));
    }
}
