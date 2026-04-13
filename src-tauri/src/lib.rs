mod clipboard;
mod db;
mod debug_log;
mod http_proxy;
mod keyboard;
mod classifier;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            clipboard::start_clipboard_monitor,
            clipboard::stop_clipboard_monitor,
            db::db_init,
            db::db_add_entry,
            db::db_list_entries,
            db::db_get_embeddings,
            db::db_update_entry_classification,
            db::db_update_entry_secret,
            db::db_delete_entry,
            debug_log::set_debug_logging_enabled,
            debug_log::write_debug_log,
            debug_log::open_debug_log_folder,
            debug_log::open_external_url,
            http_proxy::http_fetch,
            keyboard::simulate_paste,
            get_cursor_position,
            classifier::classify_text,
        ])
        .manage(clipboard::ClipboardState::default())
        .manage(db::DbState::default())
        .manage(debug_log::DebugLogState::default())
        .setup(|app| {
            // Resolve the directory containing ONNX model files.
            // Dev mode: cwd is src-tauri/, models live at <workspace>/resources/
            // Production: bundle.resources copies them into resource_dir() root
            let dev_path = std::env::current_dir().ok().and_then(|cwd| {
                // If cwd itself has a resources/ child (workspace root)
                let candidate = cwd.join("resources");
                if candidate.join("classifier.onnx").exists() {
                    return Some(candidate);
                }
                // If cwd is src-tauri/, check parent
                cwd.parent()
                    .map(|parent| parent.join("resources"))
                    .filter(|r| r.join("classifier.onnx").exists())
            });

            let prod_path = app.path().resource_dir().ok().filter(|r| {
                r.join("classifier.onnx").exists()
            });

            let final_path = dev_path
                .or(prod_path)
                .unwrap_or_else(|| {
                    eprintln!("Warning: could not locate ONNX resources directory");
                    std::env::current_dir().unwrap().join("resources")
                });

            match classifier::ClassifierState::new(final_path) {
                Ok(state) => {
                    app.manage(Some(Arc::new(state)));
                }
                Err(e) => {
                    eprintln!("Failed to initialize classifier: {}", e);
                    app.manage(None::<Arc<classifier::ClassifierState>>);
                }
            }

            let settings_item = MenuItem::with_id(app, "settings", "Open Scribe Goblin", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Scribe Goblin")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_icon(icon.clone());
                }
                tray_builder = tray_builder.icon(icon);
            }

            let _tray = tray_builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn get_cursor_position() -> Result<(f64, f64), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        use windows::Win32::Foundation::POINT;
        let mut point = POINT::default();
        unsafe {
            if GetCursorPos(&mut point).is_ok() {
                return Ok((point.x as f64, point.y as f64));
            }
        }
    }
    Ok((0.0, 0.0))
}
