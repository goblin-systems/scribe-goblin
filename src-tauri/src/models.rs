use crate::classifier::ClassifierState;
use crate::qwen_tagger::QwenTaggerState;
use crate::secret_masker::SecretMaskerState;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

pub const KIND_LLM_GGUF: &str = "llm-gguf";
pub const KIND_LLM_SAFETENSORS: &str = "llm-safetensors";
pub const KIND_EMBEDDING_ONNX: &str = "embedding-onnx";
pub const KIND_EMBEDDING_SAFETENSORS: &str = "embedding-safetensors";
pub const KIND_SECRET_MASKER_ONNX: &str = "secret-masker-onnx";
pub const KIND_SECRET_MASKER_SAFETENSORS: &str = "secret-masker-safetensors";

pub const EMBEDDING_MODEL_ID: &str = "minilm-l6-v2-onnx";
pub const SECRET_MASKER_MODEL_ID: &str = "secret-masker-onnx";

struct RegistryEntry {
    id: &'static str,
    kind: &'static str,
    label: &'static str,
    repo: Option<&'static str>,
    /// Files downloaded together; the first one is the primary model file used
    /// for installed-state resolution.
    files: &'static [&'static str],
    approx_size_bytes: Option<u64>,
}

impl RegistryEntry {
    fn primary_file(&self) -> Option<&'static str> {
        self.files.first().copied()
    }
}

/// Curated models. LLM entries are limited to single-file Qwen2.5 GGUFs because
/// the tagger's stop tokens and prompts assume the Qwen chat format. Embedding
/// entries must be 384-dimensional — the vec_entries table is float[384].
const REGISTRY: &[RegistryEntry] = &[
    RegistryEntry {
        id: "qwen2.5-0.5b-instruct-q4_0",
        kind: KIND_LLM_GGUF,
        label: "Qwen2.5 0.5B Instruct (q4_0, legacy default)",
        repo: Some("Qwen/Qwen2.5-0.5B-Instruct-GGUF"),
        files: &["qwen2.5-0.5b-instruct-q4_0.gguf"],
        approx_size_bytes: Some(409_000_000),
    },
    RegistryEntry {
        id: "qwen2.5-0.5b-instruct-q4_k_m",
        kind: KIND_LLM_GGUF,
        label: "Qwen2.5 0.5B Instruct (q4_k_m, recommended small)",
        repo: Some("Qwen/Qwen2.5-0.5B-Instruct-GGUF"),
        files: &["qwen2.5-0.5b-instruct-q4_k_m.gguf"],
        approx_size_bytes: Some(398_000_000),
    },
    RegistryEntry {
        id: "qwen2.5-1.5b-instruct-q4_k_m",
        kind: KIND_LLM_GGUF,
        label: "Qwen2.5 1.5B Instruct (q4_k_m)",
        repo: Some("Qwen/Qwen2.5-1.5B-Instruct-GGUF"),
        files: &["qwen2.5-1.5b-instruct-q4_k_m.gguf"],
        approx_size_bytes: Some(1_120_000_000),
    },
    RegistryEntry {
        id: "qwen2.5-3b-instruct-q4_k_m",
        kind: KIND_LLM_GGUF,
        label: "Qwen2.5 3B Instruct (q4_k_m, best quality)",
        repo: Some("Qwen/Qwen2.5-3B-Instruct-GGUF"),
        files: &["qwen2.5-3b-instruct-q4_k_m.gguf"],
        approx_size_bytes: Some(2_100_000_000),
    },
    RegistryEntry {
        id: EMBEDDING_MODEL_ID,
        kind: KIND_EMBEDDING_ONNX,
        label: "all-MiniLM-L6-v2 (384 dims, default)",
        repo: Some("sentence-transformers/all-MiniLM-L6-v2"),
        files: &["onnx/model.onnx", "tokenizer.json"],
        approx_size_bytes: Some(90_000_000),
    },
    RegistryEntry {
        id: "bge-small-en-v1.5-onnx",
        kind: KIND_EMBEDDING_ONNX,
        label: "bge-small-en-v1.5 (384 dims, stronger retrieval)",
        repo: Some("Xenova/bge-small-en-v1.5"),
        files: &["onnx/model.onnx", "tokenizer.json"],
        approx_size_bytes: Some(133_000_000),
    },
    RegistryEntry {
        id: "gte-small-onnx",
        kind: KIND_EMBEDDING_ONNX,
        label: "gte-small (384 dims)",
        repo: Some("Xenova/gte-small"),
        files: &["onnx/model.onnx", "tokenizer.json"],
        approx_size_bytes: Some(133_000_000),
    },
    RegistryEntry {
        id: "jina-embeddings-v2-small-en-onnx",
        kind: KIND_EMBEDDING_ONNX,
        label: "jina-embeddings-v2-small-en (512 dims, 8k context)",
        repo: Some("Xenova/jina-embeddings-v2-small-en"),
        files: &["onnx/model.onnx", "tokenizer.json"],
        approx_size_bytes: Some(130_000_000),
    },
    RegistryEntry {
        id: "jina-embeddings-v2-base-en-onnx",
        kind: KIND_EMBEDDING_ONNX,
        label: "jina-embeddings-v2-base-en (768 dims, 8k context)",
        repo: Some("Xenova/jina-embeddings-v2-base-en"),
        files: &["onnx/model.onnx", "tokenizer.json"],
        approx_size_bytes: Some(550_000_000),
    },
    RegistryEntry {
        id: "qwen3-embedding-0.6b",
        kind: KIND_EMBEDDING_SAFETENSORS,
        label: "Qwen3-Embedding-0.6B (1024 dims, safetensors via mistral.rs)",
        repo: Some("Qwen/Qwen3-Embedding-0.6B"),
        // sentence-transformers layout: the transformer weights plus the
        // modules.json pipeline and its per-module configs.
        files: &[
            "model.safetensors",
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "modules.json",
            "config_sentence_transformers.json",
            "1_Pooling/config.json",
        ],
        approx_size_bytes: Some(1_200_000_000),
    },
    RegistryEntry {
        id: SECRET_MASKER_MODEL_ID,
        kind: KIND_SECRET_MASKER_ONNX,
        label: "DistilBERT secret masker (ONNX, BIO)",
        repo: Some("AndrewAndrewsen/distilbert-secret-masker"),
        files: &["onnx/model.onnx", "onnx/tokenizer.json"],
        approx_size_bytes: Some(266_000_000),
    },
    RegistryEntry {
        id: "deeppass2-bert",
        kind: KIND_SECRET_MASKER_SAFETENSORS,
        label: "DeepPass2 (XLM-RoBERTa, binary, safetensors)",
        repo: Some("gneeraj/deeppass2-bert"),
        files: &[
            "model.safetensors",
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "special_tokens_map.json",
        ],
        approx_size_bytes: Some(1_110_000_000),
    },
];

pub struct ModelsState {
    pub models_dir: PathBuf,
    pub resources_dir: PathBuf,
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ModelsState {
    pub fn new(models_dir: PathBuf, resources_dir: PathBuf) -> Self {
        Self {
            models_dir,
            resources_dir,
            cancel_flags: Mutex::new(HashMap::new()),
        }
    }

    fn download_dest(&self, id: &str, file: &str) -> PathBuf {
        self.models_dir
            .join(sanitize_id(id))
            .join(local_relpath(file))
    }
}

/// Where a downloaded file lands under the model's directory. HF puts ONNX
/// exports in an `onnx/` subfolder, but the loader expects the model file
/// beside its tokenizer, so a leading `onnx/` is flattened away. Other
/// subdirectories (e.g. sentence-transformers `1_Pooling/`) are preserved.
fn local_relpath(file: &str) -> PathBuf {
    let stripped = file.strip_prefix("onnx/").unwrap_or(file);
    PathBuf::from(stripped)
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Legacy locations that predate the model manager (bundled resources).
fn legacy_path(id: &str, resources_dir: &Path) -> Option<PathBuf> {
    match id {
        "qwen2.5-0.5b-instruct-q4_0" => Some(
            resources_dir
                .join("qwen-25-05b")
                .join("qwen2.5-0.5b-instruct-q4_0.gguf"),
        ),
        EMBEDDING_MODEL_ID => Some(resources_dir.join("embedding.onnx")),
        SECRET_MASKER_MODEL_ID => Some(resources_dir.join("secret-masker").join("model.onnx")),
        _ => None,
    }
}

/// Resolve the on-disk location for a model managed by id: the downloaded copy
/// wins, then any legacy bundled location. Returns the first existing path.
pub fn resolve_model_file(
    id: &str,
    file: &str,
    models_dir: &Path,
    resources_dir: &Path,
) -> Option<PathBuf> {
    let basename = Path::new(file)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| file.to_string());
    let downloaded = models_dir.join(sanitize_id(id)).join(&basename);
    if downloaded.exists() {
        return Some(downloaded);
    }
    // Custom downloads may use a different file name; accept any .onnx in the
    // model's directory for ONNX-based slots.
    if basename.ends_with(".onnx") {
        if let Some(found) = first_onnx_in(&models_dir.join(sanitize_id(id))) {
            return Some(found);
        }
    }
    legacy_path(id, resources_dir).filter(|p| p.exists())
}

fn first_onnx_in(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut onnx_files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .map(|ext| ext.eq_ignore_ascii_case("onnx"))
                .unwrap_or(false)
        })
        .collect();
    onnx_files.sort();
    onnx_files.into_iter().next()
}

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub repo: Option<String>,
    pub file: Option<String>,
    pub approx_size_bytes: Option<u64>,
    pub installed: bool,
    pub path: Option<String>,
    pub source: String,
}

#[tauri::command]
pub fn models_list(state: State<'_, ModelsState>) -> Result<Vec<ModelInfo>, String> {
    let mut result: Vec<ModelInfo> = REGISTRY
        .iter()
        .map(|entry| {
            let mut path = entry.primary_file().and_then(|file| {
                resolve_model_file(entry.id, file, &state.models_dir, &state.resources_dir)
            });
            // Safetensors models load from their directory, not the weights file.
            if entry.kind == KIND_EMBEDDING_SAFETENSORS
                || entry.kind == KIND_SECRET_MASKER_SAFETENSORS
            {
                path = path.and_then(|p| p.parent().map(Path::to_path_buf));
            }
            ModelInfo {
                id: entry.id.to_string(),
                kind: entry.kind.to_string(),
                label: entry.label.to_string(),
                repo: entry.repo.map(str::to_string),
                file: entry.primary_file().map(str::to_string),
                approx_size_bytes: entry.approx_size_bytes,
                installed: path.is_some(),
                path: path.map(|p| p.to_string_lossy().to_string()),
                source: "registry".to_string(),
            }
        })
        .collect();

    // Custom models downloaded into the models dir that aren't registry entries.
    result.extend(scan_custom_models(&state.models_dir, &result));

    // GGUF files already present in the Hugging Face cache.
    result.extend(scan_hf_cache());

    Ok(result)
}

fn scan_custom_models(models_dir: &Path, known: &[ModelInfo]) -> Vec<ModelInfo> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(models_dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if known.iter().any(|m| sanitize_id(&m.id) == id) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let name = file.file_name().to_string_lossy().to_string();
            let kind = if name.ends_with(".gguf") {
                KIND_LLM_GGUF
            } else if name.ends_with(".onnx") {
                // The directory id encodes the slot the custom model was
                // downloaded into.
                if id.contains("secret-masker") {
                    KIND_SECRET_MASKER_ONNX
                } else {
                    KIND_EMBEDDING_ONNX
                }
            } else {
                continue;
            };
            found.push(ModelInfo {
                id: id.clone(),
                kind: kind.to_string(),
                label: format!("{name} (custom)"),
                repo: None,
                file: Some(name),
                approx_size_bytes: path.metadata().ok().map(|m| m.len()),
                installed: true,
                path: Some(path.to_string_lossy().to_string()),
                source: "custom".to_string(),
            });
        }
    }
    found
}

fn hf_cache_dir() -> Option<PathBuf> {
    if let Ok(hf_home) = std::env::var("HF_HOME") {
        return Some(PathBuf::from(hf_home));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".cache").join("huggingface"))
}

fn scan_hf_cache() -> Vec<ModelInfo> {
    let mut found = Vec::new();
    let Some(hub) = hf_cache_dir().map(|dir| dir.join("hub")) else {
        return found;
    };
    let Ok(repos) = std::fs::read_dir(&hub) else {
        return found;
    };
    for repo_entry in repos.flatten() {
        let repo_dir_name = repo_entry.file_name().to_string_lossy().to_string();
        if !repo_dir_name.starts_with("models--") {
            continue;
        }
        let repo_name = repo_dir_name
            .trim_start_matches("models--")
            .replace("--", "/");
        let snapshots = repo_entry.path().join("snapshots");
        let Ok(revisions) = std::fs::read_dir(&snapshots) else {
            continue;
        };
        for revision in revisions.flatten() {
            collect_gguf_files(&revision.path(), &repo_name, 0, &mut found);
            if let Some(info) = safetensors_snapshot_info(&revision.path(), &repo_name) {
                found.push(info);
            }
        }
    }
    found
}

/// A snapshot directory containing a full Hugging Face-format model
/// (config + tokenizer + safetensors weights) is loadable as a directory.
fn safetensors_snapshot_info(dir: &Path, repo: &str) -> Option<ModelInfo> {
    if !dir.join("config.json").exists() || !dir.join("tokenizer.json").exists() {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut weights_bytes: u64 = 0;
    let mut has_weights = false;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".safetensors") {
            has_weights = true;
            // metadata() follows the blob symlink to the real file.
            weights_bytes += entry.path().metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    if !has_weights {
        return None;
    }
    // Embedding repos can't be told apart from chat models by config alone
    // (e.g. Qwen3-Embedding reports Qwen3ForCausalLM), so go by repo name.
    let kind = if repo.to_lowercase().contains("embed") {
        KIND_EMBEDDING_SAFETENSORS
    } else {
        KIND_LLM_SAFETENSORS
    };
    Some(ModelInfo {
        id: format!("hf-cache:{}", dir.to_string_lossy()),
        kind: kind.to_string(),
        label: format!("{repo} (HF cache, safetensors)"),
        repo: Some(repo.to_string()),
        file: None,
        approx_size_bytes: if weights_bytes > 0 { Some(weights_bytes) } else { None },
        installed: true,
        path: Some(dir.to_string_lossy().to_string()),
        source: "hf-cache".to_string(),
    })
}

fn collect_gguf_files(dir: &Path, repo: &str, depth: usize, out: &mut Vec<ModelInfo>) {
    if depth > 2 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_gguf_files(&path, repo, depth + 1, out);
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".gguf") {
            continue;
        }
        // Symlinked blobs: metadata() follows the link to the real blob.
        let size = path.metadata().ok().map(|m| m.len());
        out.push(ModelInfo {
            id: format!("hf-cache:{}", path.to_string_lossy()),
            kind: KIND_LLM_GGUF.to_string(),
            label: format!("{repo} / {name} (HF cache)"),
            repo: Some(repo.to_string()),
            file: Some(name),
            approx_size_bytes: size,
            installed: true,
            path: Some(path.to_string_lossy().to_string()),
            source: "hf-cache".to_string(),
        });
    }
}

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    pub id: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub status: String, // "downloading" | "done" | "error" | "cancelled"
    pub error: Option<String>,
    pub path: Option<String>,
}

const PROGRESS_EVENT: &str = "model-download-progress";

#[tauri::command]
pub async fn models_download(
    id: String,
    repo: Option<String>,
    file: Option<String>,
    app: AppHandle,
    state: State<'_, ModelsState>,
) -> Result<(), String> {
    let registry_entry = REGISTRY.iter().find(|entry| entry.id == id);
    let repo = repo
        .filter(|r| !r.trim().is_empty())
        .or_else(|| registry_entry.and_then(|e| e.repo.map(str::to_string)))
        .ok_or_else(|| format!("No Hugging Face repo known for model '{id}'"))?;
    let files: Vec<String> = match file.filter(|f| !f.trim().is_empty()) {
        Some(custom) => vec![custom],
        None => registry_entry
            .map(|e| e.files.iter().map(|f| f.to_string()).collect())
            .filter(|files: &Vec<String>| !files.is_empty())
            .ok_or_else(|| format!("No file names known for model '{id}'"))?,
    };

    if repo.contains("..") || files.iter().any(|f| f.contains("..")) {
        return Err("Invalid repo or file name".to_string());
    }

    let primary_dest = state.download_dest(&id, &files[0]);
    if primary_dest.exists() {
        return Err(format!(
            "Model already downloaded at {}",
            primary_dest.display()
        ));
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        if flags.contains_key(&id) {
            return Err(format!("Download for '{id}' is already in progress"));
        }
        flags.insert(id.clone(), cancel.clone());
    }

    let downloads: Vec<(String, PathBuf)> = files
        .iter()
        .map(|file| {
            (
                format!("https://huggingface.co/{repo}/resolve/main/{file}"),
                state.download_dest(&id, file),
            )
        })
        .collect();
    let task_id = id.clone();
    let task_app = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut last_path = PathBuf::new();
        for (url, dest) in &downloads {
            if dest.exists() {
                continue;
            }
            last_path = download_file(&task_app, &task_id, url, dest, &cancel)?;
        }
        Ok::<PathBuf, String>(last_path)
    })
    .await
    .map_err(|e| format!("Download task panicked: {e}"))?;

    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&id);
    }

    match result {
        Ok(path) => {
            let _ = app.emit(
                PROGRESS_EVENT,
                DownloadProgress {
                    id,
                    downloaded: 0,
                    total: None,
                    status: "done".to_string(),
                    error: None,
                    path: Some(path.to_string_lossy().to_string()),
                },
            );
            Ok(())
        }
        Err(err) => {
            let status = if err == "cancelled" { "cancelled" } else { "error" };
            let _ = app.emit(
                PROGRESS_EVENT,
                DownloadProgress {
                    id,
                    downloaded: 0,
                    total: None,
                    status: status.to_string(),
                    error: Some(err.clone()),
                    path: None,
                },
            );
            Err(err)
        }
    }
}

fn download_file(
    app: &AppHandle,
    id: &str,
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
) -> Result<PathBuf, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();

    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| format!("Download request failed: {e}"))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("Download failed: HTTP {status} for {url}"));
    }

    let total: Option<u64> = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create models directory: {e}"))?;
    }
    let part_path = dest.with_extension("part");
    let mut out = std::fs::File::create(&part_path)
        .map_err(|e| format!("Failed to create {}: {e}", part_path.display()))?;

    let mut reader = response.body_mut().as_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(out);
            let _ = std::fs::remove_file(&part_path);
            return Err("cancelled".to_string());
        }
        let read = reader
            .read(&mut buf)
            .map_err(|e| format!("Download stream error: {e}"))?;
        if read == 0 {
            break;
        }
        out.write_all(&buf[..read])
            .map_err(|e| format!("Failed writing model file: {e}"))?;
        downloaded += read as u64;

        if last_emit.elapsed() >= Duration::from_millis(250) {
            last_emit = Instant::now();
            let _ = app.emit(
                PROGRESS_EVENT,
                DownloadProgress {
                    id: id.to_string(),
                    downloaded,
                    total,
                    status: "downloading".to_string(),
                    error: None,
                    path: None,
                },
            );
        }
    }

    out.flush().map_err(|e| e.to_string())?;
    drop(out);

    if let Some(expected) = total {
        if downloaded != expected {
            let _ = std::fs::remove_file(&part_path);
            return Err(format!(
                "Download incomplete: got {downloaded} of {expected} bytes"
            ));
        }
    }

    std::fs::rename(&part_path, dest)
        .map_err(|e| format!("Failed to move downloaded file into place: {e}"))?;
    Ok(dest.to_path_buf())
}

#[tauri::command]
pub fn models_cancel_download(id: String, state: State<'_, ModelsState>) -> Result<(), String> {
    let flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
    match flags.get(&id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err(format!("No active download for '{id}'")),
    }
}

// ---------------------------------------------------------------------------
// AI diagnostics
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct EngineStatus {
    pub name: String,
    pub engine: String,
    pub backend: String,
    pub loaded: bool,
    pub model_path: String,
    pub model_exists: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct AiStatusReport {
    pub resources_dir: String,
    pub models_dir: String,
    pub embedding: EngineStatus,
    pub secret_masker: EngineStatus,
    pub llm: EngineStatus,
}

#[tauri::command]
pub fn ai_status(
    llm_model_path: Option<String>,
    embedding_model_path: Option<String>,
    secret_masker_model_path: Option<String>,
    models_state: State<'_, ModelsState>,
    classifier: State<'_, ClassifierState>,
    secret_masker: State<'_, SecretMaskerState>,
    qwen: State<'_, QwenTaggerState>,
) -> Result<AiStatusReport, String> {
    let llm_path = qwen.resolve_model_path(llm_model_path.as_deref());
    let embedding_path = classifier.resolve_model_path(embedding_model_path.as_deref());
    let masker_path = secret_masker.resolve_model_path(secret_masker_model_path.as_deref());

    let candle_backend = || {
        if cfg!(feature = "metal") {
            "metal (Apple GPU)".to_string()
        } else if cfg!(target_os = "macos") {
            "cpu (Accelerate)".to_string()
        } else {
            "cpu".to_string()
        }
    };
    let embedding_is_safetensors = embedding_path.is_dir();

    Ok(AiStatusReport {
        resources_dir: models_state.resources_dir.to_string_lossy().to_string(),
        models_dir: models_state.models_dir.to_string_lossy().to_string(),
        embedding: EngineStatus {
            name: "Embeddings (semantic search)".to_string(),
            engine: if embedding_is_safetensors {
                "mistral.rs 0.8 (candle)".to_string()
            } else {
                "ONNX Runtime (ort 2.0-rc)".to_string()
            },
            backend: if embedding_is_safetensors {
                candle_backend()
            } else {
                "cpu".to_string()
            },
            loaded: classifier
                .loaded_model_path()
                .map(|p| p == embedding_path)
                .unwrap_or(false),
            model_path: embedding_path.to_string_lossy().to_string(),
            model_exists: embedding_path.exists(),
            error: classifier.last_error(),
        },
        secret_masker: EngineStatus {
            name: "Secret masker".to_string(),
            engine: if masker_path.is_dir() {
                "mistral.rs/candle (XLM-RoBERTa)".to_string()
            } else {
                "ONNX Runtime (ort 2.0-rc, DistilBERT)".to_string()
            },
            backend: "cpu".to_string(),
            loaded: secret_masker
                .loaded_model_path()
                .map(|p| p == masker_path)
                .unwrap_or(false),
            model_path: masker_path.to_string_lossy().to_string(),
            model_exists: masker_path.exists(),
            error: secret_masker.last_error(),
        },
        llm: EngineStatus {
            name: "Local LLM (tags & summaries)".to_string(),
            engine: "mistral.rs 0.8 (candle)".to_string(),
            backend: candle_backend(),
            loaded: qwen
                .loaded_model_path()
                .map(|p| p == llm_path)
                .unwrap_or(false),
            model_path: llm_path.to_string_lossy().to_string(),
            model_exists: llm_path.exists(),
            error: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_legacy_qwen_path() {
        let models_dir = PathBuf::from("/nonexistent-models");
        let resources_dir = PathBuf::from("/nonexistent-resources");
        // Nothing exists, so resolution returns None rather than a phantom path.
        assert!(resolve_model_file(
            "qwen2.5-0.5b-instruct-q4_0",
            "qwen2.5-0.5b-instruct-q4_0.gguf",
            &models_dir,
            &resources_dir,
        )
        .is_none());
    }

    #[test]
    fn sanitize_id_strips_path_separators() {
        assert_eq!(sanitize_id("a/b\\c:d"), "a-b-c-d");
        assert_eq!(sanitize_id("qwen2.5-0.5b_q4"), "qwen2.5-0.5b_q4");
    }

    #[test]
    fn registry_ids_are_unique() {
        let mut ids: Vec<&str> = REGISTRY.iter().map(|e| e.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), REGISTRY.len());
    }
}
