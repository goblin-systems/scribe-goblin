use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone)]
pub struct EntryRow {
    pub id: String, // UUID
    pub content: String,
    pub html_content: Option<String>,
    pub source: String,
    pub source_app: Option<String>,
    pub created_at: i64,
    pub label: Option<String>,
    pub label_score: Option<f64>,
    pub manual_badges: Option<String>,  // JSON string array
    pub embedding: Option<String>,      // JSON float array string
    pub secret_verdict: Option<String>, // "secret" | "likely_secret" | "not_secret"
    pub secret_type: Option<String>, // "api_key" | "password" | "token" | "private_key" | "unknown"
    pub secret_source: Option<String>, // "trufflehog" | "sap_password_model" | "both"
    pub is_note: bool,
}

pub struct DbState {
    pub conn: Mutex<Option<Connection>>,
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

#[tauri::command]
pub fn db_init(app: AppHandle, state: State<DbState>) -> Result<(), String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("entries_v2.db"); // New DB for new schema

    let conn = Connection::open(path).map_err(|e| e.to_string())?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS entries (
            id             TEXT PRIMARY KEY,
            content        TEXT NOT NULL,
            html_content   TEXT,
            source         TEXT NOT NULL DEFAULT 'clipboard',
            source_app     TEXT,
            created_at     INTEGER NOT NULL,
            label          TEXT,
            label_score    REAL,
            manual_badges  TEXT,
            embedding      TEXT,
            secret_verdict TEXT,
            secret_type    TEXT,
            secret_source  TEXT,
            is_note        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_entries_label ON entries(label);
        ",
    )
    .map_err(|e| e.to_string())?;

    // Migration: add secret columns if missing (existing v2 databases)
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN secret_verdict TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN secret_type TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN secret_source TEXT", []);
    let _ = conn.execute("ALTER TABLE entries ADD COLUMN manual_badges TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE entries ADD COLUMN is_note INTEGER NOT NULL DEFAULT 0",
        [],
    );

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
    let id = Uuid::new_v4().to_string();
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute(
        "INSERT INTO entries (id, content, html_content, source, source_app, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, content, html_content, source, source_app, created_at],
    )
    .map_err(|e| e.to_string())?;
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

    let mut conditions = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(q) = search.filter(|s| !s.trim().is_empty()) {
        let pattern = format!("%{}%", q.trim());
        conditions.push("(content LIKE ? OR label LIKE ? OR manual_badges LIKE ?)".to_string());
        param_values.push(Box::new(pattern.clone()));
        param_values.push(Box::new(pattern.clone()));
        param_values.push(Box::new(pattern));
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
        "SELECT id, content, html_content, source, source_app, created_at, label, label_score, manual_badges, embedding, secret_verdict, secret_type, secret_source, is_note FROM entries{} ORDER BY created_at DESC LIMIT ?",
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
pub fn db_get_embeddings(state: State<DbState>) -> Result<Vec<EntryRow>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    let mut stmt = conn
        .prepare(
            "SELECT id, content, html_content, source, source_app, created_at, label, label_score, manual_badges, embedding, secret_verdict, secret_type, secret_source, is_note
             FROM entries WHERE embedding IS NOT NULL ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<EntryRow> = stmt
        .query_map([], row_to_entry)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
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
        "UPDATE entries SET label = ?1, label_score = ?2, embedding = ?3 WHERE id = ?4",
        params![label, label_score, embedding, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_delete_entry(state: State<DbState>, id: String) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute("DELETE FROM entries WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_clear_entry_label(state: State<DbState>, id: String) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute(
        "UPDATE entries SET label = NULL, label_score = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
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
    let current = load_manual_badges(conn, &id)?;

    if current.iter().any(|existing| existing.name == normalized) {
        return Ok(());
    }

    let mut updated = current;
    updated.push(ManualBadge {
        name: normalized,
        color,
    });
    let serialized = serialize_manual_badges(&updated)?;

    conn.execute(
        "UPDATE entries SET manual_badges = ?1 WHERE id = ?2",
        params![serialized, id],
    )
    .map_err(|e| e.to_string())?;
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
    let mut updated = load_manual_badges(conn, &id)?;
    updated.retain(|existing| existing.name != normalized);
    let serialized = serialize_manual_badges(&updated)?;

    conn.execute(
        "UPDATE entries SET manual_badges = ?1 WHERE id = ?2",
        params![serialized, id],
    )
    .map_err(|e| e.to_string())?;
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
pub fn db_promote_to_note(state: State<DbState>, id: String) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute("UPDATE entries SET is_note = 1 WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_demote_from_note(state: State<DbState>, id: String) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    conn.execute("UPDATE entries SET is_note = 0 WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<EntryRow> {
    Ok(EntryRow {
        id: row.get(0)?,
        content: row.get(1)?,
        html_content: row.get(2)?,
        source: row.get(3)?,
        source_app: row.get(4)?,
        created_at: row.get(5)?,
        label: row.get(6)?,
        label_score: row.get(7)?,
        manual_badges: row.get(8)?,
        embedding: row.get(9)?,
        secret_verdict: row.get(10)?,
        secret_type: row.get(11)?,
        secret_source: row.get(12)?,
        is_note: row.get::<_, i64>(13)? != 0,
    })
}

fn normalize_badge(badge: &str) -> String {
    badge.trim().to_lowercase()
}

fn load_manual_badges(conn: &Connection, id: &str) -> Result<Vec<ManualBadge>, String> {
    let manual_badges = conn
        .query_row(
            "SELECT manual_badges FROM entries WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| e.to_string())?;

    match manual_badges {
        Some(json) => {
            // Try new format first (array of objects)
            if let Ok(badges) = serde_json::from_str::<Vec<ManualBadge>>(&json) {
                return Ok(badges);
            }
            // Fall back to old format (array of strings)
            if let Ok(names) = serde_json::from_str::<Vec<String>>(&json) {
                return Ok(names
                    .into_iter()
                    .map(|name| ManualBadge {
                        name,
                        color: "default".to_string(),
                    })
                    .collect());
            }
            Err(format!("Failed to parse manual_badges JSON: {}", json))
        }
        None => Ok(Vec::new()),
    }
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
