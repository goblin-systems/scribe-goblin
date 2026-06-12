use arboard::Clipboard;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HGLOBAL;
#[cfg(target_os = "windows")]
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

pub struct ClipboardState {
    pub monitoring: Arc<AtomicBool>,
}

impl Default for ClipboardState {
    fn default() -> Self {
        Self {
            monitoring: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[cfg(target_os = "windows")]
fn get_html_from_clipboard() -> Option<String> {
    unsafe {
        // Try to open clipboard, return None if it fails (likely already open by arboard or another app)
        if OpenClipboard(None).is_err() {
            return None;
        }

        let format_name: Vec<u16> = "HTML Format\0".encode_utf16().collect();
        let cf_html = RegisterClipboardFormatW(PCWSTR(format_name.as_ptr()));

        let mut result = None;
        if cf_html != 0 && IsClipboardFormatAvailable(cf_html).is_ok() {
            if let Ok(handle) = GetClipboardData(cf_html) {
                if !handle.0.is_null() {
                    let hglobal = HGLOBAL(handle.0);
                    let ptr = GlobalLock(hglobal);
                    if !ptr.is_null() {
                        let size = windows::Win32::System::Memory::GlobalSize(hglobal);
                        let slice = std::slice::from_raw_parts(ptr as *const u8, size);
                        // CF_HTML is UTF-8 encoded, but may contain a null terminator
                        let mut len = size;
                        for i in 0..size {
                            if slice[i] == 0 {
                                len = i;
                                break;
                            }
                        }
                        let html = String::from_utf8_lossy(&slice[..len]).to_string();
                        let _ = GlobalUnlock(hglobal);
                        result = Some(html);
                    }
                }
            }
        }
        let _ = CloseClipboard();
        result
    }
}

#[cfg(target_os = "windows")]
fn get_active_app_name() -> Option<String> {
    use std::path::Path;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == 0 {
            return None;
        }

        let process_handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
        {
            Ok(h) => h,
            Err(_) => return None,
        };

        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        if QueryFullProcessImageNameW(
            process_handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok()
        {
            let full_path = String::from_utf16_lossy(&buffer[..size as usize]);
            let name = Path::new(&full_path)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.replace(".exe", ""))
                .map(|s| s.to_lowercase());
            return name;
        }
        None
    }
}

#[tauri::command]
pub fn start_clipboard_monitor(
    app: AppHandle,
    state: tauri::State<ClipboardState>,
) -> Result<(), String> {
    if state.monitoring.load(Ordering::SeqCst) {
        return Ok(()); // already running
    }

    let monitoring = Arc::clone(&state.monitoring);
    monitoring.store(true, Ordering::SeqCst);

    thread::spawn(move || {
        let mut clipboard = match Clipboard::new() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("clipboard-error", format!("Failed to open clipboard: {e}"));
                monitoring.store(false, Ordering::SeqCst);
                return;
            }
        };

        // Seed last_text so we don't re-capture whatever is already in the clipboard on startup
        let mut last_text = clipboard.get_text().unwrap_or_default();

        while monitoring.load(Ordering::SeqCst) {
            if let Ok(text) = clipboard.get_text() {
                let trimmed = text.trim();
                if !trimmed.is_empty() && trimmed != last_text.as_str() {
                    println!("[CLIPBOARD] New text detected: {}", trimmed);
                    last_text = trimmed.to_string();

                    #[cfg(target_os = "windows")]
                    let html = get_html_from_clipboard();
                    #[cfg(target_os = "windows")]
                    let source_app = get_active_app_name();

                    #[cfg(not(target_os = "windows"))]
                    let html: Option<String> = None;
                    #[cfg(not(target_os = "windows"))]
                    let source_app: Option<String> = None;

                    let _ = app.emit(
                        "clipboard-capture",
                        serde_json::json!({
                            "content": trimmed,
                            "html_content": html,
                            "source_app": source_app
                        }),
                    );
                }
            }
            thread::sleep(std::time::Duration::from_millis(500));
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_clipboard_monitor(state: tauri::State<ClipboardState>) {
    state.monitoring.store(false, Ordering::SeqCst);
}
