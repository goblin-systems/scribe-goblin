use candle_core::{DType, Device, Tensor};
use candle_nn::{Linear, Module, VarBuilder};
use candle_transformers::models::xlm_roberta::{Config as XlmRobertaConfig, XLMRobertaModel};
use ort::session::Session;
use ort::value::Value;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
use tokenizers::Tokenizer;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum token window fed to the model (leaving room for [CLS] and [SEP]).
const MAX_WINDOW_TOKENS: usize = 320;

/// Overlap in tokens between consecutive windows.
const WINDOW_OVERLAP: usize = 64;

/// Minimum character length for a span to survive post-processing.
const MIN_SPAN_CHARS: usize = 8;

/// Minimum mean-softmax confidence for a span to survive post-processing.
const MIN_CONFIDENCE: f32 = 0.5;

/// Label indices from config.json id2label.
const LABEL_O: usize = 0;
const LABEL_B_SECRET: usize = 1;
const LABEL_I_SECRET: usize = 2;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SecretSpan {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub confidence: f32,
    pub label: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SecretMaskerResult {
    pub spans: Vec<SecretSpan>,
    pub has_secrets: bool,
    pub top_score: f32,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// ONNX-based masker (DistilBERT BIO token classifier).
pub struct OnnxMasker {
    pub tokenizer: Tokenizer,
    pub session: Mutex<Session>,
}

/// candle-based masker (XLM-RoBERTa binary token classifier, e.g. deeppass2).
pub struct XlmRobertaMasker {
    pub tokenizer: Tokenizer,
    model: XLMRobertaModel,
    classifier: Linear,
    device: Device,
    /// Label index treated as "secret". Binary models use 1.
    secret_label: usize,
    num_labels: usize,
}

/// A loaded secret-masker model. ONNX models run via ONNX Runtime; Hugging
/// Face-format safetensors XLM-RoBERTa models run via candle. Both expose the
/// same per-token "is this a secret" signal to the windowing/span logic.
pub enum MaskerEngine {
    Onnx(OnnxMasker),
    XlmRoberta(XlmRobertaMasker),
}

#[derive(Deserialize)]
struct TokenClassifierLabels {
    #[serde(default)]
    id2label: std::collections::HashMap<String, String>,
}

impl MaskerEngine {
    /// Load from a model path: a `.onnx` file uses ONNX Runtime; a directory
    /// (config.json + tokenizer.json + model.safetensors) uses candle XLM-RoBERTa.
    pub fn load(model_path: &Path, tokenizer_path: &Path) -> Result<Self, String> {
        let is_onnx = model_path.is_file()
            && model_path
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("onnx"))
                .unwrap_or(false);

        if is_onnx {
            Self::load_onnx(model_path, tokenizer_path)
        } else if model_path.is_dir() {
            Self::load_xlm_roberta(model_path)
        } else {
            Err(format!(
                "Unsupported secret-masker path (expected a .onnx file or a Hugging Face model directory): {}",
                model_path.display()
            ))
        }
    }

    fn load_onnx(model_path: &Path, tokenizer_path: &Path) -> Result<Self, String> {
        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| format!("Failed to load secret-masker tokenizer: {}", e))?;
        let session = Session::builder()
            .map_err(|e: ort::Error| e.to_string())?
            .commit_from_file(model_path)
            .map_err(|e: ort::Error| e.to_string())?;
        Ok(MaskerEngine::Onnx(OnnxMasker {
            tokenizer,
            session: Mutex::new(session),
        }))
    }

    fn load_xlm_roberta(model_dir: &Path) -> Result<Self, String> {
        let config_str = std::fs::read_to_string(model_dir.join("config.json"))
            .map_err(|e| format!("Failed to read secret-masker config.json: {e}"))?;
        let cfg: XlmRobertaConfig = serde_json::from_str(&config_str)
            .map_err(|e| format!("Failed to parse XLM-RoBERTa config: {e}"))?;
        let labels: TokenClassifierLabels =
            serde_json::from_str(&config_str).unwrap_or(TokenClassifierLabels {
                id2label: Default::default(),
            });
        // Binary credential classifier: label 0 = normal, 1 = secret.
        let num_labels = labels.id2label.len().max(2);
        let secret_label = num_labels.saturating_sub(1);

        let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| format!("Failed to load secret-masker tokenizer: {}", e))?;

        let device = Device::Cpu;
        let weights = model_dir.join("model.safetensors");
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights], DType::F32, &device)
                .map_err(|e| format!("Failed to mmap secret-masker weights: {e}"))?
        };
        let model = XLMRobertaModel::new(&cfg, vb.pp("roberta"))
            .map_err(|e| format!("Failed to build XLM-RoBERTa model: {e}"))?;
        let classifier = candle_nn::linear(cfg.hidden_size, num_labels, vb.pp("classifier"))
            .map_err(|e| format!("Failed to load classifier head: {e}"))?;

        Ok(MaskerEngine::XlmRoberta(XlmRobertaMasker {
            tokenizer,
            model,
            classifier,
            device,
            secret_label,
            num_labels,
        }))
    }

    fn tokenizer(&self) -> &Tokenizer {
        match self {
            MaskerEngine::Onnx(m) => &m.tokenizer,
            MaskerEngine::XlmRoberta(m) => &m.tokenizer,
        }
    }
}

/// Reloadable secret-masker state; the model can be switched at runtime via
/// the model_path command parameter.
pub struct SecretMaskerState {
    default_model_path: PathBuf,
    fallback_tokenizer_path: PathBuf,
    loaded: Mutex<Option<(PathBuf, Arc<MaskerEngine>)>>,
    last_error: Mutex<Option<String>>,
}

impl SecretMaskerState {
    pub fn new(default_model_path: PathBuf, fallback_tokenizer_path: PathBuf) -> Self {
        Self {
            default_model_path,
            fallback_tokenizer_path,
            loaded: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }

    pub fn resolve_model_path(&self, requested: Option<&str>) -> PathBuf {
        match requested {
            Some(path) if !path.trim().is_empty() => PathBuf::from(path),
            _ => self.default_model_path.clone(),
        }
    }

    fn tokenizer_path_for(&self, model_path: &Path) -> PathBuf {
        let sibling = model_path
            .parent()
            .map(|dir| dir.join("tokenizer.json"))
            .filter(|p| p.exists());
        sibling.unwrap_or_else(|| self.fallback_tokenizer_path.clone())
    }

    pub fn loaded_model_path(&self) -> Option<PathBuf> {
        self.loaded
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|(path, _)| path.clone()))
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    fn record_error(&self, error: Option<String>) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = error;
        }
    }

    pub fn ensure_engine(&self, requested: Option<&str>) -> Result<Arc<MaskerEngine>, String> {
        let path = self.resolve_model_path(requested);
        if !path.exists() {
            let err = format!(
                "Secret masker model file not found at {}. Open Settings → Local AI Models to download one.",
                path.display()
            );
            self.record_error(Some(err.clone()));
            return Err(err);
        }

        let mut guard = self.loaded.lock().map_err(|e| e.to_string())?;
        if let Some((loaded_path, engine)) = guard.as_ref() {
            if *loaded_path == path {
                return Ok(engine.clone());
            }
        }

        *guard = None;
        match MaskerEngine::load(&path, &self.tokenizer_path_for(&path)) {
            Ok(engine) => {
                let engine = Arc::new(engine);
                *guard = Some((path, engine.clone()));
                self.record_error(None);
                Ok(engine)
            }
            Err(err) => {
                self.record_error(Some(err.clone()));
                Err(err)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn secret_masker_scan(
    text: String,
    model_path: Option<String>,
    state: State<'_, SecretMaskerState>,
) -> Result<SecretMaskerResult, String> {
    if text.is_empty() {
        return Ok(SecretMaskerResult {
            spans: Vec::new(),
            has_secrets: false,
            top_score: 0.0,
        });
    }

    let engine = state.ensure_engine(model_path.as_deref())?;
    let spans = scan_text(&text, &engine)?;

    let top_score = spans.iter().map(|s| s.confidence).fold(0.0f32, f32::max);

    Ok(SecretMaskerResult {
        has_secrets: !spans.is_empty(),
        top_score,
        spans,
    })
}

// ---------------------------------------------------------------------------
// Core inference
// ---------------------------------------------------------------------------

/// Scan a text string for secret spans using windowed token-classification.
fn scan_text(text: &str, state: &MaskerEngine) -> Result<Vec<SecretSpan>, String> {
    // Build a char→byte offset map for the original text.
    let char_to_byte: Vec<usize> = text.char_indices().map(|(byte_idx, _)| byte_idx).collect();
    let total_byte_len = text.len();

    // Tokenize the full text to figure out how many tokens we have.
    let full_encoding = state
        .tokenizer()
        .encode(text, true)
        .map_err(|e| format!("Secret masker tokenization failed: {}", e))?;

    let all_ids = full_encoding.get_ids();
    // Total tokens including [CLS] and [SEP]
    let total_tokens = all_ids.len();

    // If the text fits in a single window (including special tokens), process directly.
    if total_tokens <= MAX_WINDOW_TOKENS + 2 {
        let raw_spans =
            run_window_inference(text, &full_encoding, state, &char_to_byte, total_byte_len)?;
        let filtered = post_process(raw_spans, text);
        return Ok(filtered);
    }

    // Otherwise, use sliding windows over the original text.
    // We work at the character level: figure out where to split the text so each
    // window's tokenization fits within MAX_WINDOW_TOKENS content tokens.
    let all_offsets = full_encoding.get_offsets();
    // Offsets include [CLS] at index 0 and [SEP] at the end; content tokens are 1..n-1.
    let content_offsets = &all_offsets[1..total_tokens - 1];
    let content_count = content_offsets.len();

    let mut all_spans: Vec<SecretSpan> = Vec::new();
    let mut token_start: usize = 0;

    while token_start < content_count {
        let token_end = (token_start + MAX_WINDOW_TOKENS).min(content_count);

        // Character range for this window
        let char_start = content_offsets[token_start].0;
        let char_end = content_offsets[token_end - 1].1;

        // Convert char offsets to byte offsets for slicing
        let byte_start = char_offset_to_byte(char_start, &char_to_byte, total_byte_len);
        let byte_end = char_offset_to_byte(char_end, &char_to_byte, total_byte_len);

        let window_text = &text[byte_start..byte_end];

        // Tokenize window independently (adds its own [CLS]/[SEP])
        let window_encoding = state
            .tokenizer()
            .encode(window_text, true)
            .map_err(|e| format!("Secret masker window tokenization failed: {}", e))?;

        // Build char→byte map for the window substring
        let window_char_to_byte: Vec<usize> = window_text
            .char_indices()
            .map(|(byte_idx, _)| byte_idx)
            .collect();
        let window_byte_len = window_text.len();

        let mut window_spans = run_window_inference(
            window_text,
            &window_encoding,
            state,
            &window_char_to_byte,
            window_byte_len,
        )?;

        // Shift span offsets to be relative to the original text
        for span in &mut window_spans {
            span.start += byte_start;
            span.end += byte_start;
            span.text = text[span.start..span.end].to_string();
        }

        all_spans.extend(window_spans);

        if token_end >= content_count {
            break;
        }
        token_start = token_end - WINDOW_OVERLAP;
    }

    // De-duplicate overlapping spans from different windows (keep highest confidence)
    all_spans = deduplicate_spans(all_spans);

    let filtered = post_process(all_spans, text);
    Ok(filtered)
}

/// Per-token classification result, normalized across engines so the span
/// reconstruction is shared:
/// - `is_secret`: this token belongs to a secret span.
/// - `force_break`: start a new span here even if the previous token was also
///   secret (BIO "B-" tags set this; binary models never do).
/// - `secret_score`: probability mass on the secret class(es), for confidence.
struct TokenPrediction {
    is_secret: bool,
    force_break: bool,
    secret_score: f32,
}

fn softmax(row: &[f32]) -> Vec<f32> {
    let max_logit = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exp_vals: Vec<f32> = row.iter().map(|&x| (x - max_logit).exp()).collect();
    let sum_exp: f32 = exp_vals.iter().sum();
    if sum_exp == 0.0 {
        return vec![0.0; row.len()];
    }
    exp_vals.iter().map(|x| x / sum_exp).collect()
}

/// Run inference on a single tokenized window and return raw (unfiltered) spans.
fn run_window_inference(
    window_text: &str,
    encoding: &tokenizers::Encoding,
    state: &MaskerEngine,
    char_to_byte: &[usize],
    total_byte_len: usize,
) -> Result<Vec<SecretSpan>, String> {
    let predictions = match state {
        MaskerEngine::Onnx(onnx) => onnx_token_predictions(onnx, encoding)?,
        MaskerEngine::XlmRoberta(masker) => xlm_roberta_token_predictions(masker, encoding)?,
    };
    Ok(reconstruct_spans(
        &predictions,
        encoding,
        char_to_byte,
        total_byte_len,
        window_text,
    ))
}

/// ONNX DistilBERT: 3-class BIO logits (O / B-SECRET / I-SECRET).
fn onnx_token_predictions(
    onnx: &OnnxMasker,
    encoding: &tokenizers::Encoding,
) -> Result<Vec<TokenPrediction>, String> {
    let ids = encoding.get_ids();
    let mask = encoding.get_attention_mask();
    let seq_len = ids.len();

    let input_ids_vec: Vec<i64> = ids.iter().map(|&x| x as i64).collect();
    let attention_mask_vec: Vec<i64> = mask.iter().map(|&x| x as i64).collect();

    // DistilBERT: only input_ids and attention_mask (no token_type_ids)
    let input_ids_val = Value::from_array(([1usize, seq_len], input_ids_vec))
        .map_err(|e: ort::Error| e.to_string())?;
    let attention_mask_val = Value::from_array(([1usize, seq_len], attention_mask_vec))
        .map_err(|e: ort::Error| e.to_string())?;

    let inputs = ort::inputs![
        "input_ids" => input_ids_val,
        "attention_mask" => attention_mask_val,
    ];

    let logits_flat = {
        let mut session = onnx.session.lock().map_err(|e| e.to_string())?;
        let outputs = session.run(inputs).map_err(|e: ort::Error| e.to_string())?;
        let logits_val = outputs.get("logits").ok_or("Missing logits output")?;
        let (_, tensor) = logits_val
            .try_extract_tensor::<f32>()
            .map_err(|e: ort::Error| e.to_string())?;
        tensor.to_owned()
    };

    let num_classes = 3usize;
    let mut preds = Vec::with_capacity(seq_len);
    for i in 0..seq_len {
        let row = &logits_flat[i * num_classes..i * num_classes + num_classes];
        let probs = softmax(row);
        let argmax = probs
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(idx, _)| idx)
            .unwrap_or(LABEL_O);
        preds.push(TokenPrediction {
            is_secret: argmax == LABEL_B_SECRET || argmax == LABEL_I_SECRET,
            force_break: argmax == LABEL_B_SECRET,
            secret_score: probs[LABEL_B_SECRET] + probs[LABEL_I_SECRET],
        });
    }
    Ok(preds)
}

/// candle XLM-RoBERTa: binary logits (0 = normal, 1 = credential), run on CPU.
fn xlm_roberta_token_predictions(
    masker: &XlmRobertaMasker,
    encoding: &tokenizers::Encoding,
) -> Result<Vec<TokenPrediction>, String> {
    let ids = encoding.get_ids();
    let seq_len = ids.len();
    let device = &masker.device;

    let input_ids = Tensor::from_iter(ids.iter().map(|&x| x as u32), device)
        .and_then(|t| t.reshape((1, seq_len)))
        .map_err(|e| format!("input_ids tensor failed: {e}"))?;
    let attention_mask = Tensor::ones((1, seq_len), DType::F32, device)
        .map_err(|e| format!("attention_mask tensor failed: {e}"))?;
    // type_vocab_size == 1: a single segment, so all-zero token type ids.
    let token_type_ids = Tensor::zeros((1, seq_len), DType::U32, device)
        .map_err(|e| format!("token_type_ids tensor failed: {e}"))?;

    let hidden = masker
        .model
        .forward(&input_ids, &attention_mask, &token_type_ids, None, None, None)
        .map_err(|e| format!("XLM-RoBERTa forward failed: {e}"))?;
    let logits = masker
        .classifier
        .forward(&hidden)
        .map_err(|e| format!("classifier forward failed: {e}"))?;
    // [1, seq, num_labels] -> Vec<Vec<f32>>
    let logits = logits
        .squeeze(0)
        .and_then(|t| t.to_dtype(DType::F32))
        .and_then(|t| t.to_vec2::<f32>())
        .map_err(|e| format!("reading logits failed: {e}"))?;

    let mut preds = Vec::with_capacity(seq_len);
    for row in &logits {
        let probs = softmax(row);
        let argmax = probs
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(idx, _)| idx)
            .unwrap_or(0);
        let secret_score = probs.get(masker.secret_label).copied().unwrap_or(0.0);
        preds.push(TokenPrediction {
            is_secret: argmax == masker.secret_label && masker.num_labels >= 2,
            // Binary models have no B/I distinction: contiguous secret tokens
            // are one span.
            force_break: false,
            secret_score,
        });
    }
    Ok(preds)
}

/// Group contiguous secret tokens into spans, honoring `force_break` for BIO.
/// Special tokens ([CLS]/[SEP]/[PAD]) close any open span.
fn reconstruct_spans(
    predictions: &[TokenPrediction],
    encoding: &tokenizers::Encoding,
    char_to_byte: &[usize],
    total_byte_len: usize,
    window_text: &str,
) -> Vec<SecretSpan> {
    let offsets = encoding.get_offsets();
    let special_tokens_mask = encoding.get_special_tokens_mask();

    // First collect (start_char, end_char, scores) boundaries, then materialize
    // spans — keeps the borrow of `boundaries` out of the per-token logic.
    let mut boundaries: Vec<(usize, usize, Vec<f32>)> = Vec::new();
    let mut start_char: Option<usize> = None;
    let mut end_char: usize = 0;
    let mut scores: Vec<f32> = Vec::new();

    for (i, pred) in predictions.iter().enumerate() {
        let is_special = special_tokens_mask.get(i).copied().unwrap_or(0) == 1;
        let break_here = is_special || !pred.is_secret || pred.force_break;

        if break_here {
            if let Some(s) = start_char.take() {
                boundaries.push((s, end_char, std::mem::take(&mut scores)));
            }
        }
        if is_special || !pred.is_secret {
            continue;
        }

        let (token_char_start, token_char_end) = offsets[i];
        if start_char.is_none() {
            start_char = Some(token_char_start);
        }
        end_char = token_char_end;
        scores.push(pred.secret_score);
    }
    if let Some(s) = start_char.take() {
        boundaries.push((s, end_char, scores));
    }

    boundaries
        .into_iter()
        .map(|(s, e, sc)| build_span(s, e, &sc, char_to_byte, total_byte_len, window_text))
        .collect()
}

// ---------------------------------------------------------------------------
// Span construction helpers
// ---------------------------------------------------------------------------

/// Build a SecretSpan from character offsets, converting to byte offsets.
fn build_span(
    char_start: usize,
    char_end: usize,
    scores: &[f32],
    char_to_byte: &[usize],
    total_byte_len: usize,
    text: &str,
) -> SecretSpan {
    let byte_start = char_offset_to_byte(char_start, char_to_byte, total_byte_len);
    let byte_end = char_offset_to_byte(char_end, char_to_byte, total_byte_len);

    let span_text = if byte_start < text.len() && byte_end <= text.len() && byte_start < byte_end {
        text[byte_start..byte_end].to_string()
    } else {
        String::new()
    };

    let confidence = if scores.is_empty() {
        0.0
    } else {
        scores.iter().sum::<f32>() / scores.len() as f32
    };

    SecretSpan {
        start: byte_start,
        end: byte_end,
        text: span_text,
        confidence,
        label: "SECRET".to_string(),
    }
}

/// Convert a character offset to a byte offset using the precomputed map.
fn char_offset_to_byte(char_offset: usize, char_to_byte: &[usize], total_byte_len: usize) -> usize {
    if char_offset >= char_to_byte.len() {
        total_byte_len
    } else {
        char_to_byte[char_offset]
    }
}

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

/// Remove overlapping spans from different windows, keeping the highest-confidence one.
fn deduplicate_spans(mut spans: Vec<SecretSpan>) -> Vec<SecretSpan> {
    if spans.len() <= 1 {
        return spans;
    }

    // Sort by start offset, then by confidence descending
    spans.sort_by(|a, b| {
        a.start.cmp(&b.start).then_with(|| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    let mut result: Vec<SecretSpan> = Vec::new();

    for span in spans {
        if let Some(last) = result.last() {
            // If this span overlaps with the previous one
            if span.start < last.end {
                // Keep the one with higher confidence (already in result)
                if span.confidence > last.confidence {
                    *result.last_mut().unwrap() = span;
                }
                // Otherwise skip the lower-confidence duplicate
                continue;
            }
        }
        result.push(span);
    }

    result
}

// ---------------------------------------------------------------------------
// Post-processing filters
// ---------------------------------------------------------------------------

fn post_process(spans: Vec<SecretSpan>, _original_text: &str) -> Vec<SecretSpan> {
    spans
        .into_iter()
        .filter(|span| {
            // Drop spans shorter than MIN_SPAN_CHARS
            if span.text.len() < MIN_SPAN_CHARS {
                return false;
            }

            // Drop spans below confidence threshold
            if span.confidence < MIN_CONFIDENCE {
                return false;
            }

            // Drop spans that are pure whitespace
            if span.text.trim().is_empty() {
                return false;
            }

            // Drop spans that are pure punctuation
            if span
                .text
                .chars()
                .all(|c| c.is_ascii_punctuation() || c.is_whitespace())
            {
                return false;
            }

            // Drop spans that look like common English words (single word, no digits/special chars, < 20 chars)
            if is_likely_common_word(&span.text) {
                return false;
            }

            true
        })
        .collect()
}

/// Heuristic: if the span is a single word under 20 chars with only alphabetic chars,
/// it is probably a common English word, not a secret.
fn is_likely_common_word(text: &str) -> bool {
    let trimmed = text.trim();
    let lowered = trimmed.to_lowercase();

    // Must be a single word (no whitespace)
    if lowered.contains(char::is_whitespace) {
        return false;
    }

    // Must be shorter than 20 chars
    if lowered.len() >= 20 {
        return false;
    }

    // Must contain only alphabetic characters (no digits, no special chars)
    if !lowered.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }

    true
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Integration tests for the secret masker module.
    //! These tests require the real ONNX model files in `../resources/secret-masker/`.
    //! Run with: `cargo test -- --ignored`

    use super::*;
    use std::sync::LazyLock;

    fn get_resource_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
    }

    static TEST_STATE: LazyLock<MaskerEngine> = LazyLock::new(|| {
        let model_dir = get_resource_dir().join("secret-masker");
        MaskerEngine::load(
            &model_dir.join("model.onnx"),
            &model_dir.join("tokenizer.json"),
        )
        .expect("Failed to load secret masker for tests")
    });

    #[test]
    #[ignore]
    fn test_secret_masker_state_loads() {
        // Force initialisation; will panic inside LazyLock if it fails.
        let _ = &*TEST_STATE;
    }

    #[test]
    #[ignore]
    fn test_scan_aws_key() {
        let text = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        let spans = scan_text(text, &TEST_STATE).expect("scan_text failed");
        let filtered = post_process(spans, text);
        assert!(
            !filtered.is_empty(),
            "Expected at least 1 secret span for AWS key, got 0"
        );
    }

    #[test]
    #[ignore]
    fn test_scan_normal_text() {
        let text = "Hello world, this is a normal sentence";
        let spans = scan_text(text, &TEST_STATE).expect("scan_text failed");
        let filtered = post_process(spans, text);
        assert!(
            filtered.is_empty(),
            "Expected 0 secret spans for normal text, got {}",
            filtered.len()
        );
    }

    #[test]
    #[ignore]
    fn test_scan_empty_text() {
        let text = "";
        // Empty text should not error
        let spans =
            scan_text(text, &TEST_STATE).expect("scan_text should not error on empty input");
        assert!(
            spans.is_empty(),
            "Expected 0 spans for empty text, got {}",
            spans.len()
        );
    }

    #[test]
    #[ignore]
    fn test_scan_github_token() {
        let text = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef01";
        let spans = scan_text(text, &TEST_STATE).expect("scan_text failed");
        let filtered = post_process(spans, text);
        assert!(
            !filtered.is_empty(),
            "Expected at least 1 secret span for GitHub token, got 0"
        );
    }

    #[test]
    #[ignore]
    fn test_span_confidence_range() {
        let text = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        let spans = scan_text(text, &TEST_STATE).expect("scan_text failed");
        let filtered = post_process(spans, text);
        for span in &filtered {
            assert!(
                span.confidence > 0.0 && span.confidence <= 1.0,
                "Span confidence should be in (0.0, 1.0], got {} for '{}'",
                span.confidence,
                span.text,
            );
        }
    }
}
