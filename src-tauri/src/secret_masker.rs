use ort::session::Session;
use ort::value::Value;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
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

pub struct SecretMaskerState {
    pub tokenizer: Tokenizer,
    pub session: Mutex<Session>,
}

impl SecretMaskerState {
    pub fn new(resource_dir: PathBuf) -> Result<Self, String> {
        let model_dir = resource_dir.join("secret-masker");

        let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| format!("Failed to load secret-masker tokenizer: {}", e))?;

        let session = Session::builder()
            .map_err(|e: ort::Error| e.to_string())?
            .commit_from_file(model_dir.join("model.onnx"))
            .map_err(|e: ort::Error| e.to_string())?;

        Ok(Self {
            tokenizer,
            session: Mutex::new(session),
        })
    }
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn secret_masker_scan(
    text: String,
    state: State<'_, Option<Arc<SecretMaskerState>>>,
) -> Result<SecretMaskerResult, String> {
    let state = state.as_ref().ok_or("Secret masker not initialized")?;

    if text.is_empty() {
        return Ok(SecretMaskerResult {
            spans: Vec::new(),
            has_secrets: false,
            top_score: 0.0,
        });
    }

    let spans = scan_text(&text, state.as_ref())?;

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
fn scan_text(text: &str, state: &SecretMaskerState) -> Result<Vec<SecretSpan>, String> {
    // Build a char→byte offset map for the original text.
    let char_to_byte: Vec<usize> = text.char_indices().map(|(byte_idx, _)| byte_idx).collect();
    let total_byte_len = text.len();

    // Tokenize the full text to figure out how many tokens we have.
    let full_encoding = state
        .tokenizer
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
            .tokenizer
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

/// Run inference on a single tokenized window and return raw (unfiltered) spans.
fn run_window_inference(
    _window_text: &str,
    encoding: &tokenizers::Encoding,
    state: &SecretMaskerState,
    char_to_byte: &[usize],
    total_byte_len: usize,
) -> Result<Vec<SecretSpan>, String> {
    let ids = encoding.get_ids();
    let mask = encoding.get_attention_mask();
    let offsets = encoding.get_offsets();
    let special_tokens_mask = encoding.get_special_tokens_mask();
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
        let mut session = state.session.lock().map_err(|e| e.to_string())?;
        let outputs = session.run(inputs).map_err(|e: ort::Error| e.to_string())?;
        let logits_val = outputs.get("logits").ok_or("Missing logits output")?;
        let (_, tensor) = logits_val
            .try_extract_tensor::<f32>()
            .map_err(|e: ort::Error| e.to_string())?;
        tensor.to_owned()
    };

    // logits shape: [1, seq_len, 3] — stored flat as [seq_len * 3]
    let num_classes = 3usize;

    // Compute per-token predictions
    let mut token_preds: Vec<(usize, f32)> = Vec::with_capacity(seq_len); // (argmax, softmax_score_for_argmax)
    let mut token_secret_scores: Vec<f32> = Vec::with_capacity(seq_len); // softmax for SECRET class (B or I)

    for i in 0..seq_len {
        let row_start = i * num_classes;
        let row = &logits_flat[row_start..row_start + num_classes];

        // Softmax
        let max_logit = row.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let exp_vals: Vec<f32> = row.iter().map(|&x| (x - max_logit).exp()).collect();
        let sum_exp: f32 = exp_vals.iter().sum();
        let probs: Vec<f32> = exp_vals.iter().map(|x| x / sum_exp).collect();

        let (argmax, &max_prob) = probs
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap();

        // Secret score = sum of B-SECRET + I-SECRET probabilities
        let secret_score = probs[LABEL_B_SECRET] + probs[LABEL_I_SECRET];

        token_preds.push((argmax, max_prob));
        token_secret_scores.push(secret_score);
    }

    // BIO span reconstruction
    let mut spans: Vec<SecretSpan> = Vec::new();
    let mut current_span_start_char: Option<usize> = None;
    let mut current_span_end_char: usize = 0;
    let mut current_span_scores: Vec<f32> = Vec::new();

    for i in 0..seq_len {
        // Skip special tokens ([CLS], [SEP], [PAD])
        if special_tokens_mask[i] == 1 {
            // Close any open span
            if let Some(start_char) = current_span_start_char.take() {
                let span = build_span(
                    start_char,
                    current_span_end_char,
                    &current_span_scores,
                    char_to_byte,
                    total_byte_len,
                    _window_text,
                );
                spans.push(span);
                current_span_scores.clear();
            }
            continue;
        }

        let (pred_label, _) = token_preds[i];
        let secret_score = token_secret_scores[i];
        let (token_char_start, token_char_end) = offsets[i];

        match pred_label {
            LABEL_B_SECRET => {
                // Close any existing span
                if let Some(start_char) = current_span_start_char.take() {
                    let span = build_span(
                        start_char,
                        current_span_end_char,
                        &current_span_scores,
                        char_to_byte,
                        total_byte_len,
                        _window_text,
                    );
                    spans.push(span);
                    current_span_scores.clear();
                }
                // Start new span
                current_span_start_char = Some(token_char_start);
                current_span_end_char = token_char_end;
                current_span_scores.push(secret_score);
            }
            LABEL_I_SECRET => {
                if current_span_start_char.is_some() {
                    // Extend current span
                    current_span_end_char = token_char_end;
                    current_span_scores.push(secret_score);
                } else {
                    // Orphaned I-SECRET — treat as B-SECRET (start new span)
                    current_span_start_char = Some(token_char_start);
                    current_span_end_char = token_char_end;
                    current_span_scores.push(secret_score);
                }
            }
            LABEL_O | _ => {
                // Close any existing span
                if let Some(start_char) = current_span_start_char.take() {
                    let span = build_span(
                        start_char,
                        current_span_end_char,
                        &current_span_scores,
                        char_to_byte,
                        total_byte_len,
                        _window_text,
                    );
                    spans.push(span);
                    current_span_scores.clear();
                }
            }
        }
    }

    // Close final span if still open
    if let Some(start_char) = current_span_start_char.take() {
        let span = build_span(
            start_char,
            current_span_end_char,
            &current_span_scores,
            char_to_byte,
            total_byte_len,
            _window_text,
        );
        spans.push(span);
    }

    Ok(spans)
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

    static TEST_STATE: LazyLock<SecretMaskerState> = LazyLock::new(|| {
        SecretMaskerState::new(get_resource_dir()).expect("Failed to load secret masker for tests")
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
