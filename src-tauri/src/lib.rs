mod autocomplete;
mod classifier;
mod clipboard;
mod inference;
#[cfg(feature = "llamacpp")]
mod llamacpp;
mod db;
mod debug_log;
mod heuristics;
mod http_proxy;
mod import;
mod keyboard;
mod models;
mod qwen_tagger;
mod search;
mod secret_masker;
mod storage;
mod trufflehog;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            clipboard::start_clipboard_monitor,
            clipboard::stop_clipboard_monitor,
            db::db_init,
            db::db_add_entry,
            db::db_list_entries,
            db::db_set_entry_pinned,
            db::db_update_entry_classification,
            db::db_update_entry_embedding,
            db::db_clear_entry_label,
            db::db_remove_entry_tag,
            db::db_replace_generated_tags,
            db::db_add_manual_badge,
            db::db_add_manual_badge_bulk,
            db::db_remove_manual_badge,
            db::db_list_all_badges,
            db::db_update_entry_secret,
            db::db_update_entry_enrichment,
            db::db_update_entry_processing_diagnostics,
            db::db_set_secret_verdict_bulk,
            db::db_delete_entry,
            db::db_delete_entries,
            db::db_promote_to_note,
            db::db_demote_from_note,
            db::db_get_entry_embedding,
            db::db_list_collections,
            db::db_create_collection,
            db::db_set_entry_checklist_completed,
            db::db_list_collection_entries,
            db::db_reorder_collection_entry,
            db::db_reorder_collection,
            db::db_update_collection_type,
            db::db_rename_collection,
            db::db_duplicate_collection,
            db::db_delete_collection,
            db::db_move_entries_to_collection,
            db::db_copy_entries_to_collection,
            debug_log::set_debug_logging_enabled,
            debug_log::write_debug_log,
            debug_log::open_debug_log_folder,
            debug_log::open_external_url,
            configure_overlay_macos_panel,
            set_macos_accessory_activation_policy,
            keyboard::get_frontmost_app_bundle_id,
            http_proxy::http_fetch,
            keyboard::simulate_paste,
            import::import_capture,
            search::search_entries,
            search::get_related_entries,
            search::build_semantic_graph,
            search::rebuild_search_indexes,
            search::list_manual_badge_suggestions,
            search::list_badge_suggestions,
            get_cursor_position,
            classifier::generate_embedding,
            classifier::reembed_all_entries,
            heuristics::heuristic_tag,
            qwen_tagger::qwen_generate_tags,
            qwen_tagger::qwen_status,
            qwen_tagger::qwen_prefetch,
            autocomplete::autocomplete_complete,
            autocomplete::autocomplete_prefetch,
            inference::inference_capabilities,
            inference::inference_test,
            trufflehog::trufflehog_check,
            trufflehog::trufflehog_scan,
            secret_masker::secret_masker_scan,
            models::models_list,
            models::models_download,
            models::models_cancel_download,
            models::ai_status,
        ])
        .manage(clipboard::ClipboardState::default())
        .manage(db::DbState::default())
        .manage(debug_log::DebugLogState::default())
        .manage(trufflehog::TruffleHogState::default())
        .setup(|app| {
            // Resolve the directory containing model resources.
            // Dev mode: cwd is src-tauri/, resources live at <workspace>/resources/
            // Production: bundle.resources copies them into resource_dir() root.
            // Detection keys off embedding_tokenizer.json because it is always
            // checked in, unlike the large model binaries.
            let dev_path = std::env::current_dir().ok().and_then(|cwd| {
                let candidate = cwd.join("resources");
                if candidate.join("embedding_tokenizer.json").exists() {
                    return Some(candidate);
                }
                cwd.parent()
                    .map(|parent| parent.join("resources"))
                    .filter(|r| r.join("embedding_tokenizer.json").exists())
            });

            let prod_path = app
                .path()
                .resource_dir()
                .ok()
                .filter(|r| r.join("embedding_tokenizer.json").exists());

            let final_path = dev_path.or(prod_path).unwrap_or_else(|| {
                eprintln!("Warning: could not locate model resources directory");
                std::env::current_dir().unwrap().join("resources")
            });

            // Downloaded models live outside the repo/bundle, in app data.
            let models_dir = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("models"))
                .unwrap_or_else(|_| final_path.join("models"));
            if let Err(e) = std::fs::create_dir_all(&models_dir) {
                eprintln!("Warning: could not create models directory: {}", e);
            }

            // Default model locations: a model-manager download wins, then the
            // legacy bundled location. Engines load lazily and can be switched
            // at runtime via per-call model_path parameters.
            let embedding_model_path = models::resolve_model_file(
                models::EMBEDDING_MODEL_ID,
                "model.onnx",
                &models_dir,
                &final_path,
            )
            .unwrap_or_else(|| final_path.join("embedding.onnx"));
            app.manage(classifier::ClassifierState::new(
                embedding_model_path,
                final_path.join("embedding_tokenizer.json"),
            ));

            let secret_masker_model_path = models::resolve_model_file(
                models::SECRET_MASKER_MODEL_ID,
                "model.onnx",
                &models_dir,
                &final_path,
            )
            .unwrap_or_else(|| final_path.join("secret-masker").join("model.onnx"));
            app.manage(secret_masker::SecretMaskerState::new(
                secret_masker_model_path,
                final_path.join("secret-masker").join("tokenizer.json"),
            ));

            let llm_model_path = models::resolve_model_file(
                "qwen2.5-0.5b-instruct-q4_0",
                "qwen2.5-0.5b-instruct-q4_0.gguf",
                &models_dir,
                &final_path,
            )
            .unwrap_or_else(|| {
                final_path
                    .join("qwen-25-05b")
                    .join("qwen2.5-0.5b-instruct-q4_0.gguf")
            });
            app.manage(qwen_tagger::QwenTaggerState::new(llm_model_path.clone()));
            // Autocomplete shares the default LLM path but keeps its own slot so
            // its model can differ from the enrichment model without thrashing.
            app.manage(autocomplete::AutocompleteState::new(llm_model_path));

            app.manage(models::ModelsState::new(models_dir, final_path.clone()));

            #[cfg(target_os = "macos")]
            if let Err(e) = configure_overlay_macos_panel_inner(app.handle()) {
                eprintln!("Warning: could not configure overlay panel: {}", e);
            }

            let settings_item =
                MenuItem::with_id(app, "settings", "Open Scribe Goblin", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Scribe Goblin")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        #[cfg(target_os = "macos")]
                        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
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
                        #[cfg(target_os = "macos")]
                        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
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
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut point = POINT::default();
        unsafe {
            if GetCursorPos(&mut point).is_ok() {
                return Ok((point.x as f64, point.y as f64));
            }
        }
    }
    Ok((0.0, 0.0))
}

#[tauri::command]
fn set_macos_accessory_activation_policy(app: AppHandle, accessory: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let policy = if accessory {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        return app.set_activation_policy(policy).map_err(|e| e.to_string());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, accessory);
        Ok(())
    }
}

#[tauri::command]
fn configure_overlay_macos_panel(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return configure_overlay_macos_panel_inner(&app);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn configure_overlay_macos_panel_inner(app: &AppHandle) -> Result<(), String> {
    use objc2_app_kit::{
        NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask, NSPopUpMenuWindowLevel,
    };

    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    let ns_window = window.ns_window().map_err(|e| e.to_string())?;
    let ns_window = unsafe { &*ns_window.cast::<NSWindow>() };

    ns_window.setStyleMask(
        ns_window.styleMask()
            | NSWindowStyleMask::NonactivatingPanel
            | NSWindowStyleMask::UtilityWindow,
    );
    ns_window.setCollectionBehavior(
        ns_window.collectionBehavior()
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Transient,
    );
    ns_window.setLevel(NSPopUpMenuWindowLevel);
    ns_window.setHidesOnDeactivate(false);
    ns_window.setCanHide(false);

    Ok(())
}
