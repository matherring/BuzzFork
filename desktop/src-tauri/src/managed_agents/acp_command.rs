//! Resolution for the Desktop-owned ACP harness.
//!
//! A release build must never mix its desktop binary with an ACP harness from
//! a workspace, `PATH`, or another installed Buzz bundle.  The default harness
//! is therefore resolved as an identity-bound sibling of the running binary.

use std::path::{Path, PathBuf};

use super::{resolve_command, DEFAULT_ACP_COMMAND};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcpResolutionMode {
    /// A packaged/release desktop must use only its own bundled harness.
    Packaged,
    /// Developer builds retain normal workspace and PATH discovery.
    Developer,
}

fn is_nonempty_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn bundled_acp_path(current_exe: &Path) -> Result<PathBuf, String> {
    current_exe
        .parent()
        .map(|dir| dir.join(format!("buzz-acp{}", std::env::consts::EXE_SUFFIX)))
        .ok_or_else(|| {
            format!(
                "cannot determine the bundled buzz-acp sibling for running executable {}",
                current_exe.display()
            )
        })
}

fn running_bundle_path(current_exe: &Path) -> &Path {
    current_exe
        .ancestors()
        .find(|path| path.file_name().is_some_and(|name| name == "Buzz.app"))
        .unwrap_or(current_exe)
}

fn missing_bundled_acp_error(expected: &Path, current_exe: &Path) -> String {
    format!(
        "Bundled buzz-acp is required at {} for running Buzz {} from {} (executable {}). The running bundle may have been moved or deleted after launch; restore the approved BuzzFork bundle at its stable install path. Buzz will not fall back to a workspace, PATH, or another installed Buzz version.",
        expected.display(),
        env!("CARGO_PKG_VERSION"),
        running_bundle_path(current_exe).display(),
        current_exe.display(),
    )
}

/// Resolve an ACP command with release identity binding for the Desktop default.
///
/// Absolute custom commands (for example an explicitly configured Hermes
/// sidecar) retain their deliberate path semantics. Other custom commands keep
/// normal workspace/PATH discovery. Only the Desktop default `buzz-acp` is
/// bundle-bound in a packaged build.
pub(crate) fn resolve_acp_command_with(
    command: &str,
    mode: AcpResolutionMode,
    current_exe: &Path,
) -> Result<PathBuf, String> {
    if command.trim() != DEFAULT_ACP_COMMAND {
        return resolve_command(command).ok_or_else(|| {
            format!("ACP harness command `{command}` was not found or is not executable")
        });
    }

    if mode == AcpResolutionMode::Developer {
        return resolve_command(DEFAULT_ACP_COMMAND).ok_or_else(|| {
            "ACP harness command `buzz-acp` was not found or is not executable".to_string()
        });
    }

    let expected = bundled_acp_path(current_exe)?;
    if is_nonempty_executable(&expected) {
        Ok(expected)
    } else {
        Err(missing_bundled_acp_error(&expected, current_exe))
    }
}

/// Resolve the ACP command used by Desktop spawn, discovery, authentication,
/// readiness availability, and related probes.
pub(crate) fn resolve_acp_command(command: &str) -> Result<PathBuf, String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("cannot determine running Buzz executable: {error}"))?;
    let mode = if cfg!(debug_assertions) {
        AcpResolutionMode::Developer
    } else {
        AcpResolutionMode::Packaged
    };
    resolve_acp_command_with(command, mode, &current_exe)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use super::{resolve_acp_command_with, AcpResolutionMode};

    #[cfg(unix)]
    fn write_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, b"#!/bin/sh\nexit 0\n").expect("write test executable");
        let mut permissions = fs::metadata(path).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("chmod test executable");
    }

    #[test]
    #[cfg(unix)]
    fn packaged_default_uses_same_bundle_sidecar() {
        let temp = tempfile::tempdir().expect("tempdir");
        let macos = temp.path().join("Buzz.app/Contents/MacOS");
        fs::create_dir_all(&macos).expect("bundle dirs");
        let desktop = macos.join("buzz-desktop");
        let sidecar = macos.join("buzz-acp");
        write_executable(&desktop);
        write_executable(&sidecar);

        assert_eq!(
            resolve_acp_command_with("buzz-acp", AcpResolutionMode::Packaged, &desktop)
                .expect("same-bundle sidecar"),
            sidecar
        );
    }

    #[test]
    #[cfg(unix)]
    fn packaged_default_never_uses_compile_time_or_deleted_workspace_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let macos = temp.path().join("Buzz.app/Contents/MacOS");
        fs::create_dir_all(&macos).expect("bundle dirs");
        let desktop = macos.join("buzz-desktop");
        write_executable(&desktop);
        let stale = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/buzz-acp");
        let error = resolve_acp_command_with("buzz-acp", AcpResolutionMode::Packaged, &desktop)
            .expect_err("missing sibling must fail closed");

        assert!(error.contains(&macos.join("buzz-acp").display().to_string()));
        assert!(!error.contains(&stale.display().to_string()));
        assert!(error.contains("may have been moved or deleted"));
    }

    #[test]
    #[cfg(unix)]
    fn packaged_missing_sidecar_reports_exact_expected_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let macos = temp.path().join("Buzz.app/Contents/MacOS");
        fs::create_dir_all(&macos).expect("bundle dirs");
        let desktop = macos.join("buzz-desktop");
        write_executable(&desktop);

        let error = resolve_acp_command_with("buzz-acp", AcpResolutionMode::Packaged, &desktop)
            .expect_err("missing sibling must fail");
        assert!(error.contains(&macos.join("buzz-acp").display().to_string()));
        assert!(error.contains(&desktop.display().to_string()));
    }

    #[test]
    #[cfg(unix)]
    fn deliberate_absolute_custom_command_is_preserved() {
        let temp = tempfile::tempdir().expect("tempdir");
        let custom = temp.path().join("hermes-acp");
        write_executable(&custom);
        let desktop = temp.path().join("Buzz.app/Contents/MacOS/buzz-desktop");

        assert_eq!(
            resolve_acp_command_with(
                custom.to_str().expect("utf8 path"),
                AcpResolutionMode::Packaged,
                &desktop,
            )
            .expect("custom command"),
            custom
        );
    }
}
