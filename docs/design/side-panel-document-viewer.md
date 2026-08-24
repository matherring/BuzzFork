# Side-panel document viewer for Buzz Desktop

Status: approved implementation
Branch: `fix/document-viewer-simplification`

## Goal

Preview explicitly requested local paths and relay-hosted document attachments in a read-only
right-side panel while keeping the conversation visible. Local cards remain inert until a user
chooses an action: their primary click opens any existing regular file in its native default
app, while **Open in Buzz Preview** is an explicit context-menu action.

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
- The path in the explicit user action is resolved to its local target and must identify an
  existing regular file. There is no folder picker, stored root, onboarding, or access settings.
- Local-card actions are deliberately single-Mac behavior and degrade to a direct missing or
  unreadable-file message where the path is not usable on that Mac.
- Native open and Finder reveal accept any existing regular file. Preview is limited to the four
  supported families; other extensions show: “Buzz preview does not support this file type yet.
  Open it in its default app instead.”
- A SHA-256 supplied with a local path is verified before preview or native open. Mismatches are
  reported without exposing document contents.
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

1. A local card primary click opens any existing regular file with the native default app. Its
   menu offers **Open in Buzz Preview**, **Open with Default App**, **Reveal in Finder**, Copy
   path, and Copy SHA-256; it has no setup or access-management actions.
2. An explicit local **Open in Buzz Preview** action or verified document attachment emits a typed
   viewer request.
3. `ChannelPane` opens `DocumentViewerPane` in the existing right auxiliary slot used by
   thread/profile views.
4. The pane shows the filename, source, counts, truncation notice, reload, and an always-visible
   close control. Escape also closes it. Relay attachments retain their Download control.
5. Closing the document reveals the previously open auxiliary view instead of navigating away
   from the conversation.

## Security controls

- No write, move, delete, execute, directory-listing, arbitrary `file://`, or persisted
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
- All existing regular local files open their native default app on primary click; preview remains
  explicit and is supported for PDF, Markdown, TXT, and CSV only.
- Both local paths and verified relay attachments use the same typed viewer contract.
- Unsupported previews, missing files, unreadable files, and checksum mismatches show direct
  reasons and never become clickable no-ops.
- Local actions require only an existing regular target; no folder must be approved first.
- Relay reads are same-origin, size-capped, and hash-verified.
- Real-file Rust tests cover direct text and PDF inputs plus boundary failures.
- Frontend tests cover request routing, typed states, panel coexistence, and attachment actions.
- The packaged CSP permits only `'self'` and `blob:` frames, allowing in-memory PDF preview
  without remote frame access.
