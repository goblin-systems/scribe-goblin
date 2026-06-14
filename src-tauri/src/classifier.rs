use crate::db;
use mistralrs::{EmbeddingModelBuilder, EmbeddingRequestBuilder, Model as MistralModel};
use ort::session::Session;
use ort::value::Value;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};
use tokenizers::Tokenizer;
use tokio::sync::Mutex as AsyncMutex;

const REEMBED_PROGRESS_EVENT: &str = "reembed-progress";

#[derive(Serialize, Clone)]
pub struct ReembedProgress {
    pub done: u64,
    pub total: u64,
    pub failed: u64,
    pub elapsed_ms: u128,
    pub finished: bool,
}

/// A loaded ONNX embedding model + tokenizer pair.
pub struct OnnxEmbedder {
    pub embedding_tokenizer: Tokenizer,
    pub embedding_session: Mutex<Session>,
}

impl OnnxEmbedder {
    pub fn new(model_path: &Path, tokenizer_path: &Path) -> Result<Self, String> {
        let embedding_tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| format!("Failed to load embedding tokenizer: {}", e))?;

        let embedding_session = Session::builder()
            .map_err(|e: ort::Error| e.to_string())?
            .commit_from_file(model_path)
            .map_err(|e: ort::Error| e.to_string())?;

        Ok(Self {
            embedding_tokenizer,
            embedding_session: Mutex::new(embedding_session),
        })
    }
}

/// Embedding backends: BERT-style ONNX models run via ONNX Runtime; Hugging
/// Face-format safetensors models (e.g. Qwen3-Embedding) run via mistral.rs.
pub enum EmbedderEngine {
    Onnx(OnnxEmbedder),
    MistralRs(MistralModel),
}

fn is_onnx_model_path(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("onnx"))
            .unwrap_or(false)
}

async fn load_embedder(path: &Path, tokenizer_path: &Path) -> Result<EmbedderEngine, String> {
    if is_onnx_model_path(path) {
        OnnxEmbedder::new(path, tokenizer_path).map(EmbedderEngine::Onnx)
    } else if path.is_dir() {
        EmbeddingModelBuilder::new(path.to_string_lossy().to_string())
            .build()
            .await
            .map(EmbedderEngine::MistralRs)
            .map_err(|e| format!("Failed to load safetensors embedding model: {e}"))
    } else {
        Err(format!(
            "Unsupported embedding model path (expected a .onnx file or a Hugging Face model directory): {}",
            path.display()
        ))
    }
}

/// Embed text with whichever engine is loaded; the result is L2-normalized.
pub(crate) async fn embed_text(engine: &EmbedderEngine, text: &str) -> Result<Vec<f32>, String> {
    match engine {
        EmbedderEngine::Onnx(onnx) => generate_embedding_inner(text, onnx),
        EmbedderEngine::MistralRs(model) => {
            let mut embeddings = model
                .generate_embeddings(EmbeddingRequestBuilder::new().add_prompt(text))
                .await
                .map_err(|e| format!("Embedding inference failed: {e}"))?;
            if embeddings.is_empty() {
                return Err("Embedding model returned no vectors".to_string());
            }
            let mut embedding = embeddings.swap_remove(0);
            let norm = embedding.iter().map(|&x| x * x).sum::<f32>().sqrt();
            if norm > 0.0 {
                for x in embedding.iter_mut() {
                    *x /= norm;
                }
            }
            Ok(embedding)
        }
    }
}

/// Reloadable embedding state: the model can be switched at runtime by passing
/// a different path; the engine reloads lazily on the next call.
pub struct ClassifierState {
    default_model_path: PathBuf,
    fallback_tokenizer_path: PathBuf,
    loaded: AsyncMutex<Option<(PathBuf, Arc<EmbedderEngine>)>>,
    loaded_path: Mutex<Option<PathBuf>>,
    last_error: Mutex<Option<String>>,
}

impl ClassifierState {
    pub fn new(default_model_path: PathBuf, fallback_tokenizer_path: PathBuf) -> Self {
        Self {
            default_model_path,
            fallback_tokenizer_path,
            loaded: AsyncMutex::new(None),
            loaded_path: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }

    pub fn resolve_model_path(&self, requested: Option<&str>) -> PathBuf {
        match requested {
            Some(path) if !path.trim().is_empty() => PathBuf::from(path),
            _ => self.default_model_path.clone(),
        }
    }

    /// Downloaded models ship a tokenizer.json next to the model file; the
    /// legacy bundled model uses resources/embedding_tokenizer.json.
    fn tokenizer_path_for(&self, model_path: &Path) -> PathBuf {
        let sibling = model_path
            .parent()
            .map(|dir| dir.join("tokenizer.json"))
            .filter(|p| p.exists());
        sibling.unwrap_or_else(|| self.fallback_tokenizer_path.clone())
    }

    pub fn loaded_model_path(&self) -> Option<PathBuf> {
        self.loaded_path.lock().ok().and_then(|p| p.clone())
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    fn record_error(&self, error: Option<String>) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = error;
        }
    }

    fn record_loaded_path(&self, path: Option<PathBuf>) {
        if let Ok(mut guard) = self.loaded_path.lock() {
            *guard = path;
        }
    }

    pub async fn ensure_engine(
        &self,
        requested: Option<&str>,
    ) -> Result<Arc<EmbedderEngine>, String> {
        let path = self.resolve_model_path(requested);
        if !path.exists() {
            let err = format!(
                "Embedding model not found at {}. Open Settings → Local AI Models to download one.",
                path.display()
            );
            self.record_error(Some(err.clone()));
            return Err(err);
        }

        let mut guard = self.loaded.lock().await;
        if let Some((loaded_path, engine)) = guard.as_ref() {
            if *loaded_path == path {
                return Ok(engine.clone());
            }
        }

        // Drop the previous engine before loading the next one.
        *guard = None;
        self.record_loaded_path(None);
        match load_embedder(&path, &self.tokenizer_path_for(&path)).await {
            Ok(engine) => {
                let engine = Arc::new(engine);
                *guard = Some((path.clone(), engine.clone()));
                self.record_loaded_path(Some(path));
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

#[tauri::command]
pub async fn generate_embedding(
    text: String,
    model_path: Option<String>,
    state: State<'_, ClassifierState>,
) -> Result<Vec<f32>, String> {
    if text.trim().is_empty() {
        return Err("Input text is empty".to_string());
    }
    let engine = state.ensure_engine(model_path.as_deref()).await?;
    embed_text(&engine, &text).await
}

pub(crate) fn generate_embedding_inner(
    text: &str,
    state: &OnnxEmbedder,
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
    model_path: Option<String>,
    app: AppHandle,
    db_state: State<'_, db::DbState>,
    classifier_state: State<'_, ClassifierState>,
) -> Result<ReembedResult, String> {
    let classifier = classifier_state.ensure_engine(model_path.as_deref()).await?;

    // Read entries in a scoped lock: the DB mutex guard must not be held
    // across the embedding awaits below.
    let entries: Vec<(String, String)> = {
        let guard = db_state.conn.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("DB not initialised")?;
        let mut stmt = conn
            .prepare("SELECT id, content FROM entries")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    let total = entries.len();
    let mut failed = 0u64;
    let mut embedded: Vec<(String, Vec<f32>)> = Vec::with_capacity(total);

    let started = Instant::now();
    let mut last_emit = Instant::now();
    let emit_progress = |app: &AppHandle, done: u64, failed: u64, finished: bool| {
        let _ = app.emit(
            REEMBED_PROGRESS_EVENT,
            ReembedProgress {
                done,
                total: total as u64,
                failed,
                elapsed_ms: started.elapsed().as_millis(),
                finished,
            },
        );
    };
    emit_progress(&app, 0, 0, false);

    for (index, (id, content)) in entries.iter().enumerate() {
        match embed_text(&classifier, content).await {
            Ok(embedding) => embedded.push((id.clone(), embedding)),
            Err(e) => {
                eprintln!("reembed_all_entries: failed for entry {}: {}", id, e);
                failed += 1;
            }
        }
        // Throttle events to ~5/s so the UI updates smoothly without flooding.
        let done = (index + 1) as u64;
        if last_emit.elapsed().as_millis() >= 200 || done == total as u64 {
            last_emit = Instant::now();
            emit_progress(&app, done, failed, false);
        }
    }

    let succeeded = embedded.len() as u64;
    {
        let guard = db_state.conn.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("DB not initialised")?;
        if let Some((_, first)) = embedded.first() {
            db::ensure_vec_table_dim(conn, first.len())?;
        }
        for (id, embedding) in &embedded {
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
        }
    }

    emit_progress(&app, succeeded + failed, failed, true);

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

    static TEST_STATE: LazyLock<OnnxEmbedder> = LazyLock::new(|| {
        let resources = get_resource_dir();
        OnnxEmbedder::new(
            &resources.join("embedding.onnx"),
            &resources.join("embedding_tokenizer.json"),
        )
        .expect("Failed to load classifier for tests")
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires downloaded Qwen3-Embedding-0.6B in the app models dir; run explicitly"]
    async fn qwen3_embedding_safetensors_inference_works() {
        let home = std::env::var("HOME").expect("HOME not set");
        let dir = std::path::PathBuf::from(home)
            .join("Library/Application Support/com.scribe-goblin/models/qwen3-embedding-0.6b");
        assert!(
            dir.join("model.safetensors").exists(),
            "missing Qwen3-Embedding model at {}",
            dir.display(),
        );

        let engine = load_embedder(&dir, &dir.join("tokenizer.json"))
            .await
            .expect("failed to load safetensors embedding model");

        let emb = embed_text(&engine, "hello world")
            .await
            .expect("embedding inference failed");
        assert_eq!(emb.len(), 1024, "Qwen3-Embedding-0.6B should emit 1024 dims");
        let norm: f32 = emb.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "L2 norm should be ≈1.0, got {norm}");

        // Semantic sanity: related sentences must be closer than unrelated ones.
        let a = embed_text(&engine, "the cat sat on the mat").await.unwrap();
        let b = embed_text(&engine, "a kitten rests on a rug").await.unwrap();
        let c = embed_text(&engine, "quarterly financial report 2026")
            .await
            .unwrap();
        let dot = |x: &[f32], y: &[f32]| x.iter().zip(y).map(|(p, q)| p * q).sum::<f32>();
        assert!(
            dot(&a, &b) > dot(&a, &c),
            "related similarity {} should exceed unrelated {}",
            dot(&a, &b),
            dot(&a, &c),
        );
    }
}
