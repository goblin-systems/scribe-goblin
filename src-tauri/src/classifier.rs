use crate::db;
use ort::session::Session;
use ort::value::Value;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;
use tokenizers::Tokenizer;

pub struct ClassifierState {
    pub embedding_tokenizer: Tokenizer,
    pub embedding_session: Mutex<Session>,
}

impl ClassifierState {
    pub fn new(resource_dir: PathBuf) -> Result<Self, String> {
        let embedding_tokenizer =
            Tokenizer::from_file(resource_dir.join("embedding_tokenizer.json"))
                .map_err(|e| format!("Failed to load embedding tokenizer: {}", e))?;

        let embedding_session = Session::builder()
            .map_err(|e: ort::Error| e.to_string())?
            .commit_from_file(resource_dir.join("embedding.onnx"))
            .map_err(|e: ort::Error| e.to_string())?;

        Ok(Self {
            embedding_tokenizer,
            embedding_session: Mutex::new(embedding_session),
        })
    }
}

#[tauri::command]
pub async fn generate_embedding(
    text: String,
    state: State<'_, Option<Arc<ClassifierState>>>,
) -> Result<Vec<f32>, String> {
    let state = state.as_ref().ok_or("Classifier not initialized")?;
    if text.trim().is_empty() {
        return Err("Input text is empty".to_string());
    }
    generate_embedding_inner(&text, state.as_ref())
}

pub(crate) fn generate_embedding_inner(
    text: &str,
    state: &ClassifierState,
) -> Result<Vec<f32>, String> {
    let encoding = state
        .embedding_tokenizer
        .encode(text, true)
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
        let l_h_s = outputs
            .get("last_hidden_state")
            .ok_or("Missing last_hidden_state")?;
        let (shape, tensor) = l_h_s
            .try_extract_tensor::<f32>()
            .map_err(|e: ort::Error| e.to_string())?;
        (shape.to_owned(), tensor.to_owned())
    };

    let hidden_size = lhs_shape[2] as usize;
    let seq_len_out = lhs_shape[1] as usize;

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

    let norm = embedding.iter().map(|&x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in embedding.iter_mut() {
            *x /= norm;
        }
    }

    Ok(embedding)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReembedResult {
    pub total: u64,
    pub succeeded: u64,
    pub failed: u64,
}

#[tauri::command]
pub async fn reembed_all_entries(
    db_state: State<'_, db::DbState>,
    classifier_state: State<'_, Option<Arc<ClassifierState>>>,
) -> Result<ReembedResult, String> {
    let classifier = classifier_state
        .as_ref()
        .ok_or("Classifier not initialized")?;
    let guard = db_state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;

    let mut stmt = conn
        .prepare("SELECT id, content FROM entries")
        .map_err(|e| e.to_string())?;
    let entries: Vec<(String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let total = entries.len();
    let mut succeeded = 0u64;
    let mut failed = 0u64;

    for (id, content) in &entries {
        match generate_embedding_inner(content, classifier) {
            Ok(embedding) => {
                let bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
                conn.execute(
                    "DELETE FROM vec_entries WHERE entry_id = ?1",
                    rusqlite::params![id],
                )
                .ok();
                conn.execute(
                    "INSERT INTO vec_entries(entry_id, embedding) VALUES (?1, ?2)",
                    rusqlite::params![id, bytes],
                )
                .map_err(|e| e.to_string())?;

                succeeded += 1;
            }
            Err(e) => {
                eprintln!("reembed_all_entries: failed for entry {}: {}", id, e);
                failed += 1;
            }
        }
    }

    Ok(ReembedResult {
        total: total as u64,
        succeeded,
        failed,
    })
}

#[cfg(test)]
mod tests {
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

    #[test]
    #[ignore]
    fn test_classifier_state_loads() {
        let _ = &*TEST_STATE;
    }

    #[test]
    #[ignore]
    fn test_generate_embedding_returns_384_dims() {
        let emb = generate_embedding_inner("hello world", &TEST_STATE)
            .expect("generate_embedding failed");
        assert_eq!(emb.len(), 384);
    }

    #[test]
    #[ignore]
    fn test_embedding_is_normalized() {
        let emb = generate_embedding_inner("hello world", &TEST_STATE)
            .expect("generate_embedding failed");
        let norm: f32 = emb.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "L2 norm should be ≈1.0, got {}", norm);
    }
}
