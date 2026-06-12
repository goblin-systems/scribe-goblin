use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

const SCAN_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct TruffleHogState {
    pub binary_path: Mutex<Option<PathBuf>>,
    pub available: Mutex<Option<bool>>,
}

impl Default for TruffleHogState {
    fn default() -> Self {
        Self {
            binary_path: Mutex::new(None),
            available: Mutex::new(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Deserialization (internal — matches TruffleHog JSON output)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct TruffleHogRawResult {
    #[serde(rename = "DetectorType")]
    detector_type: u32,
    #[serde(rename = "DetectorName")]
    detector_name: String,
    #[serde(rename = "Verified")]
    verified: bool,
    #[serde(rename = "VerificationError", default)]
    verification_error: String,
    #[serde(rename = "Raw", default)]
    raw: String,
    #[serde(rename = "Redacted", default)]
    redacted: String,
    #[serde(rename = "DecoderName", default)]
    decoder_name: String,
    #[serde(rename = "ExtraData", default)]
    extra_data: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// FFI output structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TruffleHogFinding {
    pub detector_name: String,
    pub verified: bool,
    pub raw_redacted: String,
    pub decoder: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TruffleHogStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub supports_stdin: bool,
}

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

fn find_trufflehog(custom_path: Option<&str>) -> Option<PathBuf> {
    let binary_name = if cfg!(target_os = "windows") {
        "trufflehog.exe"
    } else {
        "trufflehog"
    };

    // Try custom path first
    if let Some(custom) = custom_path {
        let p = PathBuf::from(custom);
        if p.is_file() {
            return Some(p);
        }
        // Maybe they gave a directory
        let in_dir = p.join(binary_name);
        if in_dir.is_file() {
            return Some(in_dir);
        }
    }

    // Search PATH
    which_in_path(binary_name)
}

fn which_in_path(binary_name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(binary_name))
            .find(|candidate| candidate.is_file())
    })
}

// ---------------------------------------------------------------------------
// Version / capability probing
// ---------------------------------------------------------------------------

fn get_version(binary_path: &Path) -> Option<String> {
    Command::new(binary_path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let out = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        })
}

fn supports_stdin_subcommand(binary_path: &Path) -> bool {
    Command::new(binary_path)
        .args(["stdin", "--help"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

fn scan_text(
    binary_path: &Path,
    text: &str,
    use_stdin: bool,
) -> Result<Vec<TruffleHogRawResult>, String> {
    if use_stdin {
        scan_via_stdin(binary_path, text)
    } else {
        scan_via_tempfile(binary_path, text)
    }
}

fn scan_via_stdin(binary_path: &Path, text: &str) -> Result<Vec<TruffleHogRawResult>, String> {
    let mut child = Command::new(binary_path)
        .args(["stdin", "--json", "--no-update", "--no-verification"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    // Write text then drop stdin to signal EOF
    {
        let stdin = child.stdin.take().ok_or("Failed to open stdin pipe")?;
        let mut writer = std::io::BufWriter::new(stdin);
        writer
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;
        // stdin is dropped here, closing the pipe
    }

    let output = wait_with_timeout(&mut child, SCAN_TIMEOUT)?;
    parse_ndjson_output(&output.stdout)
}

fn scan_via_tempfile(binary_path: &Path, text: &str) -> Result<Vec<TruffleHogRawResult>, String> {
    let tmp_dir = std::env::temp_dir();
    let file_name = format!("scribe-goblin-{}.txt", uuid::Uuid::new_v4());
    let tmp_path = tmp_dir.join(&file_name);

    std::fs::write(&tmp_path, text).map_err(|e| e.to_string())?;

    let result = (|| {
        let mut child = Command::new(binary_path)
            .args([
                "filesystem",
                tmp_path.to_str().ok_or("Non-UTF8 temp path")?,
                "--json",
                "--no-update",
                "--no-verification",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;

        let output = wait_with_timeout(&mut child, SCAN_TIMEOUT)?;
        parse_ndjson_output(&output.stdout)
    })();

    // Always clean up
    let _ = std::fs::remove_file(&tmp_path);

    result
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Result<Output, String> {
    // Read stdout in a separate thread to prevent pipe buffer deadlock
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let reader_thread = std::thread::spawn(move || -> Result<Vec<u8>, String> {
        use std::io::Read;
        let mut buf = Vec::new();
        let mut reader = stdout;
        reader.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    });

    let poll_interval = Duration::from_millis(50);
    let start = std::time::Instant::now();

    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let stdout_bytes = reader_thread
                    .join()
                    .map_err(|_| "stdout reader thread panicked".to_string())??;
                return Ok(Output {
                    status,
                    stdout: stdout_bytes,
                    stderr: Vec::new(),
                });
            }
            None => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("TruffleHog scan timed out".to_string());
                }
                std::thread::sleep(poll_interval);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

fn parse_ndjson_output(stdout_bytes: &[u8]) -> Result<Vec<TruffleHogRawResult>, String> {
    let text = String::from_utf8_lossy(stdout_bytes);
    let mut results = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Skip lines that don't look like JSON objects
        if !trimmed.starts_with('{') {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<TruffleHogRawResult>(trimmed) {
            results.push(parsed);
        }
        // Unparseable lines are silently skipped
    }

    Ok(results)
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

fn to_findings(raw: Vec<TruffleHogRawResult>) -> Vec<TruffleHogFinding> {
    raw.into_iter()
        .map(|r| {
            let raw_redacted = if r.redacted.is_empty() {
                mask_raw(&r.raw)
            } else {
                r.redacted
            };

            TruffleHogFinding {
                detector_name: r.detector_name,
                verified: r.verified,
                raw_redacted,
                decoder: r.decoder_name,
            }
        })
        .collect()
}

fn mask_raw(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let len = chars.len();
    if len <= 8 {
        "*".repeat(len)
    } else {
        let visible: String = chars[..4].iter().collect();
        let masked = "*".repeat(len - 4);
        format!("{}{}", visible, masked)
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn trufflehog_check(
    state: State<TruffleHogState>,
    custom_path: Option<String>,
) -> Result<TruffleHogStatus, String> {
    let binary = find_trufflehog(custom_path.as_deref());

    let status = match &binary {
        Some(path) => {
            let version = get_version(path);
            let stdin_ok = supports_stdin_subcommand(path);
            TruffleHogStatus {
                available: true,
                path: Some(path.to_string_lossy().to_string()),
                version,
                supports_stdin: stdin_ok,
            }
        }
        None => TruffleHogStatus {
            available: false,
            path: None,
            version: None,
            supports_stdin: false,
        },
    };

    // Cache the result
    *state.binary_path.lock().map_err(|e| e.to_string())? = binary;
    *state.available.lock().map_err(|e| e.to_string())? = Some(status.available);

    Ok(status)
}

#[tauri::command]
pub fn trufflehog_scan(
    state: State<TruffleHogState>,
    text: String,
    custom_path: Option<String>,
) -> Result<Vec<TruffleHogFinding>, String> {
    // Resolve binary: try custom_path, then cached state, then fresh search
    let binary = if let Some(ref cp) = custom_path {
        find_trufflehog(Some(cp)).ok_or("TruffleHog not found at custom path")?
    } else {
        let cached = state.binary_path.lock().map_err(|e| e.to_string())?;
        match cached.clone() {
            Some(p) => p,
            None => {
                drop(cached);
                let found = find_trufflehog(None)
                    .ok_or("TruffleHog not found. Install it or provide a custom path.")?;
                *state.binary_path.lock().map_err(|e| e.to_string())? = Some(found.clone());
                *state.available.lock().map_err(|e| e.to_string())? = Some(true);
                found
            }
        }
    };

    let use_stdin = supports_stdin_subcommand(&binary);
    let raw = scan_text(&binary, &text, use_stdin)?;
    Ok(to_findings(raw))
}

#[cfg(test)]
mod tests {
    //! Integration tests for the TruffleHog CLI module.
    //! These tests require a real `trufflehog` binary on PATH or `TRUFFLEHOG_PATH`.
    //! Run with: `cargo test trufflehog -- --ignored`

    use super::*;

    fn resolve_test_binary() -> PathBuf {
        if let Some(custom) = std::env::var_os("TRUFFLEHOG_PATH") {
            let custom = PathBuf::from(custom);
            if custom.is_file() {
                return custom;
            }
        }

        find_trufflehog(None).expect(
            "TruffleHog binary not found. Install `trufflehog` or set TRUFFLEHOG_PATH before running ignored tests.",
        )
    }

    fn fixture_google_gemini_api_key() -> &'static str {
        "AIzaSyA12345678901234567890123456789012"
    }

    #[test]
    #[ignore]
    fn test_trufflehog_binary_can_be_found() {
        let binary = resolve_test_binary();
        assert!(
            binary.is_file(),
            "Resolved binary should be a file: {:?}",
            binary
        );
    }

    #[test]
    #[ignore]
    fn test_trufflehog_version_is_available() {
        let binary = resolve_test_binary();
        let version = get_version(&binary).expect("Expected trufflehog --version output");
        assert!(
            !version.trim().is_empty(),
            "TruffleHog version output should not be empty"
        );
    }

    #[test]
    #[ignore]
    fn test_scan_clean_text_returns_no_findings() {
        let binary = resolve_test_binary();
        let use_stdin = supports_stdin_subcommand(&binary);
        let findings = scan_text(
            &binary,
            "Hello team, this is a harmless sentence with no secrets.",
            use_stdin,
        )
        .expect("scan_text failed");
        assert!(
            findings.is_empty(),
            "Expected no findings, got {}",
            findings.len()
        );
    }

    #[test]
    #[ignore]
    fn test_scan_google_gemini_api_key_detects_findings() {
        let binary = resolve_test_binary();
        let use_stdin = supports_stdin_subcommand(&binary);
        let findings = scan_text(&binary, fixture_google_gemini_api_key(), use_stdin)
            .expect("scan_text failed for Google Gemini API key fixture");
        assert!(
            !findings.is_empty(),
            "Expected at least one finding for Google Gemini API key fixture"
        );
        assert!(
            findings.iter().any(|f| !f.detector_name.trim().is_empty()),
            "Expected at least one non-empty detector name"
        );
        assert!(
            findings
                .iter()
                .any(|f| f.detector_name == "GoogleGeminiAPIKey"),
            "Expected GoogleGeminiAPIKey detector in findings"
        );
    }

    #[test]
    #[ignore]
    fn test_scan_google_gemini_api_key_via_tempfile_detects_findings() {
        let binary = resolve_test_binary();
        let findings = scan_via_tempfile(&binary, fixture_google_gemini_api_key())
            .expect("scan_via_tempfile failed for Google Gemini API key fixture");
        assert!(
            !findings.is_empty(),
            "Expected at least one finding for Google Gemini API key fixture via tempfile"
        );
    }

    #[test]
    #[ignore]
    fn test_scan_google_gemini_api_key_via_stdin_detects_findings_when_supported() {
        let binary = resolve_test_binary();
        if !supports_stdin_subcommand(&binary) {
            return;
        }

        let findings = scan_via_stdin(&binary, fixture_google_gemini_api_key())
            .expect("scan_via_stdin failed for Google Gemini API key fixture");
        assert!(
            !findings.is_empty(),
            "Expected at least one finding for Google Gemini API key fixture via stdin"
        );
    }

    #[test]
    #[ignore]
    fn test_detected_result_contains_redaction_and_decoder() {
        let binary = resolve_test_binary();
        let use_stdin = supports_stdin_subcommand(&binary);
        let findings = scan_text(&binary, fixture_google_gemini_api_key(), use_stdin)
            .expect("scan_text failed for Google Gemini API key fixture");
        assert!(
            !findings.is_empty(),
            "Expected at least one finding for Google Gemini API key fixture"
        );
        assert!(
            findings.iter().all(|f| !f.redacted.trim().is_empty()),
            "Expected redacted output for detected findings"
        );
        assert!(
            findings.iter().all(|f| !f.decoder_name.trim().is_empty()),
            "Expected decoder name for detected findings"
        );
    }

    #[test]
    #[ignore]
    fn test_to_findings_produces_masked_output() {
        let binary = resolve_test_binary();
        let use_stdin = supports_stdin_subcommand(&binary);
        let raw = scan_text(&binary, fixture_google_gemini_api_key(), use_stdin)
            .expect("scan_text failed for Google Gemini API key fixture");
        let findings = to_findings(raw);

        assert!(
            !findings.is_empty(),
            "Expected at least one converted finding for Google Gemini API key fixture"
        );
        assert!(
            findings.iter().all(|f| !f.raw_redacted.trim().is_empty()),
            "All converted findings should include redacted output"
        );
    }
}
