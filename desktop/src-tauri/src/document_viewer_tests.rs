use std::fs;

use sha2::{Digest, Sha256};
use tempfile::tempdir;

use crate::commands::document_viewer::{
    canonical_document_root, read_local_document_with_expected_hash,
    read_local_document_with_roots, verify_attachment_bytes, DocumentDeniedReason,
    DocumentIntegrityReason, DocumentReadResult,
};

fn source(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn rejects_the_filesystem_root_and_regular_files_as_document_roots() {
    assert!(canonical_document_root(std::path::Path::new("/")).is_err());

    let root = tempdir().expect("temp root");
    let file = root.path().join("REPORT.md");
    fs::write(&file, "report").expect("write fixture");
    assert!(canonical_document_root(&file).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_a_symlink_selected_as_a_document_root() {
    use std::os::unix::fs::symlink;

    let root = tempdir().expect("temp root");
    let link_parent = tempdir().expect("link parent");
    let link = link_parent.path().join("linked-root");
    symlink(root.path(), &link).expect("create symlink");

    assert!(canonical_document_root(&link).is_err());
}

#[test]
fn reads_supported_text_file_inside_an_approved_root() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("REPORT.md");
    fs::write(&path, "# Answer\n\n42\n").expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Ready {
            source: source(&path.canonicalize().expect("canonical fixture")),
            file_name: "REPORT.md".into(),
            extension: "md".into(),
            content: "# Answer\n\n42\n".into(),
            bytes_total: 13,
            bytes_read: 13,
            line_count: 3,
            truncated: false,
        }
    );
}

#[test]
fn rejects_a_local_document_when_its_declared_hash_does_not_match() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("REPORT.md");
    fs::write(&path, "# Answer\n").expect("write fixture");

    let result = read_local_document_with_expected_hash(
        &path,
        &[root.path().to_path_buf()],
        Some(&"a".repeat(64)),
    );

    assert_eq!(
        result,
        DocumentReadResult::Integrity {
            source: source(&path.canonicalize().expect("canonical fixture")),
            reason: DocumentIntegrityReason::HashMismatch,
        }
    );
}

#[test]
fn accepts_a_local_document_when_its_declared_hash_matches() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("REPORT.md");
    let bytes = b"# Answer\n";
    fs::write(&path, bytes).expect("write fixture");
    let hash = hex::encode(Sha256::digest(bytes));

    assert!(matches!(
        read_local_document_with_expected_hash(&path, &[root.path().to_path_buf()], Some(&hash)),
        DocumentReadResult::Ready { .. }
    ));
}

#[test]
fn reads_pdf_file_inside_an_approved_root() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("REPORT.pdf");
    let bytes = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n";
    fs::write(&path, bytes).expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    match result {
        DocumentReadResult::Pdf {
            source: actual_source,
            file_name,
            extension,
            content_base64,
            bytes_total,
        } => {
            assert_eq!(
                actual_source,
                source(&path.canonicalize().expect("canonical fixture"))
            );
            assert_eq!(file_name, "REPORT.pdf");
            assert_eq!(extension, "pdf");
            assert_eq!(bytes_total, bytes.len() as u64);
            assert!(!content_base64.is_empty());
        }
        other => panic!("expected PDF result, got {other:?}"),
    }
}

#[test]
fn reports_invalid_pdf_distinctly() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("BROKEN.pdf");
    fs::write(&path, b"not a PDF").expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::InvalidPdf {
            source: source(&path.canonicalize().expect("canonical fixture")),
        }
    );
}

#[test]
fn reports_a_missing_file_as_absent_not_failed() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("MISSING.md");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Missing {
            source: source(&path),
        }
    );
}

#[test]
fn denies_files_outside_the_approved_roots() {
    let root = tempdir().expect("temp root");
    let outside = tempdir().expect("outside root");
    let path = outside.path().join("REPORT.md");
    fs::write(&path, "private").expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Denied {
            source: source(&path),
            reason: DocumentDeniedReason::OutsideApprovedRoots,
        }
    );
}

#[cfg(unix)]
#[test]
fn denies_symlinks_that_escape_an_approved_root() {
    use std::os::unix::fs::symlink;

    let root = tempdir().expect("temp root");
    let outside = tempdir().expect("outside root");
    let target = outside.path().join("SECRET.md");
    let path = root.path().join("LINK.md");
    fs::write(&target, "private").expect("write target");
    symlink(&target, &path).expect("create symlink");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Denied {
            source: source(&path),
            reason: DocumentDeniedReason::OutsideApprovedRoots,
        }
    );
}

#[test]
fn denies_hidden_path_components_beneath_an_approved_root() {
    let root = tempdir().expect("temp root");
    let hidden = root.path().join(".private");
    fs::create_dir(&hidden).expect("create hidden directory");
    let path = hidden.join("NOTES.md");
    fs::write(&path, "private").expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Denied {
            source: source(&path),
            reason: DocumentDeniedReason::HiddenPath,
        }
    );
}

#[test]
fn denies_sensitive_filenames_even_when_the_extension_is_supported() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("credentials.txt");
    fs::write(&path, "secret").expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Denied {
            source: source(&path),
            reason: DocumentDeniedReason::SensitiveName,
        }
    );
}

#[test]
fn reports_unsupported_extensions_without_reading_content() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("ARCHIVE.zip");
    fs::write(&path, b"PK\x03\x04").expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Unsupported {
            source: source(&path),
            extension: Some("zip".into()),
        }
    );
}

#[test]
fn reports_directories_as_denied() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("folder.md");
    fs::create_dir(&path).expect("create fixture directory");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Denied {
            source: source(&path),
            reason: DocumentDeniedReason::NotAFile,
        }
    );
}

#[test]
fn reports_empty_documents_distinctly() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("EMPTY.txt");
    fs::write(&path, "").expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Empty {
            source: source(&path.canonicalize().expect("canonical fixture")),
            file_name: "EMPTY.txt".into(),
            extension: "txt".into(),
        }
    );
}

#[test]
fn reports_non_utf8_text_as_binary() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("BINARY.txt");
    fs::write(&path, [0xff, 0xfe, 0x00]).expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Binary {
            source: source(&path.canonicalize().expect("canonical fixture")),
        }
    );
}

#[test]
fn rejects_oversized_text_documents_before_reading_them() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("LARGE.txt");
    let file = fs::File::create(&path).expect("create fixture");
    file.set_len(2 * 1024 * 1024 + 1).expect("size fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    assert_eq!(
        result,
        DocumentReadResult::Oversized {
            source: source(&path.canonicalize().expect("canonical fixture")),
            bytes_total: 2 * 1024 * 1024 + 1,
            max_bytes: 2 * 1024 * 1024,
        }
    );
}

#[test]
fn truncates_supported_documents_at_the_display_byte_limit() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("LONG.txt");
    fs::write(&path, vec![b'a'; 300 * 1024]).expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    match result {
        DocumentReadResult::Ready {
            content,
            bytes_total,
            bytes_read,
            line_count,
            truncated,
            ..
        } => {
            assert_eq!(content.len(), 256 * 1024);
            assert_eq!(bytes_total, 300 * 1024);
            assert_eq!(bytes_read, 256 * 1024);
            assert_eq!(line_count, 1);
            assert!(truncated);
        }
        other => panic!("expected ready result, got {other:?}"),
    }
}

#[test]
fn truncates_supported_documents_at_the_line_limit() {
    let root = tempdir().expect("temp root");
    let path = root.path().join("LINES.txt");
    fs::write(&path, "line\n".repeat(5_001)).expect("write fixture");

    let result = read_local_document_with_roots(&path, &[root.path().to_path_buf()]);

    match result {
        DocumentReadResult::Ready {
            content,
            bytes_read,
            line_count,
            truncated,
            ..
        } => {
            assert_eq!(content.lines().count(), 5_000);
            assert_eq!(bytes_read, 25_000);
            assert_eq!(line_count, 5_000);
            assert!(truncated);
        }
        other => panic!("expected ready result, got {other:?}"),
    }
}

#[test]
fn verifies_attachment_hash_and_size_before_returning_content() {
    let bytes = b"heading,value\nanswer,42\n";
    let hash = hex::encode(Sha256::digest(bytes));

    let result = verify_attachment_bytes(
        "https://relay.example/media/hash.bin".into(),
        "REPORT.csv".into(),
        &hash,
        Some(bytes.len() as u64),
        bytes,
    );

    assert!(matches!(
        result,
        DocumentReadResult::Ready {
            extension,
            truncated: false,
            ..
        } if extension == "csv"
    ));
}

#[test]
fn rejects_attachment_hash_mismatch_as_integrity_failure() {
    let bytes = b"document";

    let result = verify_attachment_bytes(
        "https://relay.example/media/hash.bin".into(),
        "REPORT.txt".into(),
        &"0".repeat(64),
        Some(bytes.len() as u64),
        bytes,
    );

    assert_eq!(
        result,
        DocumentReadResult::Integrity {
            source: "https://relay.example/media/hash.bin".into(),
            reason: DocumentIntegrityReason::HashMismatch,
        }
    );
}

#[test]
fn distinguishes_empty_attachment_from_missing_size_metadata() {
    let hash = hex::encode(Sha256::digest([]));
    let source = "https://relay.example/media/empty.bin".to_string();

    let empty = verify_attachment_bytes(source.clone(), "EMPTY.txt".into(), &hash, Some(0), &[]);
    assert!(matches!(empty, DocumentReadResult::Empty { .. }));

    let absent = verify_attachment_bytes(source.clone(), "EMPTY.txt".into(), &hash, None, &[]);
    assert_eq!(
        absent,
        DocumentReadResult::Integrity {
            source,
            reason: DocumentIntegrityReason::MissingSize,
        }
    );
}
