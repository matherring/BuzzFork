use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::app_state::AppState;
use crate::commands::media::sanitize_filename;
use crate::commands::media_download::{fetch_blob_bytes_with_cap, validate_download_url};
use crate::relay::relay_api_base_url_with_override;

const TEXT_EXTENSIONS: &[&str] = &["csv", "markdown", "md", "txt"];
const PDF_EXTENSION: &str = "pdf";
const MAX_DISPLAY_BYTES: usize = 256 * 1024;
const MAX_TEXT_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PDF_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_DISPLAY_LINES: usize = 5_000;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocumentKind {
    Pdf,
    Text,
}

impl DocumentKind {
    fn max_bytes(self) -> u64 {
        match self {
            Self::Pdf => MAX_PDF_DOCUMENT_BYTES,
            Self::Text => MAX_TEXT_DOCUMENT_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DocumentDeniedReason {
    NotAFile,
    UntrustedAttachmentUrl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DocumentIntegrityReason {
    HashMismatch,
    InvalidHash,
    MissingHash,
    MissingSize,
    SizeMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum DocumentReadResult {
    Binary {
        source: String,
    },
    Denied {
        source: String,
        reason: DocumentDeniedReason,
    },
    Empty {
        source: String,
        file_name: String,
        extension: String,
    },
    Failed {
        source: String,
    },
    Integrity {
        source: String,
        reason: DocumentIntegrityReason,
    },
    InvalidPdf {
        source: String,
    },
    Missing {
        source: String,
    },
    Oversized {
        source: String,
        bytes_total: u64,
        max_bytes: u64,
    },
    Pdf {
        source: String,
        file_name: String,
        extension: String,
        content_base64: String,
        bytes_total: u64,
    },
    Ready {
        source: String,
        file_name: String,
        extension: String,
        content: String,
        bytes_total: u64,
        bytes_read: u64,
        line_count: usize,
        truncated: bool,
    },
    Unsupported {
        source: String,
        extension: Option<String>,
    },
}

fn source_for_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn denied(source: String, reason: DocumentDeniedReason) -> DocumentReadResult {
    DocumentReadResult::Denied { source, reason }
}

fn document_kind_for_extension(extension: Option<&str>) -> Option<DocumentKind> {
    match extension {
        Some(PDF_EXTENSION) => Some(DocumentKind::Pdf),
        Some(extension) if TEXT_EXTENSIONS.contains(&extension) => Some(DocumentKind::Text),
        _ => None,
    }
}

fn extension_for_path(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
}

fn utf8_prefix(bytes: &[u8], limit: usize) -> Result<&str, ()> {
    let candidate = &bytes[..bytes.len().min(limit)];
    match std::str::from_utf8(candidate) {
        Ok(content) => Ok(content),
        Err(error) if error.error_len().is_none() && error.valid_up_to() < candidate.len() => {
            std::str::from_utf8(&candidate[..error.valid_up_to()]).map_err(|_| ())
        }
        Err(_) => Err(()),
    }
}

fn truncate_lines(content: &str) -> (&str, bool) {
    let mut end = 0;
    for (count, segment) in content.split_inclusive('\n').enumerate() {
        if count == MAX_DISPLAY_LINES {
            return (&content[..end], true);
        }
        end += segment.len();
    }
    (content, false)
}

fn is_likely_pdf(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"%PDF-") {
        return false;
    }
    let tail_start = bytes.len().saturating_sub(2048);
    bytes[tail_start..]
        .windows(b"%%EOF".len())
        .any(|window| window == b"%%EOF")
}

fn read_document_bytes(
    source: String,
    file_name: String,
    extension: String,
    bytes: &[u8],
) -> DocumentReadResult {
    let Some(kind) = document_kind_for_extension(Some(&extension)) else {
        return DocumentReadResult::Unsupported {
            source,
            extension: Some(extension),
        };
    };
    let bytes_total = bytes.len() as u64;
    if bytes_total > kind.max_bytes() {
        return DocumentReadResult::Oversized {
            source,
            bytes_total,
            max_bytes: kind.max_bytes(),
        };
    }
    if bytes.is_empty() {
        return DocumentReadResult::Empty {
            source,
            file_name,
            extension,
        };
    }

    if kind == DocumentKind::Pdf {
        if !is_likely_pdf(bytes) {
            return DocumentReadResult::InvalidPdf { source };
        }
        return DocumentReadResult::Pdf {
            source,
            file_name,
            extension,
            content_base64: BASE64_STANDARD.encode(bytes),
            bytes_total,
        };
    }

    if bytes.contains(&0) {
        return DocumentReadResult::Binary { source };
    }
    let utf8 = match utf8_prefix(bytes, MAX_DISPLAY_BYTES) {
        Ok(content) => content,
        Err(_) => return DocumentReadResult::Binary { source },
    };
    let (content, line_truncated) = truncate_lines(utf8);
    let bytes_read = content.len() as u64;

    DocumentReadResult::Ready {
        source,
        file_name,
        extension,
        bytes_read,
        bytes_total,
        line_count: content.lines().count(),
        content: content.to_string(),
        truncated: line_truncated || bytes_read < bytes_total,
    }
}

fn resolve_local_file(
    requested_path: &Path,
) -> Result<(PathBuf, fs::Metadata), DocumentReadResult> {
    let requested_source = source_for_path(requested_path);
    let canonical_path = match requested_path.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(DocumentReadResult::Missing {
                source: requested_source,
            });
        }
        Err(_) => {
            return Err(DocumentReadResult::Failed {
                source: requested_source,
            });
        }
    };
    let metadata = match fs::metadata(&canonical_path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Err(DocumentReadResult::Failed {
                source: requested_source,
            });
        }
    };
    if !metadata.is_file() {
        return Err(denied(requested_source, DocumentDeniedReason::NotAFile));
    }
    Ok((canonical_path, metadata))
}

fn verify_expected_hash(
    source: &str,
    expected_sha256: Option<&str>,
    bytes: &[u8],
) -> Option<DocumentReadResult> {
    let Some(expected_sha256) = expected_sha256.filter(|value| !value.is_empty()) else {
        return None;
    };
    if expected_sha256.len() != 64
        || !expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Some(DocumentReadResult::Integrity {
            source: source.to_string(),
            reason: DocumentIntegrityReason::InvalidHash,
        });
    }
    let actual_sha256 = hex::encode(Sha256::digest(bytes));
    if actual_sha256 != expected_sha256.to_ascii_lowercase() {
        return Some(DocumentReadResult::Integrity {
            source: source.to_string(),
            reason: DocumentIntegrityReason::HashMismatch,
        });
    }
    None
}

pub(crate) fn read_local_document_with_expected_hash(
    requested_path: &Path,
    expected_sha256: Option<&str>,
) -> DocumentReadResult {
    let requested_source = source_for_path(requested_path);
    let (canonical_path, metadata) = match resolve_local_file(requested_path) {
        Ok(result) => result,
        Err(result) => return result,
    };

    let extension = extension_for_path(&canonical_path);
    let Some(kind) = document_kind_for_extension(extension.as_deref()) else {
        return DocumentReadResult::Unsupported {
            source: requested_source,
            extension,
        };
    };
    if metadata.len() > kind.max_bytes() {
        return DocumentReadResult::Oversized {
            source: source_for_path(&canonical_path),
            bytes_total: metadata.len(),
            max_bytes: kind.max_bytes(),
        };
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let read_result = File::open(&canonical_path)
        .and_then(|file| file.take(kind.max_bytes() + 1).read_to_end(&mut bytes));
    if read_result.is_err() {
        return DocumentReadResult::Failed {
            source: requested_source,
        };
    }
    if let Some(result) =
        verify_expected_hash(&source_for_path(&canonical_path), expected_sha256, &bytes)
    {
        return result;
    }

    let file_name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    read_document_bytes(
        source_for_path(&canonical_path),
        file_name,
        extension.unwrap_or_default(),
        &bytes,
    )
}

pub(crate) fn verify_attachment_bytes(
    source: String,
    file_name: String,
    expected_sha256: &str,
    expected_size: Option<u64>,
    bytes: &[u8],
) -> DocumentReadResult {
    if expected_sha256.is_empty() {
        return DocumentReadResult::Integrity {
            source,
            reason: DocumentIntegrityReason::MissingHash,
        };
    }
    if expected_sha256.len() != 64
        || !expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return DocumentReadResult::Integrity {
            source,
            reason: DocumentIntegrityReason::InvalidHash,
        };
    }
    let Some(expected_size) = expected_size else {
        return DocumentReadResult::Integrity {
            source,
            reason: DocumentIntegrityReason::MissingSize,
        };
    };
    if bytes.len() as u64 != expected_size {
        return DocumentReadResult::Integrity {
            source,
            reason: DocumentIntegrityReason::SizeMismatch,
        };
    }
    let actual_sha256 = hex::encode(Sha256::digest(bytes));
    if actual_sha256 != expected_sha256.to_ascii_lowercase() {
        return DocumentReadResult::Integrity {
            source,
            reason: DocumentIntegrityReason::HashMismatch,
        };
    }

    let extension = extension_for_path(Path::new(&file_name));
    let Some(extension) = extension else {
        return DocumentReadResult::Unsupported {
            source,
            extension: None,
        };
    };
    read_document_bytes(source, file_name, extension, bytes)
}

#[tauri::command]
pub(crate) fn read_local_document(
    path: String,
    expected_sha256: Option<String>,
) -> DocumentReadResult {
    read_local_document_with_expected_hash(Path::new(&path), expected_sha256.as_deref())
}

fn local_file_action_error(result: DocumentReadResult) -> String {
    match result {
        DocumentReadResult::Missing { .. } => "This file is missing.".to_string(),
        DocumentReadResult::Denied {
            reason: DocumentDeniedReason::NotAFile,
            ..
        } => "This file is unreadable.".to_string(),
        _ => "This file is unreadable.".to_string(),
    }
}

fn sha256_for_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "This file is unreadable.".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "This file is unreadable.".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn verify_local_file_checksum(path: &Path, expected_sha256: Option<&str>) -> Result<(), String> {
    let Some(expected_sha256) = expected_sha256.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if expected_sha256.len() != 64
        || !expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || sha256_for_file(path)? != expected_sha256.to_ascii_lowercase()
    {
        return Err(
            "This file's checksum does not match the SHA-256 recorded in its message.".to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn open_local_document(
    path: String,
    expected_sha256: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let (canonical_path, _) =
        resolve_local_file(Path::new(&path)).map_err(local_file_action_error)?;
    verify_local_file_checksum(&canonical_path, expected_sha256.as_deref())?;
    app.opener()
        .open_path(canonical_path.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("open file: {error}"))
}

#[tauri::command]
pub(crate) fn reveal_local_file(path: String, app: AppHandle) -> Result<(), String> {
    let (canonical_path, _) =
        resolve_local_file(Path::new(&path)).map_err(local_file_action_error)?;
    app.opener()
        .reveal_item_in_dir(&canonical_path)
        .map_err(|error| format!("reveal file: {error}"))
}

#[tauri::command]
pub(crate) fn local_document_checksum(path: String) -> Result<String, String> {
    let (canonical_path, _) =
        resolve_local_file(Path::new(&path)).map_err(local_file_action_error)?;
    sha256_for_file(&canonical_path)
}

async fn read_document_attachment_inner(
    url: String,
    filename: String,
    expected_sha256: String,
    expected_size: Option<u64>,
    state: State<'_, AppState>,
) -> DocumentReadResult {
    let filename = sanitize_filename(&filename);
    let extension = extension_for_path(Path::new(&filename));
    let Some(kind) = document_kind_for_extension(extension.as_deref()) else {
        return DocumentReadResult::Unsupported {
            source: url,
            extension,
        };
    };
    if expected_size.is_some_and(|size| size > kind.max_bytes()) {
        return DocumentReadResult::Oversized {
            source: url,
            bytes_total: expected_size.unwrap_or_default(),
            max_bytes: kind.max_bytes(),
        };
    }

    let relay_base = relay_api_base_url_with_override(&state);
    if validate_download_url(&url, &relay_base).is_err() {
        return denied(url, DocumentDeniedReason::UntrustedAttachmentUrl);
    }
    let bytes = match fetch_blob_bytes_with_cap(&url, &state, kind.max_bytes()).await {
        Ok(bytes) => bytes,
        Err(_) => return DocumentReadResult::Failed { source: url },
    };
    verify_attachment_bytes(url, filename, &expected_sha256, expected_size, &bytes)
}

#[tauri::command]
pub(crate) async fn read_document_attachment(
    url: String,
    filename: String,
    expected_sha256: String,
    expected_size: Option<u64>,
    state: State<'_, AppState>,
) -> Result<DocumentReadResult, String> {
    Ok(read_document_attachment_inner(url, filename, expected_sha256, expected_size, state).await)
}
