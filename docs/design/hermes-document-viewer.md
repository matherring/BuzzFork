# Hermes document viewer for Buzz Desktop

Status: proposed first vertical slice
Branch: `feat/hermes-approval-actions`

## Goal

When a conversation contains a local file or directory path, render supported file
paths as clickable links. Clicking a supported text file opens a read-only document
pane on the right side of Buzz Desktop, using the same split-pane interaction model
as thread viewing. The first slice is intentionally local-only and text-only.

## First-slice formats

- `.txt`, `.md`, `.markdown`
- `.json`, `.jsonl`
- `.yaml`, `.yml`
- `.toml`, `.ini`, `.cfg`, `.conf`
- `.csv`, `.tsv`
- common source/config files: `.py`, `.js`, `.ts`, `.tsx`, `.jsx`, `.rs`, `.go`, `.sh`

Unknown extensions are not opened automatically. Binary files are never decoded as
text merely because a path was mentioned.

## Proposed flow

1. Hermes/Buzz message markdown passes local-path candidates to the desktop renderer.
2. The renderer validates the candidate as an absolute or workspace-relative path;
   URLs and shell fragments are not treated as local paths.
3. A click invokes a narrow Tauri read command with:
   - canonicalized path;
   - maximum byte limit;
   - allowed text-extension / MIME policy;
   - no write capability.
4. The desktop opens or focuses a right-side `DocumentViewerPane`.
5. The pane shows filename, path, detected language, byte/line counts, truncation
   status, and a close button.
6. Reload is explicit; the first slice does not watch the filesystem.

## Safety boundaries

- Read-only command; no write, move, delete, or execute action.
- Reject paths outside approved roots (initially the configured workspace roots and
  explicitly allowed local roots; do not silently expose the whole home directory).
- Resolve symlinks before the root check to prevent traversal escapes.
- Hard byte and line caps; show an explicit truncated state.
- Never follow a path embedded in untrusted remote content without a user click.
- Do not expose credentials or hidden files by default.
- Return typed errors for missing, denied, binary, oversized, and out-of-root files.

## Reuse points

- Existing thread panel width and right-pane state management.
- Existing markdown linkification and attachment/file-card primitives.
- Existing Tauri command registration and desktop error surfaces.
- Existing image lightbox can later become another `DocumentViewerPane` renderer.

## Later extensions

- PDF renderer with page limits and a native/system fallback.
- Image renderer using the existing lightbox path.
- Directory browser with explicit user navigation, not automatic recursive listing.
- Tabs/pinned documents and per-conversation viewer state.
- Remote/relay-hosted document references, separately permissioned from local paths.

## Upstream strategy

Keep the first PR generic and platform-owned: a safe read-only document pane and
path-link abstraction, not Hermes-specific approval or agent code. Hermes can emit
ordinary absolute paths; Buzz owns presentation and local access policy. Keep the
feature branch small, rebase it onto `main` as Block ships, and provide unit,
security-boundary, and desktop E2E coverage. If the API is generic enough, propose
it upstream; until then, build a private BuzzFork desktop package for canary use.
