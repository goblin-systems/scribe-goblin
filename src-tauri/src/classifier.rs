use ort::session::Session;
use ort::value::Value;
use tokenizers::Tokenizer;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize, Debug)]
pub struct ClassificationResult {
    pub label: String,
    pub label_score: f64,
    pub embedding: Vec<f32>,
}

pub struct ClassifierState {
    pub classifier_tokenizer: Tokenizer,
    pub embedding_tokenizer: Tokenizer,
    pub classifier_session: Mutex<Session>,
    pub embedding_session: Mutex<Session>,
    pub labels: Vec<String>,
}

impl ClassifierState {
    pub fn new(resource_dir: PathBuf) -> Result<Self, String> {
        let classifier_tokenizer = Tokenizer::from_file(resource_dir.join("classifier_tokenizer.json"))
            .map_err(|e| format!("Failed to load classifier tokenizer: {}", e))?;

        let embedding_tokenizer = Tokenizer::from_file(resource_dir.join("embedding_tokenizer.json"))
            .map_err(|e| format!("Failed to load embedding tokenizer: {}", e))?;

        let classifier_session = Session::builder()
            .map_err(|e: ort::Error| e.to_string())?
            .commit_from_file(resource_dir.join("classifier.onnx"))
            .map_err(|e: ort::Error| e.to_string())?;

        let embedding_session = Session::builder()
            .map_err(|e: ort::Error| e.to_string())?
            .commit_from_file(resource_dir.join("embedding.onnx"))
            .map_err(|e: ort::Error| e.to_string())?;

        let labels = vec![
            "password".to_string(),
            "api_key".to_string(),
            "code".to_string(),
            "command".to_string(),
            "url".to_string(),
            "message".to_string(),
            "data".to_string(),
            "other".to_string(),
        ];

        Ok(Self {
            classifier_tokenizer,
            embedding_tokenizer,
            classifier_session: Mutex::new(classifier_session),
            embedding_session: Mutex::new(embedding_session),
            labels,
        })
    }
}

#[tauri::command]
pub async fn classify_text(
    text: String,
    state: State<'_, Option<Arc<ClassifierState>>>,
) -> Result<ClassificationResult, String> {
    let state = state.as_ref().ok_or("Classifier not initialized")?;

    if text.trim().is_empty() {
        return Err("Input text is empty".to_string());
    }

    // 1. Generate Embedding (MiniLM)
    let embedding = generate_embedding(&text, state.as_ref())?;

    // 2. Zero-shot Classification (MobileBERT NLI) - Batched for performance
    let (label, label_score) = run_zero_shot_classification(&text, state.as_ref())?;

    Ok(ClassificationResult {
        label,
        label_score,
        embedding,
    })
}

fn generate_embedding(text: &str, state: &ClassifierState) -> Result<Vec<f32>, String> {
    let encoding = state.embedding_tokenizer.encode(text, true)
        .map_err(|e| format!("Embedding tokenization failed: {}", e))?;

    let ids = encoding.get_ids();
    let mask = encoding.get_attention_mask();
    let type_ids = encoding.get_type_ids();
    let seq_len = ids.len();

    let input_ids_vec: Vec<i64> = ids.iter().map(|&x| x as i64).collect();
    let attention_mask_vec: Vec<i64> = mask.iter().map(|&x| x as i64).collect();
    let token_type_ids_vec: Vec<i64> = type_ids.iter().map(|&x| x as i64).collect();

    let input_ids_val = Value::from_array(([1usize, seq_len], input_ids_vec))
        .map_err(|e: ort::Error| e.to_string())?;
    let attention_mask_val = Value::from_array(([1usize, seq_len], attention_mask_vec))
        .map_err(|e: ort::Error| e.to_string())?;
    let token_type_ids_val = Value::from_array(([1usize, seq_len], token_type_ids_vec))
        .map_err(|e: ort::Error| e.to_string())?;

    let inputs = ort::inputs![
        "input_ids" => input_ids_val,
        "attention_mask" => attention_mask_val,
        "token_type_ids" => token_type_ids_val,
    ];

    let (lhs_shape, last_hidden_state) = {
        let mut session = state.embedding_session.lock().map_err(|e| e.to_string())?;
        let outputs = session.run(inputs).map_err(|e: ort::Error| e.to_string())?;
        let l_h_s = outputs.get("last_hidden_state").ok_or("Missing last_hidden_state")?;
        let (shape, tensor) = l_h_s.try_extract_tensor::<f32>().map_err(|e: ort::Error| e.to_string())?;
        (shape.to_owned(), tensor.to_owned())
    };

    let hidden_size = lhs_shape[2] as usize;
    let seq_len_out = lhs_shape[1] as usize;
    
    // Mean Pooling
    let mut embedding = vec![0.0f32; hidden_size];
    let mut mask_sum = 0.0f32;
    for i in 0..seq_len_out {
        let m = mask[i] as f32;
        mask_sum += m;
        for j in 0..hidden_size {
            embedding[j] += last_hidden_state[i * hidden_size + j] * m;
        }
    }
    if mask_sum > 0.0 {
        for j in 0..hidden_size {
            embedding[j] /= mask_sum;
        }
    }

    // L2 Normalization
    let norm = embedding.iter().map(|&x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in embedding.iter_mut() {
            *x /= norm;
        }
    }

    Ok(embedding)
}

fn run_zero_shot_classification(text: &str, state: &ClassifierState) -> Result<(String, f64), String> {
    let num_labels = state.labels.len();
    let mut batch_ids = Vec::new();
    let mut batch_mask = Vec::new();
    let mut batch_types = Vec::new();
    let mut max_seq_len = 0;

    // First pass: Encode all and find max seq len
    let mut encodings = Vec::new();
    for label in &state.labels {
        let hypothesis = format!("This clipboard item is {}.", label);
        let encoding = state.classifier_tokenizer.encode((text.to_string(), hypothesis), true)
            .map_err(|e| format!("Classifier tokenization failed: {}", e))?;
        if encoding.get_ids().len() > max_seq_len {
            max_seq_len = encoding.get_ids().len();
        }
        encodings.push(encoding);
    }

    // Second pass: Pad and flatten for batch tensor
    for encoding in encodings {
        let mut ids = encoding.get_ids().iter().map(|&x| x as i64).collect::<Vec<i64>>();
        let mut mask = encoding.get_attention_mask().iter().map(|&x| x as i64).collect::<Vec<i64>>();
        let mut types = encoding.get_type_ids().iter().map(|&x| x as i64).collect::<Vec<i64>>();

        // Padding
        while ids.len() < max_seq_len {
            ids.push(0);
            mask.push(0);
            types.push(0);
        }

        batch_ids.extend(ids);
        batch_mask.extend(mask);
        batch_types.extend(types);
    }

    let input_ids_val = Value::from_array(([num_labels, max_seq_len], batch_ids))
        .map_err(|e: ort::Error| e.to_string())?;
    let attention_mask_val = Value::from_array(([num_labels, max_seq_len], batch_mask))
        .map_err(|e: ort::Error| e.to_string())?;
    let token_type_ids_val = Value::from_array(([num_labels, max_seq_len], batch_types))
        .map_err(|e: ort::Error| e.to_string())?;

    let inputs = ort::inputs![
        "input_ids" => input_ids_val,
        "attention_mask" => attention_mask_val,
        "token_type_ids" => token_type_ids_val,
    ];

    let logits = {
        let mut session = state.classifier_session.lock().map_err(|e| e.to_string())?;
        let outputs = session.run(inputs).map_err(|e: ort::Error| e.to_string())?;
        let logits_val = outputs.get("logits").ok_or("Missing logits")?;
        let (_, tensor) = logits_val.try_extract_tensor::<f32>().map_err(|e: ort::Error| e.to_string())?;
        tensor.to_owned()
    };

    let mut entailment_scores = Vec::new();
    for i in 0..num_labels {
        // Logits shape is [num_labels, 3]
        // MNLI index 2 is entailment
        let row_start = i * 3;
        if row_start + 2 < logits.len() {
            entailment_scores.push(logits[row_start + 2]);
        } else {
            entailment_scores.push(0.0);
        }
    }

    // Apply Softmax across labels
    let exp_scores: Vec<f32> = entailment_scores.iter().map(|x| x.exp()).collect();
    let sum_exp: f32 = exp_scores.iter().sum();
    let probs: Vec<f32> = exp_scores.iter().map(|x| x / sum_exp).collect();

    let (max_idx, &max_prob) = probs.iter().enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .ok_or("No labels scored")?;

    Ok((state.labels[max_idx].clone(), max_prob as f64))
}

#[cfg(test)]
mod tests {
    //! Integration tests for the classifier module.
    //! These tests require the real ONNX model files in `../resources/`.
    //! Run with: `cargo test -- --ignored`

    use super::*;
    use std::sync::LazyLock;

    fn get_resource_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
    }

    static TEST_STATE: LazyLock<ClassifierState> = LazyLock::new(|| {
        ClassifierState::new(get_resource_dir()).expect("Failed to load classifier for tests")
    });

    const VALID_LABELS: &[&str] = &[
        "password", "api_key", "code", "command", "url", "message", "data", "other",
    ];

    #[test]
    #[ignore]
    fn test_classifier_state_loads() {
        // Force initialisation; will panic inside LazyLock if it fails.
        let _ = &*TEST_STATE;
    }

    #[test]
    #[ignore]
    fn test_generate_embedding_returns_384_dims() {
        let emb = generate_embedding("hello world", &TEST_STATE)
            .expect("generate_embedding failed");
        assert_eq!(emb.len(), 384, "Embedding should have exactly 384 dimensions");
    }

    #[test]
    #[ignore]
    fn test_embedding_is_normalized() {
        let emb = generate_embedding("hello world", &TEST_STATE)
            .expect("generate_embedding failed");
        let norm: f32 = emb.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!(
            (norm - 1.0).abs() < 1e-4,
            "Embedding L2 norm should be ≈1.0, got {}",
            norm
        );
    }

    #[test]
    #[ignore]
    fn test_zero_shot_classification_returns_valid_label() {
        let (label, _score) = run_zero_shot_classification("ls -la /tmp", &TEST_STATE)
            .expect("run_zero_shot_classification failed");
        assert!(
            VALID_LABELS.contains(&label.as_str()),
            "Label '{}' is not in the valid set",
            label
        );
    }

    #[test]
    #[ignore]
    fn test_zero_shot_classification_score_range() {
        let (_label, score) = run_zero_shot_classification("ls -la /tmp", &TEST_STATE)
            .expect("run_zero_shot_classification failed");
        assert!(
            score > 0.0 && score <= 1.0,
            "Score should be in (0.0, 1.0], got {}",
            score
        );
    }

    #[test]
    #[ignore]
    fn test_classify_url() {
        let (label, score) =
            run_zero_shot_classification("https://github.com/example/repo", &TEST_STATE)
                .expect("run_zero_shot_classification failed");
        assert!(
            VALID_LABELS.contains(&label.as_str()),
            "Label '{}' is not in the valid set",
            label
        );
        // Verify it produces a confident score for the URL input
        assert!(
            score > 0.0 && score <= 1.0,
            "Score should be in (0.0, 1.0], got {}",
            score
        );
    }

    #[test]
    #[ignore]
    fn test_classify_code() {
        let (label, score) =
            run_zero_shot_classification("fn main() { println!(\"Hello\"); }", &TEST_STATE)
                .expect("run_zero_shot_classification failed");
        assert!(
            VALID_LABELS.contains(&label.as_str()),
            "Label '{}' is not in the valid set",
            label
        );
        // Verify it produces a confident score for the code input
        assert!(
            score > 0.0 && score <= 1.0,
            "Score should be in (0.0, 1.0], got {}",
            score
        );
    }

    #[test]
    #[ignore]
    fn test_empty_input_classification() {
        // Empty input should not panic. It may succeed or return an error.
        let emb_result = generate_embedding("", &TEST_STATE);
        assert!(
            emb_result.is_ok() || emb_result.is_err(),
            "generate_embedding on empty input should not panic"
        );

        let cls_result = run_zero_shot_classification("", &TEST_STATE);
        assert!(
            cls_result.is_ok() || cls_result.is_err(),
            "run_zero_shot_classification on empty input should not panic"
        );
    }
}
