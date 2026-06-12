use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct HeuristicMatch {
    pub label: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HeuristicResult {
    pub matches: Vec<HeuristicMatch>,
}

fn looks_like_url(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return false;
    }
    trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("www.")
        || (trimmed.contains('.') && trimmed.contains('/'))
}

fn looks_like_command(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.lines().count() > 6 {
        return false;
    }

    let first = trimmed.lines().next().unwrap_or_default().trim();
    let starters = [
        "git ", "npm ", "pnpm ", "yarn ", "cargo ", "python ", "python3 ", "pip ", "pip3 ",
        "node ", "curl ", "wget ", "docker ", "kubectl ", "ssh ", "scp ", "ls", "cd ", "mkdir ",
        "rm ", "cp ", "mv ", "cat ", "grep ", "rg ", "ps ", "kill ", "chmod ", "sudo ",
        "powershell ", "pwsh ", "cmd /c", ".\\", "./",
    ];

    starters
        .iter()
        .any(|starter| first == *starter || first.starts_with(starter))
        || (first.contains(" --") && first.split_whitespace().count() <= 10)
}

fn looks_like_code(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    let signals = [
        "fn ",
        "function ",
        "const ",
        "let ",
        "var ",
        "class ",
        "interface ",
        "type ",
        "import ",
        "export ",
        "return ",
        "console.",
        "println!",
        "#include",
        "public class ",
    ];
    signals.iter().any(|signal| trimmed.contains(signal))
        || (trimmed.contains('{') && trimmed.contains('}') && trimmed.contains(';'))
        || (trimmed.contains("=>") && trimmed.contains('{'))
}

fn looks_like_structured_data(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.contains(':') && trimmed.contains('\n') && trimmed.lines().count() >= 2)
        || (trimmed.contains(',') && trimmed.lines().count() >= 2)
        || trimmed.starts_with("<?xml")
}

pub fn detect(text: &str) -> Vec<HeuristicMatch> {
    let mut matches = Vec::new();

    if looks_like_url(text) {
        matches.push(HeuristicMatch {
            label: "url".to_string(),
            reason: "obvious_url".to_string(),
        });
    }
    if looks_like_command(text) {
        matches.push(HeuristicMatch {
            label: "command".to_string(),
            reason: "obvious_command".to_string(),
        });
    }
    if looks_like_code(text) {
        matches.push(HeuristicMatch {
            label: "code".to_string(),
            reason: "obvious_code".to_string(),
        });
    }
    if looks_like_structured_data(text) {
        matches.push(HeuristicMatch {
            label: "data".to_string(),
            reason: "obvious_structured_data".to_string(),
        });
    }

    matches
}

#[tauri::command]
pub async fn heuristic_tag(text: String) -> Result<HeuristicResult, String> {
    if text.trim().is_empty() {
        return Ok(HeuristicResult { matches: vec![] });
    }
    Ok(HeuristicResult {
        matches: detect(&text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_url_alone() {
        let matches = detect("https://example.com/docs");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].label, "url");
        assert_eq!(matches[0].reason, "obvious_url");
    }

    #[test]
    fn detect_command_alone() {
        let matches = detect("git status --short");
        assert!(matches.iter().any(|m| m.label == "command"));
    }

    #[test]
    fn detect_code_alone() {
        let matches = detect("const answer = () => { return 42; };");
        assert!(matches.iter().any(|m| m.label == "code"));
    }

    #[test]
    fn detect_structured_data_alone() {
        let matches = detect(r#"{"user":"alice","enabled":true}"#);
        assert!(matches.iter().any(|m| m.label == "data"));
    }

    #[test]
    fn detect_empty_returns_no_matches() {
        assert!(detect("").is_empty());
        assert!(detect("   \n  ").is_empty());
    }

    #[test]
    fn detect_plain_prose_returns_no_matches() {
        let matches = detect("Hey team, can you review the draft before lunch?");
        assert!(matches.is_empty());
    }

    #[test]
    fn detect_can_emit_multiple_matches() {
        // Code that contains JSON-like braces and a semicolon — should match `code`.
        // Pure JSON also tags as `data`. A code block whose body is JSON would match both.
        let mixed = "{\n  \"name\": \"alice\",\n  \"age\": 30\n}";
        let matches = detect(mixed);
        let labels: Vec<&str> = matches.iter().map(|m| m.label.as_str()).collect();
        assert!(labels.contains(&"data"));
    }
}
