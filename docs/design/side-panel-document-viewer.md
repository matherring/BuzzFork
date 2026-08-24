# Side-panel document viewer for Buzz Desktop

Status: approved implementation
Branch: `feat/side-panel-document-viewer`

## Goal

Preview explicitly requested local paths and relay-hosted document attachments in a read-only
right-side panel while keeping the conversation visible. Local cards remain inert until a user
chooses an action: their primary click opens a safe type in its native default app, while
**Preview in Buzz** is an explicit context-menu action.

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

- Read only after an explicit user action; rendering a card never reads, opens, or uploads a file.
- A trusted native picker and native confirmation establish each approved root; the renderer
  cannot supply a pathname that grants access. The versioned, app-local root store is atomically
  written with restrictive permissions and roots can be listed and revoked from Document access
  settings.
- Canonicalize the picker result and requested file before policy checks. Reject `/`, the home
  directory, hidden, sensitive, system, symlink, and non-directory roots; reject symlink escapes.
- Allow only files beneath a locally user-approved root. A literal path already sent in a signed
  message remains visible to that message's recipients; card actions are deliberately single-Mac
  behavior and degrade to normal text where the file is not local.
- Reject symlink escapes, hidden components, sensitive filenames, non-files, absent files,
  unsupported extensions, oversized inputs, empty inputs, invalid PDFs, and failed reads as
  distinct states.
- Never include document contents in errors or telemetry.

### Relay attachments

- The CLI admits only the four document families in addition to the existing media types.
- For a document passed through `buzz messages send --file`, the CLI emits a normal
  `[filename](media-url)` anchor and an `imeta filename <sanitized-basename>` field. Images and
  videos retain their existing media markdown syntax. The filename is therefore available to the
  desktop file-card classifier without inferring an extension from a content-addressed blob URL.
- The relay normalizes signatureless Markdown and CSV uploads to `application/octet-stream` and a
  `.bin` blob URL. The original filename in `imeta`, rather than the transport MIME or URL suffix,
  is authoritative for routing those document cards.
- The desktop accepts only same-relay `/media/` URLs.
- The signed attachment filename selects the approved document family.
- Declared size and SHA-256 are mandatory and verified against the downloaded bytes.
- Downloads are capped before buffering; a partial or mismatched attachment is never shown.
- The original attachment retains a separate Download action.

## Interaction

1. A local card primary click opens PDF, Markdown, text, or CSV with the native default app;
   all other card types offer Finder reveal only. Its menu offers Preview in Buzz when supported,
   Reveal in Finder, Copy path, Copy SHA-256, native-picker root approval, and root settings.
2. An explicit local **Preview in Buzz** action or verified document attachment emits a typed
   viewer request.
3. `ChannelPane` opens `DocumentViewerPane` in the existing right auxiliary slot used by
   thread/profile views.
4. The pane shows the filename, source, counts, truncation notice, reload, close, and—only
   for relay attachments—download controls.
5. Closing the document reveals the previously open auxiliary view instead of navigating
   away from the conversation.

## Security controls

- No write, move, delete, execute, directory-listing, arbitrary `file://`, or renderer-provided
  root-grant capability.
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

- Markdown, text, CSV, and PDF preview in the right-side panel without hiding the timeline.
- Supported local cards open their native default app on primary click; preview remains explicit.
- Both local paths and verified relay attachments use the same typed viewer contract.
- Unsupported or disallowed inputs show an explicit reason and never become clickable no-ops.
- Local reads remain bounded to user-approved roots, including after symlink resolution.
- Relay reads are same-origin, size-capped, and hash-verified.
- Real-file Rust tests cover approved text and PDF inputs plus boundary failures.
- Frontend tests cover request routing, typed states, panel coexistence, and attachment actions.
- The packaged CSP permits only `'self'` and `blob:` frames, allowing in-memory PDF preview
  without remote frame access.
