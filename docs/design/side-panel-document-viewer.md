# Side-panel document viewer for Buzz Desktop

Status: approved implementation
Branch: `feat/side-panel-document-viewer`

## Goal

Open approved local paths and relay-hosted document attachments in a read-only right-side
panel while keeping the conversation visible. A click must either open the viewer or show
an explicit typed error; document links must never be inert.

## Supported formats and limits

| Family | Extensions | Read cap | Display behavior |
| --- | --- | ---: | --- |
| Markdown | `.md`, `.markdown` | 2 MiB | Rendered with non-interactive shared Markdown |
| Text | `.txt` | 2 MiB | Monospace preformatted text |
| CSV | `.csv` | 2 MiB | Monospace preformatted text |
| PDF | `.pdf` | 20 MiB | Local in-memory blob framed in the panel |

Text display is additionally capped at 256 KiB and 5,000 lines. The result announces
truncation and the source byte count. A PDF must have a PDF header and terminal EOF marker;
the viewer never guesses from an extension alone.

## Sources

### Local paths

- Read only after an explicit click.
- Canonicalize before policy checks.
- Allow only files under the Buzz workspace root (`~/.buzz`).
- Reject symlink escapes, hidden components, sensitive filenames, non-files, absent files,
  unsupported extensions, oversized inputs, empty inputs, invalid PDFs, and failed reads as
  distinct states.
- Never include document contents in errors or telemetry.

### Relay attachments

- The CLI admits only the four document families in addition to the existing media types.
- The desktop accepts only same-relay `/media/` URLs.
- The signed attachment filename selects the approved document family.
- Declared size and SHA-256 are mandatory and verified against the downloaded bytes.
- Downloads are capped before buffering; a partial or mismatched attachment is never shown.
- The original attachment retains a separate Download action.

## Interaction

1. A local path link or verified document attachment emits a typed viewer request.
2. `ChannelPane` opens `DocumentViewerPane` in the existing right auxiliary slot used by
   thread/profile views.
3. The pane shows the filename, source, counts, truncation notice, reload, close, and—only
   for relay attachments—download controls.
4. Closing the document reveals the previously open auxiliary view instead of navigating
   away from the conversation.

## Security controls

- No write, move, delete, execute, directory-listing, or arbitrary `file://` capability.
- No remote frame permission. PDF rendering requires the narrow CSP directive
  `frame-src 'self' blob:` so only app-local and in-memory frames are available.
- Markdown loaded from a document is rendered non-interactively, preventing nested path or
  attachment actions.
- Attachment fetches reuse the relay URL validator and authenticated media client.

## Typed results

The Tauri boundary differentiates `ready`, `pdf`, `empty`, `missing`, `denied`, `unsupported`,
`oversized`, `binary`, `invalid_pdf`, `integrity`, and `failed`. Every non-success state maps
to a visible panel message.

## Acceptance criteria

- Markdown, text, CSV, and PDF open in the right-side panel without hiding the timeline.
- Both local paths and verified relay attachments work through the same panel contract.
- Unsupported or disallowed inputs show an explicit reason and never become clickable no-ops.
- Local reads remain bounded to `~/.buzz`, including after symlink resolution.
- Relay reads are same-origin, size-capped, and hash-verified.
- Real-file Rust tests cover approved text and PDF inputs plus boundary failures.
- Frontend tests cover request routing, typed states, panel coexistence, and attachment actions.
- The packaged canary preserves executable sidecars and has a documented rollback to the
  installed normal build.
