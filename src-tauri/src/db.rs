use crate::{search, storage};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use uuid::Uuid;

const NOTES_COLLECTION_ID: &str = "notes";
const TODO_COLLECTION_ID: &str = "todo";
const SHOPPING_LIST_COLLECTION_ID: &str = "shopping-list";

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CollectionType {
    Standard,
    Checklist,
    Filter,
}

impl CollectionType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Checklist => "checklist",
            Self::Filter => "filter",
        }
    }

    fn from_str(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "standard" => Ok(Self::Standard),
            "checklist" => Ok(Self::Checklist),
            "filter" => Ok(Self::Filter),
            other => Err(format!("Unsupported collection type: {}", other)),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EntryRow {
    pub id: String, // UUID
    pub content: String,
    pub html_content: Option<String>,
    pub source: String,
    pub source_app: Option<String>,
    pub created_at: i64,
    pub pinned: bool,
    pub label: Option<String>,
    pub label_score: Option<f64>,
    pub summary: Option<String>,
    pub tags_json: Option<String>,       // unified tags JSON array
    pub enrichment_tags: Option<String>, // JSON string array
    pub processing_diagnostics: Option<String>, // versioned JSON blob
    pub manual_badges: Option<String>,   // JSON string array
    pub secret_verdict: Option<String>,  // "secret" | "likely_secret" | "not_secret"
    pub secret_type: Option<String>, // "api_key" | "password" | "token" | "private_key" | "unknown"
    pub secret_source: Option<String>, // "trufflehog" | "secret_masker" | "both"
    pub collection_id: Option<String>,
    pub checklist_completed: bool,
    pub is_note: bool,
    pub import_origin: Option<String>,
    pub import_name: Option<String>,
    pub content_type: Option<String>,
    pub attachment_rel_path: Option<String>,
    pub attachment_size_bytes: Option<i64>,
    pub attachment_sha256: Option<String>,
    pub collection_sort_order: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct NewEntry {
    pub id: String,
    pub content: String,
    pub html_content: Option<String>,
    pub source: String,
    pub source_app: Option<String>,
    pub created_at: i64,
    pub collection_id: Option<String>,
    pub is_note: bool,
    pub import_origin: Option<String>,
    pub import_name: Option<String>,
    pub content_type: Option<String>,
    pub attachment_rel_path: Option<String>,
    pub attachment_size_bytes: Option<i64>,
    pub attachment_sha256: Option<String>,
}

pub struct DbState {
    pub conn: Mutex<Option<Connection>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct CollectionRow {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub icon: Option<String>,
    pub collection_type: String,
    pub filter_query: Option<String>,
    pub kind: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub(crate) const ENTRY_SELECT_COLUMNS: [&str; 27] = [
    "id",
    "content",
    "html_content",
    "source",
    "source_app",
    "created_at",
    "pinned",
    "label",
    "label_score",
    "summary",
    "tags_json",
    "enrichment_tags",
    "processing_diagnostics",
    "manual_badges",
    "secret_verdict",
    "secret_type",
    "secret_source",
    "collection_id",
    "checklist_completed",
    "is_note",
    "import_origin",
    "import_name",
    "content_type",
    "attachment_rel_path",
    "attachment_size_bytes",
    "attachment_sha256",
    "collection_sort_order",
];

pub(crate) fn entry_select_columns_with_prefix(prefix: &str) -> String {
    ENTRY_SELECT_COLUMNS
        .iter()
        .map(|column| format!("{}.{}", prefix, column))
        .collect::<Vec<_>>()
        .join(", ")
}

impl Default for DbState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ManualBadge {
    name: String,
    color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct EntryTagRecord {
    id: String,
    name: String,
    source: String,
    kind: String,
    created_at: i64,
    confidence: Option<f64>,
    provider: Option<String>,
    model: Option<String>,
    color: Option<String>,
}

#[tauri::command]
pub fn db_init(app: AppHandle, state: State<DbState>) -> Result<(), String> {
    let storage_paths = storage::bootstrap(&app)?;
    let path = storage_paths.db_path;

    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    ensure_db_schema(&conn)?;

    search::ensure_search_schema(&conn)?;
    search::rebuild_all_search_indexes(&conn)?;

    // Create sqlite-vec virtual table for efficient vector search
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
            entry_id TEXT PRIMARY KEY,
            embedding float[384] distance_metric=cosine
        );",
    )
    .map_err(|e| format!("Failed to create vec_entries: {}", e))?;

    *state.conn.lock().map_err(|e| e.to_string())? = Some(conn);
    Ok(())
}

#[tauri::command]
pub fn db_add_entry(
    state: State<DbState>,
    content: String,
    html_content: Option<String>,
    source: String,
    source_app: Option<String>,
    created_at: i64,
) -> Result<String, String> {
    let source = normalize_entry_source(&source)?;
    let id = Uuid::new_v4().to_string();
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;

    let entry = NewEntry {
        id: id.clone(),
        content,
        html_content,
        source,
        source_app,
        created_at,
        collection_id: None,
        is_note: false,
        import_origin: None,
        import_name: None,
        content_type: None,
        attachment_rel_path: None,
        attachment_size_bytes: None,
        attachment_sha256: None,
    };

    insert_entry(conn, &entry)?;
    Ok(id)
}

#[tauri::command]
pub fn db_list_entries(
    state: State<DbState>,
    search: Option<String>,
    limit: i64,
    is_note: Option<bool>,
) -> Result<Vec<EntryRow>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;

    db_list_entries_internal(conn, search, limit, is_note)
}

fn db_list_entries_internal(
    conn: &Connection,
    search: Option<String>,
    limit: i64,
    is_note: Option<bool>,
) -> Result<Vec<EntryRow>, String> {
    let mut conditions = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(q) = search.filter(|s| !s.trim().is_empty()) {
        let pattern = format!("%{}%", q.trim());
        conditions.push(
            "(content LIKE ? OR label LIKE ? OR manual_badges LIKE ? OR tags_json LIKE ?)"
                .to_string(),
        );
        param_values.push(Box::new(pattern.clone()));
        param_values.push(Box::new(pattern.clone()));
        param_values.push(Box::new(pattern));
        param_values.push(Box::new(format!("%{}%", q.trim())));
    }

    if let Some(note) = is_note {
        conditions.push("is_note = ?".to_string());
        param_values.push(Box::new(if note { 1i64 } else { 0i64 }));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };

    param_values.push(Box::new(limit));

    let sql = format!(
        "SELECT {} FROM entries{} ORDER BY pinned DESC, created_at DESC LIMIT ?",
        entry_select_columns_with_prefix("entries"),
        where_clause
    );

    let params_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_refs.as_slice(), row_to_entry)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn db_list_all_badges(state: State<DbState>) -> Result<Vec<String>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;

    let mut stmt = conn
        .prepare("SELECT manual_badges FROM entries WHERE manual_badges IS NOT NULL")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    let mut unique_badges = std::collections::HashSet::new();

    for json_result in rows {
        if let Ok(json) = json_result {
            // Try new format first (array of objects)
            if let Ok(badges) = serde_json::from_str::<Vec<ManualBadge>>(&json) {
                for badge in badges {
                    unique_badges.insert(badge.name);
                }
            } else if let Ok(names) = serde_json::from_str::<Vec<String>>(&json) {
                // Fall back to old format (array of strings)
                for name in names {
                    unique_badges.insert(normalize_badge(&name));
                }
            }
        }
    }

    let mut result: Vec<String> = unique_badges.into_iter().collect();
    result.sort();
    Ok(result)
}

#[tauri::command]
pub fn db_set_entry_pinned(state: State<DbState>, id: String, pinned: bool) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;

    conn.execute(
        "UPDATE entries SET pinned = ?1 WHERE id = ?2",
        params![if pinned { 1i64 } else { 0i64 }, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn db_update_entry_classification(
    state: State<DbState>,
    id: String,
    label: String,
    label_score: f64,
    embedding: String,
) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute(
        "UPDATE entries SET label = ?1, label_score = ?2 WHERE id = ?3",
        params![label, label_score, id],
    )
    .map_err(|e| e.to_string())?;

    // Store in vec_entries for efficient vector search
    if let Ok(floats) = serde_json::from_str::<Vec<f32>>(&embedding) {
        if floats.len() == 384 {
            let bytes: Vec<u8> = floats.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "DELETE FROM vec_entries WHERE entry_id = ?1",
                rusqlite::params![id],
            )
            .ok(); // ignore if not exists
            conn.execute(
                "INSERT INTO vec_entries(entry_id, embedding) VALUES (?1, ?2)",
                rusqlite::params![id, bytes],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    search::sync_entry_search_data(conn, &id)?;
    Ok(())
}

#[tauri::command]
pub fn db_update_entry_embedding(
    state: State<DbState>,
    id: String,
    embedding: String,
) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;

    if let Ok(floats) = serde_json::from_str::<Vec<f32>>(&embedding) {
        if floats.len() == 384 {
            let bytes: Vec<u8> = floats.iter().flat_map(|f| f.to_le_bytes()).collect();
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

    Ok(())
}

#[tauri::command]
pub fn db_delete_entry(state: State<DbState>, id: String) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute("DELETE FROM entries WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM vec_entries WHERE entry_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    search::remove_entry_search_data(conn, &id)?;
    Ok(())
}

#[tauri::command]
pub fn db_delete_entries(state: State<DbState>, ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for id in &ids {
        tx.execute("DELETE FROM entries WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM vec_entries WHERE entry_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        search::remove_entry_search_data(&tx, id)?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_clear_entry_label(state: State<DbState>, id: String) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    let mut tags = load_entry_tags(conn, &id)?;
    tags.retain(|tag| tag.kind != "classification");
    sync_legacy_tag_fields(conn, &id, &tags)?;
    search::sync_entry_search_data(conn, &id)?;
    Ok(())
}

#[tauri::command]
pub fn db_remove_entry_tag(
    state: State<DbState>,
    id: String,
    tag_id: String,
) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    let mut tags = load_entry_tags(conn, &id)?;
    tags.retain(|tag| tag.id != tag_id);
    sync_legacy_tag_fields(conn, &id, &tags)?;
    search::sync_entry_search_data(conn, &id)?;
    Ok(())
}

#[tauri::command]
pub fn db_replace_generated_tags(
    state: State<DbState>,
    id: String,
    tags_json: String,
) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    let mut tags = load_entry_tags(conn, &id)?;
    tags.retain(|tag| tag.source == "manual");
    let mut generated =
        serde_json::from_str::<Vec<EntryTagRecord>>(&tags_json).map_err(|e| e.to_string())?;
    tags.append(&mut generated);
    sync_legacy_tag_fields(conn, &id, &tags)?;
    search::sync_entry_search_data(conn, &id)?;
    Ok(())
}

#[tauri::command]
pub fn db_add_manual_badge(
    state: State<DbState>,
    id: String,
    badge: String,
    color: String,
) -> Result<(), String> {
    let normalized = normalize_badge(&badge);
    if normalized.is_empty() {
        return Ok(());
    }

    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    let mut tags = load_entry_tags(conn, &id)?;

    if tags
        .iter()
        .any(|existing| existing.name == normalized && existing.source == "manual")
    {
        return Ok(());
    }

    tags.push(EntryTagRecord {
        id: Uuid::new_v4().to_string(),
        name: normalized,
        source: "manual".to_string(),
        kind: "manual".to_string(),
        created_at: current_time_ms(),
        confidence: None,
        provider: None,
        model: None,
        color: Some(color),
    });
    sync_legacy_tag_fields(conn, &id, &tags)?;
    search::sync_entry_search_data(conn, &id)?;
    Ok(())
}

#[tauri::command]
pub fn db_add_manual_badge_bulk(
    state: State<DbState>,
    ids: Vec<String>,
    badge: String,
    color: String,
) -> Result<(), String> {
    let normalized = normalize_badge(&badge);
    if normalized.is_empty() || ids.is_empty() {
        return Ok(());
    }

    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for id in &ids {
        let mut tags = load_entry_tags(&tx, id)?;
        if tags
            .iter()
            .any(|existing| existing.name == normalized && existing.source == "manual")
        {
            continue;
        }

        tags.push(EntryTagRecord {
            id: Uuid::new_v4().to_string(),
            name: normalized.clone(),
            source: "manual".to_string(),
            kind: "manual".to_string(),
            created_at: current_time_ms(),
            confidence: None,
            provider: None,
            model: None,
            color: Some(color.clone()),
        });
        sync_legacy_tag_fields(&tx, id, &tags)?;
        search::sync_entry_search_data(&tx, id)?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_remove_manual_badge(
    state: State<DbState>,
    id: String,
    badge: String,
) -> Result<(), String> {
    let normalized = normalize_badge(&badge);
    if normalized.is_empty() {
        return Ok(());
    }

    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    let mut tags = load_entry_tags(conn, &id)?;
    tags.retain(|existing| !(existing.source == "manual" && existing.name == normalized));
    sync_legacy_tag_fields(conn, &id, &tags)?;
    search::sync_entry_search_data(conn, &id)?;
    Ok(())
}

#[tauri::command]
pub fn db_update_entry_secret(
    state: State<DbState>,
    id: String,
    secret_verdict: String,
    secret_type: String,
    secret_source: String,
) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute(
        "UPDATE entries SET secret_verdict = ?1, secret_type = ?2, secret_source = ?3 WHERE id = ?4",
        params![secret_verdict, secret_type, secret_source, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_update_entry_enrichment(
    state: State<DbState>,
    id: String,
    summary: Option<String>,
    enrichment_tags: Option<String>,
) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute(
        "UPDATE entries SET summary = ?1, enrichment_tags = ?2 WHERE id = ?3",
        params![
            normalize_optional_text(summary),
            normalize_optional_text(enrichment_tags),
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_update_entry_processing_diagnostics(
    state: State<DbState>,
    id: String,
    processing_diagnostics: Option<String>,
) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute(
        "UPDATE entries SET processing_diagnostics = ?1 WHERE id = ?2",
        params![normalize_optional_text(processing_diagnostics), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_set_secret_verdict_bulk(
    state: State<DbState>,
    ids: Vec<String>,
    secret_verdict: String,
    secret_type: String,
    secret_source: String,
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for id in &ids {
        tx.execute(
            "UPDATE entries SET secret_verdict = ?1, secret_type = ?2, secret_source = ?3 WHERE id = ?4",
            params![&secret_verdict, &secret_type, &secret_source, id],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_promote_to_note(state: State<DbState>, id: String) -> Result<(), String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let sort_order = next_entry_collection_sort_order(&tx, NOTES_COLLECTION_ID)?;
    tx.execute(
        "UPDATE entries SET is_note = 1, collection_id = ?1, collection_sort_order = ?2 WHERE id = ?3",
        params![NOTES_COLLECTION_ID, sort_order, id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_demote_from_note(state: State<DbState>, id: String) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute(
        "UPDATE entries SET is_note = 0, collection_id = CASE WHEN collection_id = ?1 THEN NULL ELSE collection_id END, collection_sort_order = CASE WHEN collection_id = ?1 THEN NULL ELSE collection_sort_order END WHERE id = ?2",
        params![NOTES_COLLECTION_ID, id],
    )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_list_collections(state: State<DbState>) -> Result<Vec<CollectionRow>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    list_collections(conn)
}

#[tauri::command]
pub fn db_create_collection(
    state: State<DbState>,
    name: String,
    icon: Option<String>,
    collection_type: CollectionType,
    filter_query: Option<String>,
) -> Result<CollectionRow, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Collection name cannot be empty".to_string());
    }

    let normalized_icon = normalize_optional_collection_icon(icon)?;
    let normalized_filter_query = normalize_optional_filter_query(filter_query);

    if collection_type == CollectionType::Filter && normalized_filter_query.is_none() {
        return Err("Filter collections require an active filter query".to_string());
    }

    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let collection = create_user_collection(
        &tx,
        trimmed_name,
        normalized_icon,
        collection_type,
        normalized_filter_query,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(collection)
}

#[tauri::command]
pub fn db_set_entry_checklist_completed(
    state: State<DbState>,
    id: String,
    checklist_completed: bool,
) -> Result<(), String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    set_entry_checklist_completed(&tx, &id, checklist_completed)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_list_collection_entries(
    state: State<DbState>,
    collection_id: String,
    limit: i64,
) -> Result<Vec<EntryRow>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    ensure_collection_exists(conn, &collection_id)?;
    list_collection_entries(conn, &collection_id, Some(limit))
}

#[tauri::command]
pub fn db_reorder_collection_entry(
    state: State<DbState>,
    collection_id: String,
    entry_id: String,
    target_entry_id: String,
    position: String,
) -> Result<(), String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    reorder_collection_entry(&tx, &collection_id, &entry_id, &target_entry_id, &position)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_reorder_collection(
    state: State<DbState>,
    collection_id: String,
    target_collection_id: String,
    position: String,
) -> Result<(), String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    reorder_collection(&tx, &collection_id, &target_collection_id, &position)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_update_collection_type(
    state: State<DbState>,
    id: String,
    collection_type: CollectionType,
    filter_query: Option<String>,
) -> Result<(), String> {
    let now = current_time_ms();
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;

    set_collection_type(
        conn,
        &id,
        collection_type,
        normalize_optional_filter_query(filter_query),
        now,
    )
}

#[tauri::command]
pub fn db_rename_collection(
    state: State<DbState>,
    id: String,
    name: String,
) -> Result<CollectionRow, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Collection name cannot be empty".to_string());
    }

    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let renamed = rename_collection(&tx, &id, trimmed_name)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(renamed)
}

#[tauri::command]
pub fn db_duplicate_collection(state: State<DbState>, id: String) -> Result<CollectionRow, String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let duplicated = duplicate_collection(&tx, &id)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(duplicated)
}

#[tauri::command]
pub fn db_delete_collection(
    state: State<DbState>,
    id: String,
    move_entries_to_collection_id: Option<String>,
) -> Result<(), String> {
    let move_entries_to_collection_id =
        normalize_optional_collection_id(move_entries_to_collection_id);

    if move_entries_to_collection_id.as_deref() == Some(id.as_str()) {
        return Err("Cannot move entries into the collection being deleted".to_string());
    }

    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    ensure_collection_can_be_deleted(&tx, &id)?;
    if let Some(destination_id) = move_entries_to_collection_id.as_deref() {
        ensure_collection_exists(&tx, destination_id)?;
    }

    let entry_ids = list_collection_entry_ids(&tx, &id)?;

    tx.execute(
        "UPDATE entries SET collection_id = NULL, is_note = 0, collection_sort_order = NULL WHERE collection_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;

    if let Some(destination_id) = move_entries_to_collection_id.as_deref() {
        let destination_is_note = destination_id == NOTES_COLLECTION_ID;
        let mut next_sort_order = next_entry_collection_sort_order(&tx, destination_id)?;
        for entry_id in entry_ids {
            tx.execute(
                "UPDATE entries SET collection_id = ?1, is_note = ?2, collection_sort_order = ?3 WHERE id = ?4",
                params![
                    destination_id,
                    if destination_is_note { 1i64 } else { 0i64 },
                    next_sort_order,
                    entry_id,
                ],
            )
            .map_err(|e| e.to_string())?;
            next_sort_order += 1;
        }
    }

    tx.execute("DELETE FROM collections WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_copy_entries_to_collection(
    state: State<DbState>,
    ids: Vec<String>,
    collection_id: Option<String>,
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let normalized_collection_id = normalize_optional_collection_id(collection_id);

    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    if let Some(collection_id) = normalized_collection_id.as_deref() {
        ensure_collection_can_accept_entries(&tx, collection_id)?;
    }

    for id in &ids {
        duplicate_entry_to_collection(&tx, id, normalized_collection_id.as_deref())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_move_entries_to_collection(
    state: State<DbState>,
    ids: Vec<String>,
    collection_id: Option<String>,
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let normalized_collection_id = normalize_optional_collection_id(collection_id);

    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or("DB not initialised")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    if let Some(collection_id) = normalized_collection_id.as_deref() {
        ensure_collection_can_accept_entries(&tx, collection_id)?;
    }

    let is_note = matches!(
        normalized_collection_id.as_deref(),
        Some(NOTES_COLLECTION_ID)
    );
    let mut next_sort_order = normalized_collection_id
        .as_deref()
        .map(|collection_id| next_entry_collection_sort_order(&tx, collection_id))
        .transpose()?
        .unwrap_or(0);
    for id in &ids {
        tx.execute(
            "UPDATE entries SET collection_id = ?1, is_note = ?2, collection_sort_order = ?3 WHERE id = ?4",
            params![
                normalized_collection_id.as_deref(),
                if is_note { 1i64 } else { 0i64 },
                if normalized_collection_id.is_some() {
                    Some(next_sort_order)
                } else {
                    None
                },
                id
            ],
        )
        .map_err(|e| e.to_string())?;
        search::sync_entry_search_data(&tx, id)?;
        if normalized_collection_id.is_some() {
            next_sort_order += 1;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_get_entry_embedding(
    state: State<DbState>,
    id: String,
) -> Result<Option<Vec<f32>>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    let result: Option<Vec<u8>> = conn
        .query_row(
            "SELECT embedding FROM vec_entries WHERE entry_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .ok();
    match result {
        Some(bytes) => {
            let floats: Vec<f32> = bytes
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            Ok(Some(floats))
        }
        None => Ok(None),
    }
}

pub(crate) fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<EntryRow> {
    Ok(EntryRow {
        id: row.get(0)?,
        content: row.get(1)?,
        html_content: row.get(2)?,
        source: row.get(3)?,
        source_app: row.get(4)?,
        created_at: row.get(5)?,
        pinned: row.get::<_, i64>(6)? != 0,
        label: row.get(7)?,
        label_score: row.get(8)?,
        summary: row.get(9)?,
        tags_json: row.get(10)?,
        enrichment_tags: row.get(11)?,
        processing_diagnostics: row.get(12)?,
        manual_badges: row.get(13)?,
        secret_verdict: row.get(14)?,
        secret_type: row.get(15)?,
        secret_source: row.get(16)?,
        collection_id: row.get(17)?,
        checklist_completed: row.get::<_, i64>(18)? != 0,
        is_note: row.get::<_, i64>(19)? != 0,
        import_origin: row.get(20)?,
        import_name: row.get(21)?,
        content_type: row.get(22)?,
        attachment_rel_path: row.get(23)?,
        attachment_size_bytes: row.get(24)?,
        attachment_sha256: row.get(25)?,
        collection_sort_order: row.get(26)?,
    })
}

pub fn normalize_entry_source(source: &str) -> Result<String, String> {
    match source.trim().to_lowercase().as_str() {
        "clipboard" => Ok("clipboard".to_string()),
        "manual" => Ok("manual".to_string()),
        "import" => Ok("import".to_string()),
        other => Err(format!("Unsupported entry source: {}", other)),
    }
}

pub fn insert_entry(conn: &Connection, entry: &NewEntry) -> Result<(), String> {
    let effective_collection_id =
        canonicalize_collection_id(entry.collection_id.clone(), entry.is_note);
    let effective_is_note = matches!(
        effective_collection_id.as_deref(),
        Some(NOTES_COLLECTION_ID)
    );
    let collection_sort_order = effective_collection_id
        .as_deref()
        .map(|collection_id| next_entry_collection_sort_order(conn, collection_id))
        .transpose()?;

    conn.execute(
        "INSERT INTO entries (
            id,
            content,
            html_content,
            source,
            source_app,
            created_at,
            collection_id,
            checklist_completed,
            is_note,
            import_origin,
            import_name,
            content_type,
            attachment_rel_path,
            attachment_size_bytes,
            attachment_sha256,
            collection_sort_order
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            entry.id,
            entry.content,
            entry.html_content,
            entry.source,
            entry.source_app,
            entry.created_at,
            effective_collection_id,
            if effective_is_note { 1i64 } else { 0i64 },
            entry.import_origin,
            entry.import_name,
            entry.content_type,
            entry.attachment_rel_path,
            entry.attachment_size_bytes,
            entry.attachment_sha256,
            collection_sort_order,
        ],
    )
    .map_err(|e| e.to_string())?;

    search::sync_entry_search_data(conn, &entry.id)?;

    Ok(())
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_optional_filter_query(value: Option<String>) -> Option<String> {
    normalize_optional_text(value)
}

fn normalize_badge(badge: &str) -> String {
    badge.trim().to_lowercase()
}

fn normalize_tag_name(tag: &str) -> String {
    tag.trim().to_lowercase()
}

fn load_entry_tags(conn: &Connection, id: &str) -> Result<Vec<EntryTagRecord>, String> {
    let raw = conn
        .query_row(
            "SELECT tags_json FROM entries WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| e.to_string())?;

    match raw {
        Some(json) => serde_json::from_str::<Vec<EntryTagRecord>>(&json).map_err(|e| e.to_string()),
        None => Ok(Vec::new()),
    }
}

fn serialize_entry_tags(tags: &[EntryTagRecord]) -> Result<Option<String>, String> {
    if tags.is_empty() {
        Ok(None)
    } else {
        serde_json::to_string(tags)
            .map(Some)
            .map_err(|e| e.to_string())
    }
}

fn sync_legacy_tag_fields(
    conn: &Connection,
    id: &str,
    tags: &[EntryTagRecord],
) -> Result<(), String> {
    let classification = tags
        .iter()
        .find(|tag| tag.kind == "classification")
        .cloned();
    let manual_badges = tags
        .iter()
        .filter(|tag| tag.source == "manual")
        .map(|tag| ManualBadge {
            name: tag.name.clone(),
            color: tag.color.clone().unwrap_or_else(|| "default".to_string()),
        })
        .collect::<Vec<_>>();
    let enrichment_tags = tags
        .iter()
        .filter(|tag| tag.kind == "enrichment")
        .map(|tag| tag.name.clone())
        .collect::<Vec<_>>();

    conn.execute(
        "UPDATE entries SET label = ?1, label_score = ?2, manual_badges = ?3, enrichment_tags = ?4, tags_json = ?5 WHERE id = ?6",
        params![
            classification.as_ref().map(|tag| tag.name.clone()),
            classification.as_ref().and_then(|tag| tag.confidence),
            serialize_manual_badges(&manual_badges)?,
            if enrichment_tags.is_empty() {
                None::<String>
            } else {
                Some(serde_json::to_string(&enrichment_tags).map_err(|e| e.to_string())?)
            },
            serialize_entry_tags(tags)?,
            id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn build_legacy_tags_from_entry_row(entry: &EntryRow) -> Vec<EntryTagRecord> {
    let mut tags = Vec::new();
    let diagnostics = entry
        .processing_diagnostics
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let now = entry.created_at;

    if let Some(label) = entry.label.as_deref() {
        if !label.trim().is_empty() && label != "other" {
            let heuristic_label = diagnostics
                .as_ref()
                .and_then(|diag| diag.get("classification"))
                .and_then(|value| value.get("heuristic_label"))
                .and_then(|value| value.as_str());
            tags.push(EntryTagRecord {
                id: Uuid::new_v4().to_string(),
                name: normalize_tag_name(label),
                source: if heuristic_label == Some(label) {
                    "heuristic"
                } else {
                    "ai"
                }
                .to_string(),
                kind: "classification".to_string(),
                created_at: now,
                confidence: entry.label_score,
                provider: None,
                model: None,
                color: None,
            });
        }
    }

    for badge in parse_manual_badges_from_raw(entry.manual_badges.as_deref()).unwrap_or_default() {
        tags.push(EntryTagRecord {
            id: Uuid::new_v4().to_string(),
            name: normalize_tag_name(&badge.name),
            source: "manual".to_string(),
            kind: "manual".to_string(),
            created_at: now,
            confidence: None,
            provider: None,
            model: None,
            color: Some(badge.color),
        });
    }

    let enrichment_source = diagnostics
        .as_ref()
        .and_then(|diag| diag.get("enrichment"))
        .and_then(|value| value.get("source"))
        .and_then(|value| value.as_str())
        .unwrap_or("ai");
    let enrichment_provider = diagnostics
        .as_ref()
        .and_then(|diag| diag.get("enrichment"))
        .and_then(|value| value.get("provider"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let enrichment_model = diagnostics
        .as_ref()
        .and_then(|diag| diag.get("enrichment"))
        .and_then(|value| value.get("model"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    for tag in parse_legacy_string_tags(entry.enrichment_tags.as_deref()) {
        tags.push(EntryTagRecord {
            id: Uuid::new_v4().to_string(),
            name: tag,
            source: if enrichment_source == "heuristic" {
                "heuristic"
            } else {
                "ai"
            }
            .to_string(),
            kind: "enrichment".to_string(),
            created_at: now,
            confidence: None,
            provider: enrichment_provider.clone(),
            model: enrichment_model.clone(),
            color: None,
        });
    }

    let trufflehog_detector = diagnostics
        .as_ref()
        .and_then(|diag| diag.get("secret_detection"))
        .and_then(|value| value.get("trufflehog"))
        .and_then(|value| value.get("matched"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if trufflehog_detector {
        let detector_name = diagnostics
            .as_ref()
            .and_then(|diag| diag.get("secret_detection"))
            .and_then(|value| value.get("trufflehog"))
            .and_then(|value| value.get("detector"))
            .and_then(|value| value.as_str())
            .unwrap_or("trufflehog");
        tags.push(EntryTagRecord {
            id: Uuid::new_v4().to_string(),
            name: normalize_tag_name(detector_name),
            source: "trufflehog".to_string(),
            kind: "detector".to_string(),
            created_at: now,
            confidence: None,
            provider: Some("trufflehog".to_string()),
            model: None,
            color: None,
        });
    }

    tags
}

fn parse_legacy_string_tags(raw: Option<&str>) -> Vec<String> {
    raw.and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|tag| normalize_tag_name(&tag))
        .filter(|tag| !tag.is_empty())
        .collect()
}

fn parse_manual_badges_from_raw(raw: Option<&str>) -> Result<Vec<ManualBadge>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if let Ok(badges) = serde_json::from_str::<Vec<ManualBadge>>(raw) {
        return Ok(badges);
    }
    if let Ok(names) = serde_json::from_str::<Vec<String>>(raw) {
        return Ok(names
            .into_iter()
            .map(|name| ManualBadge {
                name,
                color: "default".to_string(),
            })
            .collect());
    }
    Err(format!("Failed to parse manual_badges JSON: {}", raw))
}

fn load_manual_badges(conn: &Connection, id: &str) -> Result<Vec<ManualBadge>, String> {
    let manual_badges = conn
        .query_row(
            "SELECT manual_badges FROM entries WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| e.to_string())?;

    parse_manual_badges_from_raw(manual_badges.as_deref())
}

fn serialize_manual_badges(badges: &[ManualBadge]) -> Result<Option<String>, String> {
    if badges.is_empty() {
        Ok(None)
    } else {
        serde_json::to_string(badges)
            .map(Some)
            .map_err(|e| e.to_string())
    }
}

pub(crate) fn ensure_db_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS collections (
            id         TEXT PRIMARY KEY,
            slug       TEXT UNIQUE NOT NULL,
            name       TEXT NOT NULL,
            icon       TEXT,
            collection_type TEXT NOT NULL DEFAULT 'standard',
            filter_query TEXT,
            kind       TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_collections_sort_order ON collections(sort_order, created_at);
        CREATE INDEX IF NOT EXISTS idx_collections_kind_sort_order ON collections(kind, sort_order);
        CREATE TABLE IF NOT EXISTS entries (
            id             TEXT PRIMARY KEY,
            content        TEXT NOT NULL,
            html_content   TEXT,
            source         TEXT NOT NULL DEFAULT 'clipboard',
            source_app     TEXT,
            created_at     INTEGER NOT NULL,
            pinned         INTEGER NOT NULL DEFAULT 0,
            label          TEXT,
            label_score    REAL,
            summary        TEXT,
            tags_json      TEXT,
            enrichment_tags TEXT,
            processing_diagnostics TEXT,
            manual_badges  TEXT,
            secret_verdict TEXT,
            secret_type    TEXT,
            secret_source  TEXT,
            collection_id  TEXT,
            checklist_completed INTEGER NOT NULL DEFAULT 0,
            is_note        INTEGER NOT NULL DEFAULT 0,
            import_origin  TEXT,
            import_name    TEXT,
            content_type   TEXT,
            attachment_rel_path TEXT,
            attachment_size_bytes INTEGER,
            attachment_sha256 TEXT,
            collection_sort_order INTEGER
        );
        ",
    )
    .map_err(|e| e.to_string())?;

    let _ = conn.execute("ALTER TABLE entries ADD COLUMN secret_verdict TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN secret_type TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN secret_source TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN summary TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN tags_json TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN enrichment_tags TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE entries ADD COLUMN processing_diagnostics TEXT",
        [],
    );
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN manual_badges TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN collection_id TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE entries ADD COLUMN checklist_completed INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE entries ADD COLUMN is_note INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN import_origin TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN import_name TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN content_type TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE entries ADD COLUMN attachment_rel_path TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE entries ADD COLUMN attachment_size_bytes INTEGER",
        [],
    );
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN attachment_sha256 TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE entries ADD COLUMN collection_sort_order INTEGER",
        [],
    );

    let entries = db_list_entries_internal(conn, None, 1_000_000, None)?;
    for entry in entries {
        if entry.tags_json.is_some() {
            continue;
        }
        let tags = build_legacy_tags_from_entry_row(&entry);
        if !tags.is_empty() {
            sync_legacy_tag_fields(conn, &entry.id, &tags)?;
        }
    }
    let _ = conn.execute("ALTER TABLE collections ADD COLUMN icon TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE collections ADD COLUMN collection_type TEXT NOT NULL DEFAULT 'standard'",
        [],
    );
    let _ = conn.execute("ALTER TABLE collections ADD COLUMN filter_query TEXT", []);

    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_entries_pinned_created_at ON entries(pinned DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_entries_label ON entries(label);
        CREATE INDEX IF NOT EXISTS idx_entries_collection_id_created_at ON entries(collection_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_entries_collection_id ON entries(collection_id);
        ",
    )
    .map_err(|e| e.to_string())?;

    seed_default_collections(conn)?;
    backfill_note_collection_membership(conn)?;
    backfill_entry_collection_sort_order(conn)?;

    Ok(())
}

fn seed_default_collections(conn: &Connection) -> Result<(), String> {
    let now = current_time_ms();
    for (sort_order, id, name) in [
        (0i64, NOTES_COLLECTION_ID, "Notes"),
        (1i64, TODO_COLLECTION_ID, "Todo"),
        (2i64, SHOPPING_LIST_COLLECTION_ID, "Shopping List"),
    ] {
        let collection_type = match id {
            TODO_COLLECTION_ID | SHOPPING_LIST_COLLECTION_ID => CollectionType::Checklist,
            _ => CollectionType::Standard,
        };
        conn.execute(
            "INSERT INTO collections (id, slug, name, icon, collection_type, filter_query, kind, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4, NULL, 'system', ?5, ?6, ?6)
             ON CONFLICT(id) DO UPDATE SET
                  slug = excluded.slug,
                  name = excluded.name,
                  collection_type = excluded.collection_type,
                  filter_query = excluded.filter_query,
                  kind = excluded.kind,
                  sort_order = excluded.sort_order,
                  updated_at = excluded.updated_at",
            params![id, id, name, collection_type.as_str(), sort_order, now],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn backfill_note_collection_membership(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE entries
         SET collection_id = ?1
         WHERE is_note = 1 AND collection_id IS NULL",
        params![NOTES_COLLECTION_ID],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_collections(conn: &Connection) -> Result<Vec<CollectionRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, slug, name, icon, collection_type, filter_query, kind, sort_order, created_at, updated_at
             FROM collections
             ORDER BY sort_order ASC, created_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], row_to_collection)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

fn row_to_collection(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollectionRow> {
    Ok(CollectionRow {
        id: row.get(0)?,
        slug: row.get(1)?,
        name: row.get(2)?,
        icon: row.get(3)?,
        collection_type: row.get(4)?,
        filter_query: row.get(5)?,
        kind: row.get(6)?,
        sort_order: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn create_user_collection(
    conn: &Connection,
    name: &str,
    icon: Option<String>,
    collection_type: CollectionType,
    filter_query: Option<String>,
) -> Result<CollectionRow, String> {
    let now = current_time_ms();
    let id = Uuid::new_v4().to_string();
    let slug = next_collection_slug(conn, name)?;
    let sort_order = next_collection_sort_order(conn)?;

    conn.execute(
        "INSERT INTO collections (id, slug, name, icon, collection_type, filter_query, kind, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'user', ?7, ?8, ?8)",
        params![&id, &slug, name, &icon, collection_type.as_str(), &filter_query, sort_order, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(CollectionRow {
        id,
        slug,
        name: name.to_string(),
        icon,
        collection_type: collection_type.as_str().to_string(),
        filter_query,
        kind: "user".to_string(),
        sort_order,
        created_at: now,
        updated_at: now,
    })
}

fn get_collection(conn: &Connection, id: &str) -> Result<CollectionRow, String> {
    conn.query_row(
        "SELECT id, slug, name, icon, collection_type, filter_query, kind, sort_order, created_at, updated_at
         FROM collections
         WHERE id = ?1",
        params![id],
        row_to_collection,
    )
    .map_err(|e| e.to_string())
}

fn collection_name_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE name = ?1)",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(exists != 0)
}

fn next_duplicate_collection_name(conn: &Connection, source_name: &str) -> Result<String, String> {
    let trimmed_name = source_name.trim();
    let base_name = format!("{} (copy)", trimmed_name);
    if !collection_name_exists(conn, &base_name)? {
        return Ok(base_name);
    }

    let mut copy_index = 2;
    loop {
        let candidate = format!("{} (copy {})", trimmed_name, copy_index);
        if !collection_name_exists(conn, &candidate)? {
            return Ok(candidate);
        }
        copy_index += 1;
    }
}

fn duplicate_collection(conn: &Connection, id: &str) -> Result<CollectionRow, String> {
    let source = get_collection(conn, id)?;
    let duplicate_name = next_duplicate_collection_name(conn, &source.name)?;
    let collection_type = CollectionType::from_str(&source.collection_type)?;
    let duplicated = create_user_collection(
        conn,
        &duplicate_name,
        source.icon.clone(),
        collection_type,
        source.filter_query.clone(),
    )?;

    if collection_type == CollectionType::Filter {
        return Ok(duplicated);
    }

    let entry_ids = list_collection_entry_ids(conn, id)?;

    for entry_id in &entry_ids {
        duplicate_entry_to_collection(conn, entry_id, Some(&duplicated.id))?;
    }

    Ok(duplicated)
}

fn rename_collection(conn: &Connection, id: &str, name: &str) -> Result<CollectionRow, String> {
    ensure_collection_can_be_renamed(conn, id)?;

    let now = current_time_ms();
    let slug = next_collection_slug_for_update(conn, name, id)?;

    conn.execute(
        "UPDATE collections SET name = ?1, slug = ?2, updated_at = ?3 WHERE id = ?4",
        params![name, &slug, now, id],
    )
    .map_err(|e| e.to_string())?;

    if conn.changes() == 0 {
        return Err(format!("Collection not found: {}", id));
    }

    get_collection(conn, id)
}

fn set_collection_type(
    conn: &Connection,
    id: &str,
    collection_type: CollectionType,
    filter_query: Option<String>,
    updated_at: i64,
) -> Result<(), String> {
    if collection_type == CollectionType::Filter && filter_query.is_none() {
        return Err("Filter collections require an active filter query".to_string());
    }

    conn.execute(
        "UPDATE collections SET collection_type = ?1, filter_query = ?2, updated_at = ?3 WHERE id = ?4",
        params![collection_type.as_str(), filter_query, updated_at, id],
    )
    .map_err(|e| e.to_string())?;

    if conn.changes() == 0 {
        Err(format!("Collection not found: {}", id))
    } else {
        Ok(())
    }
}

fn ensure_collection_can_be_deleted(conn: &Connection, id: &str) -> Result<(), String> {
    ensure_collection_exists(conn, id)?;
    if id == NOTES_COLLECTION_ID {
        Err("Notes cannot be deleted".to_string())
    } else {
        Ok(())
    }
}

fn ensure_collection_can_be_renamed(conn: &Connection, id: &str) -> Result<(), String> {
    ensure_collection_exists(conn, id)?;
    if id == NOTES_COLLECTION_ID {
        Err("Notes cannot be renamed".to_string())
    } else {
        Ok(())
    }
}

fn ensure_collection_exists(conn: &Connection, id: &str) -> Result<(), String> {
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?1)",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;

    if exists == 0 {
        Err(format!("Collection not found: {}", id))
    } else {
        Ok(())
    }
}

fn ensure_collection_can_accept_entries(
    conn: &Connection,
    collection_id: &str,
) -> Result<(), String> {
    let collection = get_collection(conn, collection_id)?;
    if collection.collection_type == CollectionType::Filter.as_str() {
        Err("Filter collections cannot store copied or moved entries".to_string())
    } else {
        Ok(())
    }
}

fn duplicate_entry_to_collection(
    conn: &Connection,
    id: &str,
    collection_id: Option<&str>,
) -> Result<String, String> {
    let new_id = Uuid::new_v4().to_string();
    let is_note = matches!(collection_id, Some(NOTES_COLLECTION_ID));
    let collection_sort_order = collection_id
        .map(|collection_id| next_entry_collection_sort_order(conn, collection_id))
        .transpose()?;

    conn.execute(
        "INSERT INTO entries (
            id,
            content,
            html_content,
            source,
            source_app,
            created_at,
            label,
            label_score,
            summary,
            enrichment_tags,
            processing_diagnostics,
            manual_badges,
            secret_verdict,
            secret_type,
            secret_source,
            collection_id,
            checklist_completed,
            is_note,
            import_origin,
            import_name,
            content_type,
            attachment_rel_path,
            attachment_size_bytes,
            attachment_sha256,
            collection_sort_order
        )
        SELECT
            ?1,
            content,
            html_content,
            source,
            source_app,
            created_at,
            label,
            label_score,
            summary,
            enrichment_tags,
            processing_diagnostics,
            manual_badges,
            secret_verdict,
            secret_type,
            secret_source,
            ?2,
            checklist_completed,
            ?3,
            import_origin,
            import_name,
            content_type,
            attachment_rel_path,
            attachment_size_bytes,
            attachment_sha256,
            ?4
        FROM entries
        WHERE id = ?5",
        params![
            &new_id,
            collection_id,
            if is_note { 1i64 } else { 0i64 },
            collection_sort_order,
            id
        ],
    )
    .map_err(|e| e.to_string())?;

    if conn.changes() == 0 {
        return Err(format!("Entry not found: {}", id));
    }

    let embedding_bytes: Option<Vec<u8>> = conn
        .query_row(
            "SELECT embedding FROM vec_entries WHERE entry_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .ok();

    if let Some(embedding_bytes) = embedding_bytes {
        conn.execute(
            "INSERT INTO vec_entries(entry_id, embedding) VALUES (?1, ?2)",
            params![&new_id, embedding_bytes],
        )
        .map_err(|e| e.to_string())?;
    }

    search::sync_entry_search_data(conn, &new_id)?;
    Ok(new_id)
}

fn next_collection_sort_order(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn list_ordered_collection_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM collections ORDER BY sort_order ASC, created_at ASC, id ASC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

fn normalize_collection_sort_order(conn: &Connection) -> Result<(), String> {
    for (index, collection_id) in list_ordered_collection_ids(conn)?.into_iter().enumerate() {
        conn.execute(
            "UPDATE collections SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, collection_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn next_entry_collection_sort_order(conn: &Connection, collection_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(collection_sort_order), -1) + 1 FROM entries WHERE collection_id = ?1",
        params![collection_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn list_collection_entry_ids(
    conn: &Connection,
    collection_id: &str,
) -> Result<Vec<String>, String> {
    let order_clause = collection_entry_order_clause(conn, collection_id)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id FROM entries WHERE collection_id = ?1 ORDER BY {}",
            order_clause
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![collection_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

fn list_collection_entries(
    conn: &Connection,
    collection_id: &str,
    limit: Option<i64>,
) -> Result<Vec<EntryRow>, String> {
    let order_clause = collection_entry_order_clause(conn, collection_id)?;
    let mut sql = format!(
        "SELECT {} FROM entries e WHERE e.collection_id = ?1 ORDER BY {}",
        entry_select_columns_with_prefix("e"),
        order_clause,
    );

    if limit.is_some() {
        sql.push_str(" LIMIT ?2");
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = if let Some(limit) = limit {
        stmt.query_map(params![collection_id, limit], row_to_entry)
    } else {
        stmt.query_map(params![collection_id], row_to_entry)
    }
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;

    Ok(rows)
}

fn normalize_entry_collection_order(conn: &Connection, collection_id: &str) -> Result<(), String> {
    for (index, entry_id) in list_collection_entry_ids(conn, collection_id)?
        .into_iter()
        .enumerate()
    {
        conn.execute(
            "UPDATE entries SET collection_sort_order = ?1 WHERE id = ?2",
            params![index as i64, entry_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn collection_entry_order_clause(conn: &Connection, collection_id: &str) -> Result<String, String> {
    let collection = get_collection(conn, collection_id)?;
    Ok(
        if collection.collection_type == CollectionType::Checklist.as_str() {
            "checklist_completed ASC, collection_sort_order ASC, created_at ASC, id ASC".to_string()
        } else {
            "collection_sort_order ASC, created_at ASC, id ASC".to_string()
        },
    )
}

fn set_entry_checklist_completed(
    conn: &Connection,
    id: &str,
    checklist_completed: bool,
) -> Result<(), String> {
    let current_collection_id: Option<String> = conn
        .query_row(
            "SELECT collection_id FROM entries WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE entries SET checklist_completed = ?1 WHERE id = ?2",
        params![if checklist_completed { 1i64 } else { 0i64 }, id],
    )
    .map_err(|e| e.to_string())?;

    if let Some(collection_id) = current_collection_id.as_deref() {
        normalize_entry_collection_order(conn, collection_id)?;
    }

    Ok(())
}

fn reorder_collection_entry(
    conn: &Connection,
    collection_id: &str,
    entry_id: &str,
    target_entry_id: &str,
    position: &str,
) -> Result<(), String> {
    let collection = get_collection(conn, collection_id)?;

    let position = position.trim().to_ascii_lowercase();
    if position != "before" && position != "after" {
        return Err("Position must be 'before' or 'after'".to_string());
    }

    let entries = list_collection_entries(conn, collection_id, None)?;
    let source = entries
        .iter()
        .find(|entry| entry.id == entry_id)
        .ok_or_else(|| format!("Entry not found in collection: {}", entry_id))?;
    let target = entries
        .iter()
        .find(|entry| entry.id == target_entry_id)
        .ok_or_else(|| format!("Target entry not found in collection: {}", target_entry_id))?;

    if source.id == target.id {
        return Ok(());
    }

    if collection.collection_type == CollectionType::Checklist.as_str()
        && source.checklist_completed != target.checklist_completed
    {
        return Err(
            "Checklist items can only be reordered within the same completion state".to_string(),
        );
    }

    let group_ids = entries
        .iter()
        .filter(|entry| {
            if collection.collection_type == CollectionType::Checklist.as_str() {
                entry.checklist_completed == source.checklist_completed
            } else {
                true
            }
        })
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();

    let source_index = group_ids
        .iter()
        .position(|candidate| candidate == entry_id)
        .ok_or_else(|| format!("Entry not found in reorder group: {}", entry_id))?;
    let target_index = group_ids
        .iter()
        .position(|candidate| candidate == target_entry_id)
        .ok_or_else(|| {
            format!(
                "Target entry not found in reorder group: {}",
                target_entry_id
            )
        })?;

    let mut next_ids = group_ids;
    let moved = next_ids.remove(source_index);
    let mut insert_index = target_index;
    if source_index < target_index {
        insert_index -= 1;
    }
    if position == "after" {
        insert_index += 1;
    }
    if insert_index > next_ids.len() {
        insert_index = next_ids.len();
    }
    next_ids.insert(insert_index, moved);

    for (index, id) in next_ids.iter().enumerate() {
        conn.execute(
            "UPDATE entries SET collection_sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )
        .map_err(|e| e.to_string())?;
    }

    if collection.collection_type == CollectionType::Checklist.as_str() {
        let base_offset = next_ids.len() as i64;
        let other_group_ids = entries
            .iter()
            .filter(|entry| entry.checklist_completed != source.checklist_completed)
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>();

        if source.checklist_completed {
            for (index, id) in next_ids.iter().enumerate() {
                conn.execute(
                    "UPDATE entries SET collection_sort_order = ?1 WHERE id = ?2",
                    params![base_offset + index as i64, id],
                )
                .map_err(|e| e.to_string())?;
            }
            for (index, id) in other_group_ids.iter().enumerate() {
                conn.execute(
                    "UPDATE entries SET collection_sort_order = ?1 WHERE id = ?2",
                    params![index as i64, id],
                )
                .map_err(|e| e.to_string())?;
            }
        } else {
            for (index, id) in other_group_ids.iter().enumerate() {
                conn.execute(
                    "UPDATE entries SET collection_sort_order = ?1 WHERE id = ?2",
                    params![base_offset + index as i64, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

fn reorder_collection(
    conn: &Connection,
    collection_id: &str,
    target_collection_id: &str,
    position: &str,
) -> Result<(), String> {
    let position = position.trim().to_ascii_lowercase();
    if position != "before" && position != "after" {
        return Err("Position must be 'before' or 'after'".to_string());
    }

    let collection_ids = list_ordered_collection_ids(conn)?;
    let source_index = collection_ids
        .iter()
        .position(|id| id == collection_id)
        .ok_or_else(|| format!("Collection not found: {}", collection_id))?;
    let target_index = collection_ids
        .iter()
        .position(|id| id == target_collection_id)
        .ok_or_else(|| format!("Target collection not found: {}", target_collection_id))?;

    if source_index == target_index {
        return Ok(());
    }

    let mut reordered = collection_ids;
    let source_id = reordered.remove(source_index);
    let mut insert_index = reordered
        .iter()
        .position(|id| id == target_collection_id)
        .ok_or_else(|| format!("Target collection not found: {}", target_collection_id))?;
    if position == "after" {
        insert_index += 1;
    }
    reordered.insert(insert_index, source_id);

    for (index, id) in reordered.into_iter().enumerate() {
        conn.execute(
            "UPDATE collections SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )
        .map_err(|e| e.to_string())?;
    }

    normalize_collection_sort_order(conn)?;
    Ok(())
}

fn backfill_entry_collection_sort_order(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT collection_id FROM entries WHERE collection_id IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let collection_ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for collection_id in collection_ids {
        normalize_entry_collection_order(conn, &collection_id)?;
    }

    Ok(())
}

fn next_collection_slug(conn: &Connection, name: &str) -> Result<String, String> {
    next_collection_slug_for_update(conn, name, "")
}

fn next_collection_slug_for_update(
    conn: &Connection,
    name: &str,
    exclude_id: &str,
) -> Result<String, String> {
    let base = slugify_collection_name(name);
    let mut candidate = base.clone();
    let mut suffix = 2;

    while collection_slug_exists(conn, &candidate, exclude_id)? {
        candidate = format!("{}-{}", base, suffix);
        suffix += 1;
    }

    Ok(candidate)
}

fn collection_slug_exists(conn: &Connection, slug: &str, exclude_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE slug = ?1 AND (?2 = '' OR id != ?2))",
        params![slug, exclude_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists != 0)
    .map_err(|e| e.to_string())
}

fn slugify_collection_name(name: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in name.trim().chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }

    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "collection".to_string()
    } else {
        slug
    }
}

fn normalize_optional_collection_icon(icon: Option<String>) -> Result<Option<String>, String> {
    let Some(icon) = icon else {
        return Ok(None);
    };

    let normalized = icon.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(None);
    }

    let valid = normalized
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-');

    if !valid
        || normalized.starts_with('-')
        || normalized.ends_with('-')
        || normalized.contains("--")
    {
        return Err("Collection icon must be a kebab-case icon name".to_string());
    }

    Ok(Some(normalized))
}

fn normalize_optional_collection_id(collection_id: Option<String>) -> Option<String> {
    collection_id.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn canonicalize_collection_id(collection_id: Option<String>, is_note: bool) -> Option<String> {
    normalize_optional_collection_id(collection_id).or_else(|| {
        if is_note {
            Some(NOTES_COLLECTION_ID.to_string())
        } else {
            None
        }
    })
}

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_db_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vec_entries (
                entry_id TEXT PRIMARY KEY,
                embedding BLOB
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn seeds_default_collections_and_backfills_note_membership() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE entries (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                html_content TEXT,
                source TEXT NOT NULL DEFAULT 'clipboard',
                source_app TEXT,
                created_at INTEGER NOT NULL,
                label TEXT,
                label_score REAL,
                summary TEXT,
                enrichment_tags TEXT,
                processing_diagnostics TEXT,
                manual_badges TEXT,
                secret_verdict TEXT,
                secret_type TEXT,
                secret_source TEXT,
                collection_id TEXT,
                checklist_completed INTEGER NOT NULL DEFAULT 0,
                is_note INTEGER NOT NULL DEFAULT 0,
                collection_sort_order INTEGER
            );
            INSERT INTO entries (id, content, source, created_at, is_note) VALUES ('legacy-note', 'note', 'manual', 1, 1);
            INSERT INTO entries (id, content, source, created_at, is_note) VALUES ('legacy-clip', 'clip', 'clipboard', 2, 0);
            ",
        )
        .unwrap();

        ensure_db_schema(&conn).unwrap();

        let collections = list_collections(&conn).unwrap();
        assert_eq!(collections.len(), 3);
        assert_eq!(collections[0].id, NOTES_COLLECTION_ID);
        assert_eq!(collections[0].icon, None);
        assert_eq!(collections[0].collection_type, "standard");
        assert_eq!(collections[1].id, TODO_COLLECTION_ID);
        assert_eq!(collections[1].collection_type, "checklist");
        assert_eq!(collections[2].id, SHOPPING_LIST_COLLECTION_ID);
        assert_eq!(collections[2].collection_type, "checklist");

        let note_collection_id: Option<String> = conn
            .query_row(
                "SELECT collection_id FROM entries WHERE id = 'legacy-note'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let clip_collection_id: Option<String> = conn
            .query_row(
                "SELECT collection_id FROM entries WHERE id = 'legacy-clip'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let note_sort_order: Option<i64> = conn
            .query_row(
                "SELECT collection_sort_order FROM entries WHERE id = 'legacy-note'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let clip_sort_order: Option<i64> = conn
            .query_row(
                "SELECT collection_sort_order FROM entries WHERE id = 'legacy-clip'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(note_collection_id.as_deref(), Some(NOTES_COLLECTION_ID));
        assert_eq!(clip_collection_id, None);
        assert_eq!(note_sort_order, Some(0));
        assert_eq!(clip_sort_order, None);
    }

    #[test]
    fn insert_entry_maps_legacy_note_flag_to_notes_collection() {
        let conn = setup_conn();
        let entry = NewEntry {
            id: "entry-1".to_string(),
            content: "hello".to_string(),
            html_content: None,
            source: "manual".to_string(),
            source_app: None,
            created_at: 1,
            collection_id: None,
            is_note: true,
            import_origin: None,
            import_name: None,
            content_type: None,
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        };

        insert_entry(&conn, &entry).unwrap();

        let row = conn
            .query_row(
                &format!(
                    "SELECT {} FROM entries e WHERE e.id = ?1",
                    entry_select_columns_with_prefix("e")
                ),
                params!["entry-1"],
                row_to_entry,
            )
            .unwrap();

        assert_eq!(row.collection_id.as_deref(), Some(NOTES_COLLECTION_ID));
        assert!(!row.checklist_completed);
        assert!(row.is_note);
        assert_eq!(row.collection_sort_order, Some(0));
    }

    #[test]
    fn duplicate_entry_copies_metadata_and_retargets_collection() {
        let conn = setup_conn();
        let entry = NewEntry {
            id: "entry-copy-source".to_string(),
            content: "copy source".to_string(),
            html_content: Some("<p>copy source</p>".to_string()),
            source: "clipboard".to_string(),
            source_app: Some("tests".to_string()),
            created_at: 1,
            collection_id: None,
            is_note: false,
            import_origin: Some("file-picker".to_string()),
            import_name: Some("example.txt".to_string()),
            content_type: Some("text/plain".to_string()),
            attachment_rel_path: Some("attachments/example.txt".to_string()),
            attachment_size_bytes: Some(12),
            attachment_sha256: Some("abc123".to_string()),
        };

        insert_entry(&conn, &entry).unwrap();
        conn.execute(
            r#"UPDATE entries SET label = 'code', label_score = 0.9, manual_badges = '[{"name":"keep","color":"blue"}]', secret_verdict = 'likely_secret', secret_type = 'token', secret_source = 'manual' WHERE id = ?1"#,
            params![entry.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vec_entries(entry_id, embedding) VALUES (?1, ?2)",
            params![entry.id, vec![1u8, 2, 3, 4]],
        )
        .unwrap();

        let copied_id =
            duplicate_entry_to_collection(&conn, &entry.id, Some(TODO_COLLECTION_ID)).unwrap();

        let copied = conn
            .query_row(
                &format!(
                    "SELECT {} FROM entries e WHERE e.id = ?1",
                    entry_select_columns_with_prefix("e")
                ),
                params![copied_id],
                row_to_entry,
            )
            .unwrap();

        let copied_embedding: Vec<u8> = conn
            .query_row(
                "SELECT embedding FROM vec_entries WHERE entry_id = ?1",
                params![copied.id.clone()],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(copied.content, entry.content);
        assert_eq!(copied.html_content, entry.html_content);
        assert_eq!(copied.collection_id.as_deref(), Some(TODO_COLLECTION_ID));
        assert!(!copied.is_note);
        assert_eq!(
            copied.manual_badges.as_deref(),
            Some("[{\"name\":\"keep\",\"color\":\"blue\"}]")
        );
        assert_eq!(copied.secret_verdict.as_deref(), Some("likely_secret"));
        assert_eq!(
            copied.attachment_rel_path.as_deref(),
            Some("attachments/example.txt")
        );
        assert_eq!(copied.collection_sort_order, Some(0));
        assert_eq!(copied_embedding, vec![1u8, 2, 3, 4]);
    }

    #[test]
    fn db_schema_migrates_and_round_trips_enrichment_fields() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE entries (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                html_content TEXT,
                source TEXT NOT NULL DEFAULT 'clipboard',
                source_app TEXT,
                created_at INTEGER NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                label TEXT,
                label_score REAL,
                summary TEXT,
                enrichment_tags TEXT,
                processing_diagnostics TEXT,
                manual_badges TEXT,
                secret_verdict TEXT,
                secret_type TEXT,
                secret_source TEXT,
                collection_id TEXT,
                checklist_completed INTEGER NOT NULL DEFAULT 0,
                is_note INTEGER NOT NULL DEFAULT 0,
                import_origin TEXT,
                import_name TEXT,
                content_type TEXT,
                attachment_rel_path TEXT,
                attachment_size_bytes INTEGER,
                attachment_sha256 TEXT,
                collection_sort_order INTEGER
            );
            ",
        )
        .unwrap();

        ensure_db_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO entries (id, content, source, created_at, summary, enrichment_tags, processing_diagnostics) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                "entry-enriched",
                "enriched content",
                "manual",
                1i64,
                "Persisted summary",
                "[\"tag-a\",\"tag-b\"]",
                "{\"version\":1}"
            ],
        )
        .unwrap();

        let row = conn
            .query_row(
                &format!(
                    "SELECT {} FROM entries e WHERE e.id = ?1",
                    entry_select_columns_with_prefix("e")
                ),
                params!["entry-enriched"],
                row_to_entry,
            )
            .unwrap();

        assert_eq!(row.summary.as_deref(), Some("Persisted summary"));
        assert_eq!(
            row.enrichment_tags.as_deref(),
            Some("[\"tag-a\",\"tag-b\"]")
        );
        assert_eq!(
            row.processing_diagnostics.as_deref(),
            Some("{\"version\":1}")
        );
    }

    #[test]
    fn notes_is_the_only_protected_system_collection() {
        let conn = setup_conn();

        assert!(ensure_collection_can_be_deleted(&conn, TODO_COLLECTION_ID).is_ok());
        assert!(ensure_collection_can_be_deleted(&conn, SHOPPING_LIST_COLLECTION_ID).is_ok());
        assert_eq!(
            ensure_collection_can_be_deleted(&conn, NOTES_COLLECTION_ID).unwrap_err(),
            "Notes cannot be deleted"
        );
    }

    #[test]
    fn rename_collection_updates_name_slug_and_timestamp() {
        let conn = setup_conn();
        let collection = create_user_collection(
            &conn,
            "Recipes",
            Some("book-open".to_string()),
            CollectionType::Standard,
            None,
        )
        .unwrap();

        let before_updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM collections WHERE id = ?1",
                params![&collection.id],
                |row| row.get(0),
            )
            .unwrap();

        let renamed = rename_collection(&conn, &collection.id, "Project Recipes").unwrap();

        assert_eq!(renamed.name, "Project Recipes");
        assert_eq!(renamed.slug, "project-recipes");
        assert_eq!(renamed.icon.as_deref(), Some("book-open"));
        assert!(renamed.updated_at >= before_updated_at);
    }

    #[test]
    fn rename_collection_generates_unique_slug_without_counting_self() {
        let conn = setup_conn();
        let first =
            create_user_collection(&conn, "Recipes", None, CollectionType::Standard, None).unwrap();
        let second =
            create_user_collection(&conn, "Travel Plans", None, CollectionType::Standard, None)
                .unwrap();

        let renamed = rename_collection(&conn, &second.id, "Recipes").unwrap();
        let same_name = rename_collection(&conn, &first.id, "Recipes").unwrap();

        assert_eq!(renamed.slug, "recipes-2");
        assert_eq!(same_name.slug, "recipes");
    }

    #[test]
    fn rename_collection_only_rejects_notes() {
        let conn = setup_conn();

        assert_eq!(
            rename_collection(&conn, NOTES_COLLECTION_ID, "Journal").unwrap_err(),
            "Notes cannot be renamed"
        );

        let renamed = rename_collection(&conn, TODO_COLLECTION_ID, "Tasks").unwrap();
        assert_eq!(renamed.name, "Tasks");
    }

    #[test]
    fn create_user_collection_persists_icon_when_present() {
        let conn = setup_conn();

        let collection = create_user_collection(
            &conn,
            "Recipes",
            Some("book-open".to_string()),
            CollectionType::Standard,
            None,
        )
        .unwrap();

        assert_eq!(collection.icon.as_deref(), Some("book-open"));
        assert_eq!(collection.collection_type, "standard");

        let listed = list_collections(&conn).unwrap();
        let created = listed.iter().find(|item| item.id == collection.id).unwrap();
        assert_eq!(created.icon.as_deref(), Some("book-open"));
    }

    #[test]
    fn create_user_collection_persists_collection_type() {
        let conn = setup_conn();

        let collection = create_user_collection(
            &conn,
            "Tasks",
            Some("list-todo".to_string()),
            CollectionType::Checklist,
            None,
        )
        .unwrap();

        assert_eq!(collection.collection_type, "checklist");
    }

    #[test]
    fn update_collection_type_persists_new_type_and_timestamp() {
        let conn = setup_conn();
        let collection = create_user_collection(
            &conn,
            "Tasks",
            Some("folder".to_string()),
            CollectionType::Standard,
            None,
        )
        .unwrap();

        let before_updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM collections WHERE id = ?1",
                params![&collection.id],
                |row| row.get(0),
            )
            .unwrap();

        set_collection_type(
            &conn,
            &collection.id,
            CollectionType::Checklist,
            None,
            before_updated_at + 10,
        )
        .unwrap();

        let updated = list_collections(&conn)
            .unwrap()
            .into_iter()
            .find(|item| item.id == collection.id)
            .unwrap();

        assert_eq!(updated.collection_type, "checklist");
        assert!(updated.updated_at > before_updated_at);
    }

    #[test]
    fn duplicate_collection_copies_entries_and_creates_distinct_user_collection() {
        let conn = setup_conn();

        let source = create_user_collection(
            &conn,
            "Recipes",
            Some("book-open".to_string()),
            CollectionType::Checklist,
            None,
        )
        .unwrap();

        let entry = NewEntry {
            id: "recipe-entry".to_string(),
            content: "pancakes".to_string(),
            html_content: Some("<p>pancakes</p>".to_string()),
            source: "manual".to_string(),
            source_app: Some("tests".to_string()),
            created_at: 42,
            collection_id: Some(source.id.clone()),
            is_note: false,
            import_origin: None,
            import_name: None,
            content_type: None,
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        };
        insert_entry(&conn, &entry).unwrap();

        let duplicated = duplicate_collection(&conn, &source.id).unwrap();

        assert_ne!(duplicated.id, source.id);
        assert_eq!(duplicated.name, "Recipes (copy)");
        assert_eq!(duplicated.icon.as_deref(), Some("book-open"));
        assert_eq!(duplicated.collection_type, "checklist");
        assert_eq!(duplicated.kind, "user");

        let entry_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE collection_id = ?1",
                params![&duplicated.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(entry_count, 1);

        let duplicated_entry = conn
            .query_row(
                &format!(
                    "SELECT {} FROM entries e WHERE e.collection_id = ?1",
                    entry_select_columns_with_prefix("e")
                ),
                params![&duplicated.id],
                row_to_entry,
            )
            .unwrap();
        assert_eq!(duplicated_entry.content, "pancakes");
        assert_eq!(
            duplicated_entry.collection_id.as_deref(),
            Some(duplicated.id.as_str())
        );
        assert!(!duplicated_entry.is_note);
        assert_eq!(duplicated_entry.collection_sort_order, Some(0));

        let original_entry_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE collection_id = ?1",
                params![&source.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(original_entry_count, 1);
    }

    #[test]
    fn duplicate_collection_increments_copy_suffix_when_needed() {
        let conn = setup_conn();

        let source =
            create_user_collection(&conn, "Recipes", None, CollectionType::Standard, None).unwrap();
        create_user_collection(
            &conn,
            "Recipes (copy)",
            None,
            CollectionType::Standard,
            None,
        )
        .unwrap();

        let duplicated = duplicate_collection(&conn, &source.id).unwrap();

        assert_eq!(duplicated.name, "Recipes (copy 2)");
    }

    #[test]
    fn lists_collection_entries_using_persisted_manual_order() {
        let conn = setup_conn();
        let collection =
            create_user_collection(&conn, "Ordered", None, CollectionType::Standard, None).unwrap();

        let first = NewEntry {
            id: "ordered-1".to_string(),
            content: "first".to_string(),
            html_content: None,
            source: "manual".to_string(),
            source_app: None,
            created_at: 1,
            collection_id: Some(collection.id.clone()),
            is_note: false,
            import_origin: None,
            import_name: None,
            content_type: None,
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        };
        let second = NewEntry {
            id: "ordered-2".to_string(),
            content: "second".to_string(),
            html_content: None,
            source: "manual".to_string(),
            source_app: None,
            created_at: 2,
            collection_id: Some(collection.id.clone()),
            is_note: false,
            import_origin: None,
            import_name: None,
            content_type: None,
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        };
        insert_entry(&conn, &first).unwrap();
        insert_entry(&conn, &second).unwrap();

        reorder_collection_entry(&conn, &collection.id, "ordered-2", "ordered-1", "before")
            .unwrap();

        let entries = list_collection_entries(&conn, &collection.id, None).unwrap();
        assert_eq!(entries[0].id, "ordered-2");
        assert_eq!(entries[0].collection_sort_order, Some(0));
        assert_eq!(entries[1].id, "ordered-1");
        assert_eq!(entries[1].collection_sort_order, Some(1));
    }

    #[test]
    fn checklist_reorder_stays_within_completion_group() {
        let conn = setup_conn();

        let first = NewEntry {
            id: "todo-1".to_string(),
            content: "first".to_string(),
            html_content: None,
            source: "manual".to_string(),
            source_app: None,
            created_at: 1,
            collection_id: Some(TODO_COLLECTION_ID.to_string()),
            is_note: false,
            import_origin: None,
            import_name: None,
            content_type: None,
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        };
        let second = NewEntry {
            id: "todo-2".to_string(),
            content: "second".to_string(),
            html_content: None,
            source: "manual".to_string(),
            source_app: None,
            created_at: 2,
            collection_id: Some(TODO_COLLECTION_ID.to_string()),
            is_note: false,
            import_origin: None,
            import_name: None,
            content_type: None,
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        };
        let completed = NewEntry {
            id: "todo-3".to_string(),
            content: "done".to_string(),
            html_content: None,
            source: "manual".to_string(),
            source_app: None,
            created_at: 3,
            collection_id: Some(TODO_COLLECTION_ID.to_string()),
            is_note: false,
            import_origin: None,
            import_name: None,
            content_type: None,
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        };
        insert_entry(&conn, &first).unwrap();
        insert_entry(&conn, &second).unwrap();
        insert_entry(&conn, &completed).unwrap();
        set_entry_checklist_completed(&conn, "todo-3", true).unwrap();

        reorder_collection_entry(&conn, TODO_COLLECTION_ID, "todo-2", "todo-1", "before").unwrap();
        let ordered = list_collection_entries(&conn, TODO_COLLECTION_ID, None).unwrap();
        assert_eq!(
            ordered
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["todo-2", "todo-1", "todo-3"]
        );

        let error =
            reorder_collection_entry(&conn, TODO_COLLECTION_ID, "todo-3", "todo-1", "before")
                .unwrap_err();
        assert!(error.contains("same completion state"));
    }

    #[test]
    fn checklist_collection_listing_keeps_completed_items_below_incomplete_items() {
        let conn = setup_conn();

        let completed_first = NewEntry {
            id: "todo-order-1".to_string(),
            content: "completed first".to_string(),
            html_content: None,
            source: "manual".to_string(),
            source_app: None,
            created_at: 1,
            collection_id: Some(TODO_COLLECTION_ID.to_string()),
            is_note: false,
            import_origin: None,
            import_name: None,
            content_type: None,
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        };
        let incomplete = NewEntry {
            id: "todo-order-2".to_string(),
            content: "incomplete".to_string(),
            html_content: None,
            source: "manual".to_string(),
            source_app: None,
            created_at: 2,
            collection_id: Some(TODO_COLLECTION_ID.to_string()),
            is_note: false,
            import_origin: None,
            import_name: None,
            content_type: None,
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        };
        insert_entry(&conn, &completed_first).unwrap();
        insert_entry(&conn, &incomplete).unwrap();
        set_entry_checklist_completed(&conn, "todo-order-1", true).unwrap();

        let ordered = list_collection_entries(&conn, TODO_COLLECTION_ID, None).unwrap();
        assert_eq!(ordered[0].id, "todo-order-2");
        assert_eq!(ordered[1].id, "todo-order-1");
    }

    #[test]
    fn normalize_optional_collection_icon_rejects_non_kebab_case_values() {
        assert_eq!(
            normalize_optional_collection_icon(Some("book-open".to_string())).unwrap(),
            Some("book-open".to_string())
        );
        assert!(normalize_optional_collection_icon(Some("Book Open".to_string())).is_err());
        assert!(normalize_optional_collection_icon(Some("book_open".to_string())).is_err());
        assert_eq!(
            normalize_optional_collection_icon(Some("   ".to_string())).unwrap(),
            None
        );
    }
}
