use std::thread;
use std::time::Duration;
use tauri::command;

#[cfg(target_os = "windows")]
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GHND};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VK_CONTROL, VK_V,
};

#[cfg(target_os = "windows")]
fn set_html_to_clipboard(html: &str) -> Result<(), String> {
    unsafe {
        if OpenClipboard(None).is_ok() {
            let _ = EmptyClipboard();
            
            let format_name: Vec<u16> = "HTML Format\0".encode_utf16().collect();
            let cf_html = RegisterClipboardFormatW(PCWSTR(format_name.as_ptr()));
            
            if cf_html != 0 {
                let bytes = html.as_bytes();
                let hglobal: HGLOBAL = GlobalAlloc(GHND, bytes.len() + 1).map_err(|e| e.to_string())?;
                let ptr = GlobalLock(hglobal);
                if !ptr.is_null() {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
                    *(ptr.add(bytes.len()) as *mut u8) = 0;
                    let _ = GlobalUnlock(hglobal);
                    if SetClipboardData(cf_html, Some(HANDLE(hglobal.0))).is_err() {
                        let _ = CloseClipboard();
                        return Err("Failed to set HTML clipboard data".to_string());
                    }
                }
            }
            let _ = CloseClipboard();
        }
    }
    Ok(())
}

#[command]
pub fn simulate_paste(text: String, html: Option<String>) -> Result<(), String> {
    // 1. Set text to clipboard
    if let Some(html_content) = html {
        #[cfg(target_os = "windows")]
        {
            // When setting HTML, we should also set plain text for compatibility
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard.set_text(text).map_err(|e| e.to_string())?;
            
            // Overwrite/Add HTML format
            set_html_to_clipboard(&html_content)?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard.set_text(text).map_err(|e| e.to_string())?;
        }
    } else {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_text(text).map_err(|e| e.to_string())?;
    }

    // Give the OS a tiny bit of time to settle the clipboard
    thread::sleep(Duration::from_millis(50));

    // 2. Simulate Ctrl+V
    #[cfg(target_os = "windows")]
    unsafe {
        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_V,
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_V,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];

        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
    
    Ok(())
}
