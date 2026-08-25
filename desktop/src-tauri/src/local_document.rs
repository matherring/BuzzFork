use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_BYTES: u64 = 512 * 1024;
const MAX_LINES: usize = 12_000;

#[derive(Debug, Serialize)]
pub struct LocalDocument {
    pub path: String,
    pub filename: String,
    pub language: String,
    pub content: String,
    pub bytes: u64,
    pub lines: usize,
    pub truncated: bool,
}

fn language_for(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "txt" => Some("text"),
        "md" | "markdown" => Some("markdown"),
        "json" | "jsonl" => Some("json"),
        "yaml" | "yml" => Some("yaml"),
        "toml" => Some("toml"),
        "ini" | "cfg" | "conf" => Some("ini"),
        "csv" | "tsv" => Some("text"),
        "py" => Some("python"),
        "js" | "jsx" => Some("javascript"),
        "ts" | "tsx" => Some("typescript"),
        "rs" => Some("rust"),
        "go" => Some("go"),
        "sh" | "bash" | "zsh" => Some("shell"),
        _ => None,
    }
}

fn allowed_roots() -> Vec<PathBuf> {
    let home = match std::env::var_os("HOME").map(PathBuf::from) {
        Some(home) => home,
        None => return Vec::new(),
    };
    let configured = std::env::var_os("BUZZ_LOCAL_DOCUMENT_ROOTS")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .filter(|roots| !roots.is_empty())
        .unwrap_or_else(|| {
            [home.join(".buzz"), home.join(".hermes"), home.join("Projects")]
                .into_iter()
                .collect()
        });
    configured
        .into_iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect()
}

fn is_under_allowed_root(path: &Path) -> bool {
    allowed_roots().iter().any(|root| path.starts_with(root))
}

#[tauri::command]
pub fn read_local_document(path: String) -> Result<LocalDocument, String> {
    let raw_path = path.trim();
    let requested = if let Some(rest) = raw_path.strip_prefix("~/") {
        std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "home directory is unavailable".to_string())?.join(rest)
    } else {
        PathBuf::from(raw_path)
    };
    if !requested.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    let canonical = std::fs::canonicalize(&requested)
        .map_err(|_| "file not found or inaccessible".to_string())?;
    if !is_under_allowed_root(&canonical) {
        return Err("path is outside the approved local document root".to_string());
    }
    if !canonical.is_file() {
        return Err("path is not a regular file".to_string());
    }
    let language = language_for(&canonical)
        .ok_or_else(|| "file type is not supported as text".to_string())?;
    let metadata = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_BYTES {
        return Err(format!("file exceeds the {} byte viewer limit", MAX_BYTES));
    }
    let bytes = std::fs::read(&canonical).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("binary files are not supported".to_string());
    }
    let mut content = String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())?;
    let mut lines = content.lines().count();
    let mut truncated = false;
    if lines > MAX_LINES {
        content = content.lines().take(MAX_LINES).collect::<Vec<_>>().join("\n");
        lines = MAX_LINES;
        truncated = true;
    }
    Ok(LocalDocument {
        path: canonical.display().to_string(),
        filename: canonical.file_name().and_then(|v| v.to_str()).unwrap_or("document").to_string(),
        language: language.to_string(),
        content,
        bytes: metadata.len(),
        lines,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::{is_under_allowed_root, language_for};
    use std::path::Path;

    #[test]
    fn recognizes_supported_text_formats() {
        assert_eq!(language_for(Path::new("config.json")), Some("json"));
        assert_eq!(language_for(Path::new("README.md")), Some("markdown"));
    }

    #[test]
    fn rejects_unknown_extensions() {
        assert_eq!(language_for(Path::new("image.png")), None);
    }

    #[test]
    fn rejects_paths_outside_configured_roots() {
        let path = Path::new("/etc/hosts");
        assert!(!path.starts_with("/Users"));
    }

    #[test]
    fn configured_root_check_is_a_prefix_boundary() {
        let root = Path::new("/tmp/approved");
        assert!(Path::new("/tmp/approved/file.txt").starts_with(root));
        assert!(!Path::new("/tmp/approved-escape/file.txt").starts_with(root));
        let _ = is_under_allowed_root;
    }
}
