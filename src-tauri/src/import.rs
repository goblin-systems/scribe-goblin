use crate::db::{self, DbState, EntryRow, NewEntry};
use crate::storage;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPayload {
    pub kind: Option<String>,
    pub text: Option<String>,
    pub html_content: Option<String>,
    pub path: Option<String>,
    pub file_bytes_base64: Option<String>,
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub import_origin: Option<String>,
    pub source_app: Option<String>,
}

#[derive(Debug)]
struct AttachmentInfo {
    rel_path: String,
    size_bytes: i64,
    sha256: String,
}

#[tauri::command]
pub fn import_capture(
    app: AppHandle,
    state: State<DbState>,
    payloads: Vec<ImportPayload>,
) -> Result<Vec<EntryRow>, String> {
    if payloads.is_empty() {
        return Ok(Vec::new());
    }

    let storage_paths = storage::bootstrap(&app)?;
    let source = db::normalize_entry_source("import")?;
    let mut created_entries = Vec::new();

    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;

    for payload in payloads {
        if let Some(entry) = import_payload(conn, &storage_paths.attachments_dir, &source, payload)?
        {
            created_entries.push(entry);
        }
    }

    Ok(created_entries)
}

fn import_payload(
    conn: &rusqlite::Connection,
    attachments_dir: &Path,
    source: &str,
    payload: ImportPayload,
) -> Result<Option<EntryRow>, String> {
    let kind = payload.kind.clone().unwrap_or_else(|| infer_kind(&payload));
    let ImportPayload {
        kind: _,
        text,
        html_content,
        path,
        file_bytes_base64,
        name,
        content_type,
        import_origin,
        source_app,
    } = payload;

    let import_origin = normalize_optional(import_origin);
    let source_app = normalize_optional(source_app);
    let provided_name = normalize_optional(name);
    let provided_content_type = normalize_optional(content_type);
    let kind = kind.to_lowercase();

    match kind.as_str() {
        "text" => {
            let content = text.unwrap_or_default();
            if content.trim().is_empty() {
                return Ok(None);
            }

            create_import_entry(
                conn,
                NewEntry {
                    id: Uuid::new_v4().to_string(),
                    content,
                    html_content,
                    source: source.to_string(),
                    source_app,
                    created_at: now_ms(),
                    collection_id: Some("notes".to_string()),
                    is_note: true,
                    import_origin,
                    import_name: provided_name,
                    content_type: provided_content_type.or_else(|| Some("text/plain".to_string())),
                    attachment_rel_path: None,
                    attachment_size_bytes: None,
                    attachment_sha256: None,
                },
            )
            .map(Some)
        }
        "file" => {
            let source_path = path.as_ref().map(PathBuf::from);
            let file_name = provided_name.or_else(|| {
                source_path
                    .as_ref()
                    .and_then(|path| file_name_from_path(path.as_path()))
            });
            let content_type = provided_content_type.clone().or_else(|| {
                infer_content_type_for_import(source_path.as_deref(), file_name.as_deref())
            });
            let bytes = if let Some(path) = source_path.as_ref() {
                std::fs::read(path).map_err(|e| e.to_string())?
            } else if let Some(encoded) = file_bytes_base64 {
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|e| e.to_string())?
            } else {
                return Err("File import payload is missing path or bytes".to_string());
            };

            if is_text_like(
                content_type.as_deref(),
                source_path.as_deref(),
                file_name.as_deref(),
            ) {
                if let Some(text) = decode_text_bytes(&bytes) {
                    if !text.trim().is_empty() {
                        return create_import_entry(
                            conn,
                            NewEntry {
                                id: Uuid::new_v4().to_string(),
                                content: text,
                                html_content: None,
                                source: source.to_string(),
                                source_app,
                                created_at: now_ms(),
                                collection_id: Some("notes".to_string()),
                                is_note: true,
                                import_origin,
                                import_name: file_name,
                                content_type,
                                attachment_rel_path: None,
                                attachment_size_bytes: None,
                                attachment_sha256: None,
                            },
                        )
                        .map(Some);
                    }
                }
            }

            let attachment = copy_attachment_bytes(
                &bytes,
                attachments_dir,
                source_path.as_deref(),
                file_name.as_deref(),
            )?;
            let attachment_name = file_name.or_else(|| {
                source_path
                    .as_ref()
                    .and_then(|path| file_name_from_path(path.as_path()))
            });
            let display_content = attachment_name
                .clone()
                .unwrap_or_else(|| "Imported attachment".to_string());

            create_import_entry(
                conn,
                NewEntry {
                    id: Uuid::new_v4().to_string(),
                    content: display_content,
                    html_content: None,
                    source: source.to_string(),
                    source_app,
                    created_at: now_ms(),
                    collection_id: Some("notes".to_string()),
                    is_note: true,
                    import_origin,
                    import_name: attachment_name,
                    content_type,
                    attachment_rel_path: Some(attachment.rel_path),
                    attachment_size_bytes: Some(attachment.size_bytes),
                    attachment_sha256: Some(attachment.sha256),
                },
            )
            .map(Some)
        }
        other => Err(format!("Unsupported import payload kind: {}", other)),
    }
}

fn create_import_entry(conn: &rusqlite::Connection, entry: NewEntry) -> Result<EntryRow, String> {
    db::insert_entry(conn, &entry)?;

    Ok(EntryRow {
        id: entry.id,
        content: entry.content,
        html_content: entry.html_content,
        source: entry.source,
        source_app: entry.source_app,
        created_at: entry.created_at,
        pinned: false,
        label: None,
        label_score: None,
        summary: None,
        tags_json: None,
        enrichment_tags: None,
        processing_diagnostics: None,
        manual_badges: None,
        secret_verdict: None,
        secret_type: None,
        secret_source: None,
        collection_id: entry.collection_id,
        checklist_completed: false,
        is_note: entry.is_note,
        import_origin: entry.import_origin,
        import_name: entry.import_name,
        content_type: entry.content_type,
        attachment_rel_path: entry.attachment_rel_path,
        attachment_size_bytes: entry.attachment_size_bytes,
        attachment_sha256: entry.attachment_sha256,
        collection_sort_order: None,
    })
}

fn copy_attachment_bytes(
    bytes: &[u8],
    attachments_dir: &Path,
    source_path: Option<&Path>,
    source_name: Option<&str>,
) -> Result<AttachmentInfo, String> {
    let extension = infer_extension(source_path, source_name);

    let mut input = std::io::Cursor::new(bytes);
    copy_attachment_stream(&mut input, attachments_dir, extension)
}

fn copy_attachment_stream<R: Read>(
    input: &mut R,
    attachments_dir: &Path,
    extension: String,
) -> Result<AttachmentInfo, String> {
    let relative_name = format!("{}{}", Uuid::new_v4(), extension);
    let relative_path = Path::new("attachments").join(&relative_name);
    let destination = attachments_dir.join(&relative_name);
    let mut output = File::create(&destination).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut size_bytes: i64 = 0;
    let mut buffer = [0u8; 8192];

    loop {
        let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|e| e.to_string())?;
        size_bytes += read as i64;
    }

    Ok(AttachmentInfo {
        rel_path: relative_path.to_string_lossy().replace('\\', "/"),
        size_bytes,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn infer_kind(payload: &ImportPayload) -> String {
    if payload
        .text
        .as_ref()
        .is_some_and(|text| !text.trim().is_empty())
    {
        "text".to_string()
    } else if payload.path.is_some() || payload.file_bytes_base64.is_some() {
        "file".to_string()
    } else {
        "file".to_string()
    }
}

fn file_name_from_path(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(|name| name.to_string())
}

fn infer_extension(path: Option<&Path>, file_name: Option<&str>) -> String {
    path.and_then(extension_from_path)
        .or_else(|| file_name.and_then(extension_from_name))
        .unwrap_or_default()
}

fn extension_from_path(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| format!(".{}", ext))
}

fn extension_from_name(file_name: &str) -> Option<String> {
    Path::new(file_name)
        .extension()
        .and_then(OsStr::to_str)
        .map(|ext| format!(".{}", ext))
}

fn infer_content_type_for_import(path: Option<&Path>, file_name: Option<&str>) -> Option<String> {
    path.and_then(infer_content_type)
        .or_else(|| file_name.and_then(infer_content_type_from_name))
}

fn infer_content_type_from_name(file_name: &str) -> Option<String> {
    infer_content_type(Path::new(file_name))
}

fn infer_content_type(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let content_type = match extension.as_str() {
        "txt" | "md" | "log" | "ini" => "text/plain",
        "rs" => "text/rust",
        "ts" => "text/typescript",
        "tsx" => "text/tsx",
        "js" => "text/javascript",
        "jsx" => "text/jsx",
        "json" => "application/json",
        "toml" => "application/toml",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "sh" => "application/x-sh",
        "ps1" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => return None,
    };

    Some(content_type.to_string())
}

fn is_text_like(content_type: Option<&str>, path: Option<&Path>, file_name: Option<&str>) -> bool {
    let is_text_content_type = |content_type: &str| {
        content_type.starts_with("text/")
            || matches!(
                content_type,
                "application/json"
                    | "application/xml"
                    | "application/yaml"
                    | "application/toml"
                    | "application/javascript"
                    | "application/x-sh"
            )
    };

    if let Some(content_type) = content_type {
        let normalized = content_type.trim().to_ascii_lowercase();
        if is_text_content_type(normalized.as_str()) {
            return true;
        }
    }

    infer_content_type_for_import(path, file_name)
        .as_deref()
        .is_some_and(is_text_content_type)
}

fn decode_text_bytes(bytes: &[u8]) -> Option<String> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec()).ok()
}

fn now_ms() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    now.as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::{
        decode_text_bytes, extension_from_name, infer_content_type, infer_content_type_for_import,
        is_text_like,
    };
    use std::path::Path;

    #[test]
    fn decodes_utf8_with_bom() {
        let decoded = decode_text_bytes(&[0xEF, 0xBB, 0xBF, b'h', b'i']).unwrap();
        assert_eq!(decoded, "hi");
    }

    #[test]
    fn rejects_invalid_utf8() {
        assert!(decode_text_bytes(&[0xff, 0xfe, 0xfd]).is_none());
    }

    #[test]
    fn infers_text_and_binary_content_types() {
        assert_eq!(
            infer_content_type(Path::new("note.md")).as_deref(),
            Some("text/plain")
        );
        assert_eq!(
            infer_content_type(Path::new("image.png")).as_deref(),
            Some("image/png")
        );
    }

    #[test]
    fn treats_common_text_inputs_as_text_like() {
        assert!(is_text_like(
            Some("text/plain"),
            Some(Path::new("note.txt")),
            None,
        ));
        assert!(is_text_like(
            Some("application/json"),
            Some(Path::new("data.json")),
            None,
        ));
        assert!(!is_text_like(
            Some("image/png"),
            Some(Path::new("image.png")),
            None,
        ));
    }

    #[test]
    fn falls_back_to_file_name_for_text_detection() {
        assert_eq!(
            infer_content_type_for_import(None, Some("notes.md")).as_deref(),
            Some("text/plain")
        );
        assert!(is_text_like(None, None, Some("notes.txt")));
    }

    #[test]
    fn preserves_extension_from_browser_file_name() {
        assert_eq!(
            extension_from_name("archive.tar.gz").as_deref(),
            Some(".gz")
        );
        assert_eq!(extension_from_name("README").as_deref(), None);
    }
}
