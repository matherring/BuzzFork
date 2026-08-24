use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
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
const DOCUMENT_ROOTS_SCHEMA_VERSION: u32 = 1;
const DOCUMENT_ROOTS_STORE_FILE: &str = "document-viewer-roots.json";
const SYSTEM_ROOTS: &[&str] = &[
    "/Applications",
    "/Library",
    "/System",
    "/bin",
    "/etc",
    "/opt",
    "/private",
    "/sbin",
    "/usr",
    "/var",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DocumentRootsStore {
    version: u32,
    roots: Vec<String>,
}

impl Default for DocumentRootsStore {
    fn default() -> Self {
        Self {
            version: DOCUMENT_ROOTS_SCHEMA_VERSION,
            roots: Vec::new(),
        }
    }
}

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
    HiddenPath,
    NotAFile,
    OutsideApprovedRoots,
    SensitiveName,
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

fn has_hidden_component(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|value| value.starts_with('.') && value != "." && value != "..")
    })
}

fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or(&lower);
    matches!(
        stem,
        "auth"
            | "credential"
            | "credentials"
            | "id_ed25519"
            | "id_rsa"
            | "private-key"
            | "private_key"
            | "secret"
            | "secrets"
            | "token"
            | "tokens"
    )
}

fn has_sensitive_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_none_or(is_sensitive_name)
}

fn has_sensitive_component(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(is_sensitive_name)
    })
}

fn is_system_root(path: &Path) -> bool {
    SYSTEM_ROOTS
        .iter()
        .map(Path::new)
        .any(|system_root| path.starts_with(system_root))
}

/// Validate a directory that the local user selected in the native picker.
///
/// The renderer cannot grant access by supplying a pathname: this helper is
/// used both after picker selection and before persistence. A canonical path
/// prevents later symlink escapes, while rejecting a symlink *selection*
/// prevents a misleading approval scope in the confirmation dialog.
pub(crate) fn canonical_document_root(requested_root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(requested_root)
        .map_err(|_| "The selected folder is no longer available.".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Choose the real folder, not a symbolic link.".to_string());
    }
    if !metadata.is_dir() {
        return Err("Choose a folder, not a file.".to_string());
    }

    let canonical = requested_root
        .canonicalize()
        .map_err(|_| "The selected folder could not be resolved safely.".to_string())?;
    if canonical == Path::new("/") {
        return Err("The filesystem root cannot be approved.".to_string());
    }
    if dirs::home_dir()
        .and_then(|home| home.canonicalize().ok())
        .is_some_and(|home| canonical == home)
    {
        return Err("Choose a specific folder inside your home directory.".to_string());
    }
    if is_system_root(&canonical) {
        return Err("System folders cannot be approved for document access.".to_string());
    }
    if has_hidden_component(&canonical) {
        return Err("Hidden folders cannot be approved for document access.".to_string());
    }
    if has_sensitive_component(&canonical) {
        return Err("Sensitive folders cannot be approved for document access.".to_string());
    }
    Ok(canonical)
}

fn document_roots_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data directory: {error}"))?
        .join("documents");
    if directory.exists() {
        let metadata = fs::symlink_metadata(&directory)
            .map_err(|error| format!("inspect document settings directory: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("document settings directory is not a safe directory".to_string());
        }
    } else {
        fs::create_dir_all(&directory)
            .map_err(|error| format!("create document settings directory: {error}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("restrict document settings directory: {error}"))?;
    }
    Ok(directory.join(DOCUMENT_ROOTS_STORE_FILE))
}

fn load_document_roots_store(app: &AppHandle) -> Result<DocumentRootsStore, String> {
    let store_path = document_roots_store_path(app)?;
    if !store_path.exists() {
        return Ok(DocumentRootsStore::default());
    }
    let bytes =
        fs::read(&store_path).map_err(|error| format!("read document-root settings: {error}"))?;
    let store: DocumentRootsStore = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse document-root settings: {error}"))?;
    if store.version != DOCUMENT_ROOTS_SCHEMA_VERSION {
        return Err("document-root settings use an unsupported version".to_string());
    }
    Ok(store)
}

fn load_document_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let store = load_document_roots_store(app)?;
    store
        .roots
        .iter()
        .map(|root| canonical_document_root(Path::new(root)))
        .collect()
}

fn save_document_roots(app: &AppHandle, roots: Vec<PathBuf>) -> Result<Vec<String>, String> {
    let mut canonical_roots = roots
        .iter()
        .map(|root| canonical_document_root(root))
        .collect::<Result<Vec<_>, _>>()?;
    canonical_roots.sort();
    canonical_roots.dedup();
    let roots = canonical_roots
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let payload = serde_json::to_vec_pretty(&DocumentRootsStore {
        version: DOCUMENT_ROOTS_SCHEMA_VERSION,
        roots: roots.clone(),
    })
    .map_err(|error| format!("serialize document-root settings: {error}"))?;
    let store_path = document_roots_store_path(app)?;
    crate::managed_agents::atomic_write_json_restricted(&store_path, &payload)?;
    Ok(roots)
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

fn resolve_local_file_with_roots(
    requested_path: &Path,
    allowed_roots: &[PathBuf],
) -> Result<(PathBuf, fs::Metadata), DocumentReadResult> {
    let requested_source = source_for_path(requested_path);
    let canonical_path = match requested_path.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            return Err(DocumentReadResult::Missing {
                source: requested_source,
            });
        }
    };
    let Some(canonical_root) = allowed_roots.iter().find_map(|root| {
        root.canonicalize()
            .ok()
            .filter(|canonical_root| canonical_path.starts_with(canonical_root))
    }) else {
        return Err(denied(
            requested_source,
            DocumentDeniedReason::OutsideApprovedRoots,
        ));
    };
    let relative_path = canonical_path
        .strip_prefix(&canonical_root)
        .unwrap_or(&canonical_path);
    if has_hidden_component(relative_path) {
        return Err(denied(requested_source, DocumentDeniedReason::HiddenPath));
    }
    if has_sensitive_name(&canonical_path) {
        return Err(denied(
            requested_source,
            DocumentDeniedReason::SensitiveName,
        ));
    }

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
    allowed_roots: &[PathBuf],
    expected_sha256: Option<&str>,
) -> DocumentReadResult {
    let requested_source = source_for_path(requested_path);
    let (canonical_path, metadata) =
        match resolve_local_file_with_roots(requested_path, allowed_roots) {
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

#[cfg(test)]
pub(crate) fn read_local_document_with_roots(
    requested_path: &Path,
    allowed_roots: &[PathBuf],
) -> DocumentReadResult {
    read_local_document_with_expected_hash(requested_path, allowed_roots, None)
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
    app: AppHandle,
) -> DocumentReadResult {
    let allowed_roots = load_document_roots(&app).unwrap_or_default();
    read_local_document_with_expected_hash(
        Path::new(&path),
        &allowed_roots,
        expected_sha256.as_deref(),
    )
}

/// Let the native picker and native confirmation dialog establish a new root.
///
/// This deliberately accepts no renderer-provided path: a message author can
/// control card text, and the renderer is not a permission authority. The
/// selected canonical directory is shown in the trusted dialog before it is
/// persisted, so cancellation leaves the root store untouched.
#[tauri::command]
pub(crate) async fn choose_document_root(app: AppHandle) -> Result<Option<Vec<String>>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = sender.send(path);
    });
    let selected = receiver
        .await
        .map_err(|_| "folder picker closed unexpectedly".to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .as_path()
        .ok_or_else(|| "the selected folder path is invalid".to_string())?;
    let canonical = canonical_document_root(path)?;
    let canonical_scope = canonical.to_string_lossy().into_owned();

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Allow Buzz to read local files under:\n\n{canonical_scope}\n\n\
             Buzz will not upload those files. You can revoke this folder in Document access settings."
        ))
        .title("Approve document folder?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Approve".into(),
            "Cancel".into(),
        ))
        .show(move |approved| {
            let _ = sender.send(approved);
        });
    let approved = receiver
        .await
        .map_err(|_| "folder approval closed unexpectedly".to_string())?;
    if !approved {
        return Ok(None);
    }

    let mut roots = load_document_roots(&app)?;
    roots.push(canonical);
    save_document_roots(&app, roots).map(Some)
}

#[tauri::command]
pub(crate) fn list_document_roots(app: AppHandle) -> Result<Vec<String>, String> {
    load_document_roots_store(&app).map(|store| store.roots)
}

#[tauri::command]
pub(crate) fn remove_document_root(root: String, app: AppHandle) -> Result<Vec<String>, String> {
    let mut store = load_document_roots_store(&app)?;
    store.roots.retain(|existing| existing != &root);
    store.roots.sort();
    store.roots.dedup();
    let payload = serde_json::to_vec_pretty(&store)
        .map_err(|error| format!("serialize document-root settings: {error}"))?;
    let store_path = document_roots_store_path(&app)?;
    crate::managed_agents::atomic_write_json_restricted(&store_path, &payload)?;
    Ok(store.roots)
}

#[tauri::command]
pub(crate) fn open_local_document(
    path: String,
    expected_sha256: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let allowed_roots = load_document_roots(&app)?;
    match read_local_document_with_expected_hash(
        Path::new(&path),
        &allowed_roots,
        expected_sha256.as_deref(),
    ) {
        DocumentReadResult::Pdf { .. } | DocumentReadResult::Ready { .. } => {
            let (canonical_path, _) =
                resolve_local_file_with_roots(Path::new(&path), &allowed_roots)
                    .map_err(|_| "This document is no longer available for opening.".to_string())?;
            app.opener()
                .open_path(canonical_path.to_string_lossy(), None::<&str>)
                .map_err(|error| format!("open document: {error}"))
        }
        _ => Err("This file did not pass Buzz's local-document safety checks.".to_string()),
    }
}

#[tauri::command]
pub(crate) fn reveal_local_file(path: String, app: AppHandle) -> Result<(), String> {
    let allowed_roots = load_document_roots(&app)?;
    let (canonical_path, _) = resolve_local_file_with_roots(Path::new(&path), &allowed_roots)
        .map_err(|_| "This file is outside the approved document folders.".to_string())?;
    app.opener()
        .reveal_item_in_dir(&canonical_path)
        .map_err(|error| format!("reveal document: {error}"))
}

#[tauri::command]
pub(crate) fn local_document_checksum(path: String, app: AppHandle) -> Result<String, String> {
    let allowed_roots = load_document_roots(&app)?;
    let (canonical_path, metadata) =
        resolve_local_file_with_roots(Path::new(&path), &allowed_roots)
            .map_err(|_| "This file is outside the approved document folders.".to_string())?;
    let extension = extension_for_path(&canonical_path);
    let Some(kind) = document_kind_for_extension(extension.as_deref()) else {
        return Err("Checksums are available only for supported local document types.".to_string());
    };
    if metadata.len() > kind.max_bytes() {
        return Err("This document exceeds Buzz's safe checksum size limit.".to_string());
    }
    let bytes =
        fs::read(&canonical_path).map_err(|error| format!("read document checksum: {error}"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
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
