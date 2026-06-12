use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager, State};
use time::macros::format_description;

const LOG_TIMESTAMP_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");

const MAX_DEBUG_LOG_ENTRIES: usize = 2000;

pub struct DebugLogState {
    enabled: AtomicBool,
    write_lock: Mutex<()>,
}

impl DebugLogState {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }
}

impl Default for DebugLogState {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            write_lock: Mutex::new(()),
        }
    }
}

#[tauri::command]
pub fn set_debug_logging_enabled(
    app: AppHandle,
    state: State<DebugLogState>,
    enabled: bool,
) -> Result<String, String> {
    state.enabled.store(enabled, Ordering::SeqCst);
    let path = resolve_log_file_path(&app)?;
    let _guard = state
        .write_lock
        .lock()
        .map_err(|_| "Failed to lock debug log writer".to_string())?;

    if enabled {
        append_log_line(&path, "INFO", "Debug logging enabled")?;
    } else {
        append_log_line(&path, "INFO", "Debug logging disabled")?;
    }
    prune_log_entries(&path)?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn write_debug_log(
    app: AppHandle,
    state: State<DebugLogState>,
    level: String,
    message: String,
) -> Result<(), String> {
    if !state.is_enabled() {
        return Ok(());
    }
    let path = resolve_log_file_path(&app)?;
    let _guard = state
        .write_lock
        .lock()
        .map_err(|_| "Failed to lock debug log writer".to_string())?;
    append_log_line(&path, &level, &message)?;
    prune_log_entries(&path)
}

pub fn write_debug_log_internal(
    app: &AppHandle,
    state: &DebugLogState,
    level: &str,
    message: &str,
) {
    if !state.is_enabled() {
        return;
    }
    let Ok(path) = resolve_log_file_path(app) else {
        return;
    };
    let Ok(_guard) = state.write_lock.lock() else {
        return;
    };
    let _ = append_log_line(&path, level, message);
    let _ = prune_log_entries(&path);
}

#[tauri::command]
pub fn open_debug_log_folder(app: AppHandle) -> Result<(), String> {
    let path = resolve_log_file_path(&app)?;
    let dir = path
        .parent()
        .ok_or("Failed to resolve debug log directory".to_string())?;

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(dir);
        c
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(dir);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(dir);
        c
    };

    cmd.spawn()
        .map_err(|e| format!("Failed to open debug log directory: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Only http(s) URLs are allowed".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("start").arg("").arg(trimmed);
        c
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(trimmed);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(trimmed);
        c
    };

    cmd.spawn()
        .map_err(|e| format!("Failed to open URL: {}", e))?;
    Ok(())
}

pub fn resolve_log_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app local data dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create log directory: {}", e))?;
    Ok(dir.join("debug.log"))
}

fn append_log_line(path: &PathBuf, level: &str, message: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open debug log file: {}", e))?;

    let local_offset = time::UtcOffset::current_local_offset()
        .map_err(|e| format!("Failed to determine local time offset: {}", e))?;
    let ts = time::OffsetDateTime::now_utc()
        .to_offset(local_offset)
        .format(LOG_TIMESTAMP_FORMAT)
        .map_err(|e| format!("Failed to format timestamp: {}", e))?;

    writeln!(file, "{} [{}] {}", ts, level, message)
        .map_err(|e| format!("Failed to write debug log entry: {}", e))
}

fn prune_log_entries(path: &PathBuf) -> Result<(), String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read debug log for pruning: {}", e))?;
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= MAX_DEBUG_LOG_ENTRIES {
        return Ok(());
    }
    let keep_from = lines.len().saturating_sub(MAX_DEBUG_LOG_ENTRIES);
    let mut trimmed = lines[keep_from..].join("\n");
    trimmed.push('\n');
    fs::write(path, trimmed).map_err(|e| format!("Failed to prune debug log file: {}", e))
}
