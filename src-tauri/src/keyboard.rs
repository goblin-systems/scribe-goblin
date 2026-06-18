use std::thread;
use std::time::Duration;
use tauri::{command, AppHandle, Manager};

#[cfg(target_os = "macos")]
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
#[cfg(target_os = "macos")]
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
#[cfg(target_os = "windows")]
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GHND};
#[cfg(target_os = "windows")]
use windows::Win32::System::Ole::CF_UNICODETEXT;

#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_V,
};

#[cfg(target_os = "windows")]
const HTML_FRAGMENT_START: &str = "<!--StartFragment-->";
#[cfg(target_os = "windows")]
const HTML_FRAGMENT_END: &str = "<!--EndFragment-->";

#[cfg(target_os = "windows")]
fn build_cf_html_payload(html: &str) -> Vec<u8> {
    let wrapped_html =
        format!("<html><body>{HTML_FRAGMENT_START}{html}{HTML_FRAGMENT_END}</body></html>");
    let placeholder_header = format!(
        concat!(
            "Version:0.9\r\n",
            "StartHTML:{:010}\r\n",
            "EndHTML:{:010}\r\n",
            "StartFragment:{:010}\r\n",
            "EndFragment:{:010}\r\n"
        ),
        0, 0, 0, 0
    );
    let start_html = placeholder_header.len();
    let start_fragment = start_html + "<html><body><!--StartFragment-->".len();
    let end_fragment = start_fragment + html.len();
    let end_html = start_html + wrapped_html.len();
    let header = format!(
        concat!(
            "Version:0.9\r\n",
            "StartHTML:{:010}\r\n",
            "EndHTML:{:010}\r\n",
            "StartFragment:{:010}\r\n",
            "EndFragment:{:010}\r\n"
        ),
        start_html, end_html, start_fragment, end_fragment
    );

    [header.into_bytes(), wrapped_html.into_bytes()].concat()
}

#[cfg(target_os = "windows")]
fn alloc_global_bytes(bytes: &[u8]) -> Result<HGLOBAL, String> {
    unsafe {
        let hglobal = GlobalAlloc(GHND, bytes.len()).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            let _ = GlobalFree(Some(hglobal));
            return Err("Failed to lock global memory".to_string());
        }

        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        let _ = GlobalUnlock(hglobal);
        Ok(hglobal)
    }
}

#[cfg(target_os = "windows")]
fn alloc_global_utf16(text: &str) -> Result<HGLOBAL, String> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let bytes_len = wide.len() * std::mem::size_of::<u16>();
        let hglobal = GlobalAlloc(GHND, bytes_len).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            let _ = GlobalFree(Some(hglobal));
            return Err("Failed to lock global memory".to_string());
        }

        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr as *mut u16, wide.len());
        let _ = GlobalUnlock(hglobal);
        Ok(hglobal)
    }
}

#[cfg(target_os = "windows")]
fn open_clipboard_with_retry() -> Result<(), String> {
    let attempts = 10;
    for _ in 0..attempts {
        unsafe {
            if OpenClipboard(None).is_ok() {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(15));
    }

    Err("Failed to open clipboard".to_string())
}

#[cfg(target_os = "windows")]
fn set_windows_clipboard(text: &str, html: Option<&str>) -> Result<(), String> {
    unsafe {
        open_clipboard_with_retry()?;

        if let Err(err) = EmptyClipboard() {
            let _ = CloseClipboard();
            return Err(err.to_string());
        }

        let text_handle = match alloc_global_utf16(text) {
            Ok(handle) => handle,
            Err(err) => {
                let _ = CloseClipboard();
                return Err(err);
            }
        };

        if SetClipboardData(CF_UNICODETEXT.0.into(), Some(HANDLE(text_handle.0))).is_err() {
            let _ = GlobalFree(Some(text_handle));
            let _ = CloseClipboard();
            return Err("Failed to set Unicode clipboard data".to_string());
        }

        if let Some(html_content) = html {
            let format_name: Vec<u16> = "HTML Format\0".encode_utf16().collect();
            let cf_html = RegisterClipboardFormatW(PCWSTR(format_name.as_ptr()));
            if cf_html == 0 {
                let _ = CloseClipboard();
                return Err("Failed to register HTML clipboard format".to_string());
            }

            let payload = build_cf_html_payload(html_content);
            let html_handle = match alloc_global_bytes(&payload) {
                Ok(handle) => handle,
                Err(err) => {
                    let _ = CloseClipboard();
                    return Err(err);
                }
            };

            if SetClipboardData(cf_html, Some(HANDLE(html_handle.0))).is_err() {
                let _ = GlobalFree(Some(html_handle));
                let _ = CloseClipboard();
                return Err("Failed to set HTML clipboard data".to_string());
            }
        }

        let _ = CloseClipboard();
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn keyboard_input(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(target_os = "macos")]
const MAC_KEY_V: u16 = 9;

#[cfg(target_os = "macos")]
fn apple_script_literal(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<String, String> {
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "osascript failed".to_string()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn activate_app_by_bundle_id(bundle_id: &str) -> Result<(), String> {
    if bundle_id.trim().is_empty() {
        return Ok(());
    }

    run_osascript(&format!(
        "tell application id {} to activate",
        apple_script_literal(bundle_id.trim())
    ))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_keyboard_input(keycode: u16, keydown: bool, flags: CGEventFlags) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "Failed to create keyboard event source".to_string())?;
    let event = CGEvent::new_keyboard_event(source, keycode, keydown)
        .map_err(|_| "Failed to create keyboard event".to_string())?;
    event.set_flags(flags);
    event.post(CGEventTapLocation::HID);
    Ok(())
}

#[cfg(target_os = "macos")]
fn simulate_macos_paste(
    app: &AppHandle,
    target_app_bundle_id: Option<&str>,
    hide_overlay_after_target_activation: bool,
) -> Result<(), String> {
    if let Some(bundle_id) = target_app_bundle_id {
        activate_app_by_bundle_id(bundle_id)?;
        thread::sleep(Duration::from_millis(120));
    }

    if hide_overlay_after_target_activation {
        if let Some(window) = app.get_webview_window("overlay") {
            window.hide().map_err(|e| e.to_string())?;
        }
        thread::sleep(Duration::from_millis(40));
    }

    let command = CGEventFlags::CGEventFlagCommand;
    mac_keyboard_input(MAC_KEY_V, true, command)?;
    thread::sleep(Duration::from_millis(15));
    mac_keyboard_input(MAC_KEY_V, false, command)?;
    Ok(())
}

#[command]
pub fn get_frontmost_app_bundle_id() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = run_osascript(
            "tell application \"System Events\" to get bundle identifier of first application process whose frontmost is true",
        )?;
        return Ok((!bundle_id.is_empty()).then_some(bundle_id));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[cfg(target_os = "windows")]
fn release_interfering_modifiers() {
    unsafe {
        let inputs = [
            keyboard_input(VK_MENU, KEYEVENTF_KEYUP),
            keyboard_input(VK_SHIFT, KEYEVENTF_KEYUP),
            keyboard_input(VK_LWIN, KEYEVENTF_KEYUP),
            keyboard_input(VK_RWIN, KEYEVENTF_KEYUP),
            keyboard_input(VK_CONTROL, KEYEVENTF_KEYUP),
        ];
        let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[command]
pub fn simulate_paste(
    app: AppHandle,
    text: String,
    html: Option<String>,
    target_app_bundle_id: Option<String>,
    hide_overlay_after_target_activation: Option<bool>,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    let _ = &app;
    #[cfg(not(target_os = "windows"))]
    let _ = &html;
    #[cfg(not(target_os = "macos"))]
    let _ = &target_app_bundle_id;
    #[cfg(not(target_os = "macos"))]
    let _ = &hide_overlay_after_target_activation;

    // 1. Set text to clipboard
    #[cfg(target_os = "windows")]
    {
        set_windows_clipboard(&text, html.as_deref())?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_text(text).map_err(|e| e.to_string())?;
    }

    // Give the OS a tiny bit of time to settle the clipboard
    thread::sleep(Duration::from_millis(60));

    // 2. Simulate Ctrl+V
    #[cfg(target_os = "windows")]
    unsafe {
        release_interfering_modifiers();
        thread::sleep(Duration::from_millis(20));

        let inputs = [
            keyboard_input(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
            keyboard_input(VK_V, KEYBD_EVENT_FLAGS(0)),
            keyboard_input(VK_V, KEYEVENTF_KEYUP),
            keyboard_input(VK_CONTROL, KEYEVENTF_KEYUP),
        ];

        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }

    #[cfg(target_os = "macos")]
    {
        simulate_macos_paste(
            &app,
            target_app_bundle_id.as_deref(),
            hide_overlay_after_target_activation.unwrap_or(false),
        )?;
    }

    Ok(())
}

// CF_HTML is a Windows clipboard format; the helper under test only exists there.
#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::build_cf_html_payload;

    #[test]
    fn builds_valid_cf_html_payload_offsets() {
        let html = "<p>Hello <strong>world</strong></p>";
        let payload = build_cf_html_payload(html);
        let payload_str = String::from_utf8(payload).expect("payload should be utf-8");

        let start_html = extract_offset(&payload_str, "StartHTML:");
        let end_html = extract_offset(&payload_str, "EndHTML:");
        let start_fragment = extract_offset(&payload_str, "StartFragment:");
        let end_fragment = extract_offset(&payload_str, "EndFragment:");

        assert_eq!(
            &payload_str[start_html..end_html],
            &payload_str[start_html..]
        );
        assert_eq!(&payload_str[start_fragment..end_fragment], html);
        assert!(payload_str[start_html..end_html].contains("<!--StartFragment-->"));
        assert!(payload_str[start_html..end_html].contains("<!--EndFragment-->"));
    }

    fn extract_offset(payload: &str, prefix: &str) -> usize {
        let start = payload.find(prefix).expect("missing prefix") + prefix.len();
        let end = payload[start..]
            .find("\r\n")
            .map(|index| start + index)
            .expect("missing line ending");
        payload[start..end].parse().expect("offset should parse")
    }
}
