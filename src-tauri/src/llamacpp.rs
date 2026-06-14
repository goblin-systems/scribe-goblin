//! llama.cpp inference backend (compiled in only with the `llamacpp` feature).
//!
//! Wraps `llama-cpp-2` to satisfy the same `inference::generate` contract as the
//! mistral.rs engine. GPU offload is controlled by `gpu_layers` at model-load
//! time (0 = CPU). Which GPU vendor runs is decided by the compiled backend
//! feature (`llamacpp-vulkan` / `-cuda` / `-rocm`); this file is backend-agnostic.

// `token_to_str` + `Special` are deprecated upstream in favour of the streaming
// `token_to_piece` API, but the simple form is correct for the short, mostly
// ASCII completions we generate. Intentionally kept; revisit if upstream removes it.
#![allow(deprecated)]

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel, Special};
use llama_cpp_2::sampling::LlamaSampler;

use crate::inference::{GenOutput, GenRequest};

/// Context window. Tagging feeds ~1.4k chars (~<500 tokens); autocomplete is
/// tiny. 2048 leaves comfortable room for the prompt plus the short completion.
const N_CTX: u32 = 2048;

/// The llama.cpp backend may only be initialized once per process.
static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();

fn backend() -> &'static LlamaBackend {
    BACKEND.get_or_init(|| LlamaBackend::init().expect("failed to initialize llama.cpp backend"))
}

/// A loaded GGUF model plus its requested GPU offload.
pub struct LlamaEngine {
    model: LlamaModel,
    #[allow(dead_code)]
    gpu_layers: u32,
}

impl LlamaEngine {
    pub fn load(path: &Path, gpu_layers: u32) -> Result<Self, String> {
        if path.is_dir() {
            return Err(
                "The llama.cpp engine needs a GGUF model file, but the selected model is a \
                 directory (safetensors). Pick a GGUF model or switch to the mistral.rs engine."
                    .to_string(),
            );
        }
        let params = LlamaModelParams::default().with_n_gpu_layers(gpu_layers);
        let model = LlamaModel::load_from_file(backend(), path, &params)
            .map_err(|e| format!("llama.cpp model load failed: {e}"))?;
        Ok(Self { model, gpu_layers })
    }

    /// Run a blocking generation. Called from `inference::generate` inside
    /// `block_in_place`, so blocking here is fine.
    pub fn generate(&self, req: &GenRequest) -> Result<GenOutput, String> {
        let prompt = build_qwen_prompt(&req.system, &req.user);

        let threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4);
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(N_CTX))
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let mut ctx = self
            .model
            .new_context(backend(), ctx_params)
            .map_err(|e| format!("llama.cpp context creation failed: {e}"))?;

        // Qwen2 GGUFs do not prepend a BOS token.
        let tokens = self
            .model
            .str_to_token(&prompt, AddBos::Never)
            .map_err(|e| format!("llama.cpp tokenization failed: {e}"))?;
        if tokens.len() as u32 >= N_CTX {
            return Err("Prompt is too long for the llama.cpp context window.".to_string());
        }

        let mut batch = LlamaBatch::new(N_CTX as usize, 1);
        let last_index = tokens.len() as i32 - 1;
        for (i, token) in tokens.iter().enumerate() {
            batch
                .add(*token, i as i32, &[0], i as i32 == last_index)
                .map_err(|e| format!("llama.cpp batch add failed: {e}"))?;
        }
        ctx.decode(&mut batch)
            .map_err(|e| format!("llama.cpp prompt decode failed: {e}"))?;

        let mut sampler = LlamaSampler::greedy();
        let mut text = String::new();
        let mut generated = 0usize;
        let mut n_cur = tokens.len() as i32;
        let started = Instant::now();

        while generated < req.max_tokens {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);

            if self.model.is_eog_token(token) {
                break;
            }

            let piece = self
                .model
                .token_to_str(token, Special::Tokenize)
                .unwrap_or_default();
            text.push_str(&piece);
            generated += 1;

            // Honour stop sequences (e.g. the Qwen turn terminator) by trimming.
            if let Some(cut) = first_stop_index(&text, &req.stop) {
                text.truncate(cut);
                break;
            }

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|e| format!("llama.cpp batch add failed: {e}"))?;
            n_cur += 1;
            ctx.decode(&mut batch)
                .map_err(|e| format!("llama.cpp decode failed: {e}"))?;
        }

        let secs = started.elapsed().as_secs_f32();
        let completion_tps = if secs > 0.0 { generated as f32 / secs } else { 0.0 };

        Ok(GenOutput {
            text,
            prompt_tps: 0.0,
            completion_tps,
        })
    }
}

/// Qwen2 ChatML prompt. Matches the chat format mistral.rs applies, so both
/// engines see the same conversation.
fn build_qwen_prompt(system: &str, user: &str) -> String {
    format!(
        "<|im_start|>system\n{system}<|im_end|>\n\
         <|im_start|>user\n{user}<|im_end|>\n\
         <|im_start|>assistant\n"
    )
}

/// Earliest byte index at which any (non-empty) stop sequence occurs.
fn first_stop_index(text: &str, stop: &[String]) -> Option<usize> {
    stop.iter()
        .filter(|s| !s.is_empty())
        .filter_map(|s| text.find(s.as_str()))
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_uses_chatml_roles() {
        let p = build_qwen_prompt("SYS", "USER");
        assert!(p.starts_with("<|im_start|>system\nSYS<|im_end|>"));
        assert!(p.contains("<|im_start|>user\nUSER<|im_end|>"));
        assert!(p.ends_with("<|im_start|>assistant\n"));
    }

    #[test]
    fn stop_index_picks_earliest() {
        assert_eq!(first_stop_index("abXcdY", &["Y".into(), "X".into()]), Some(2));
        assert_eq!(first_stop_index("abc", &["Z".into()]), None);
        assert_eq!(first_stop_index("abc", &["".into()]), None);
    }
}
