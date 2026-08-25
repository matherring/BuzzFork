import * as React from "react";

const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  "csv",
  "markdown",
  "md",
  "pdf",
  "txt",
]);

const LOCAL_FILE_LINK_PREFIX = "buzz-local-file:";
const LEGACY_LOCAL_DOCUMENT_LINK_PREFIX = "buzz-local-document:";
const TRAILING_PATH_PUNCTUATION = /[.),;:!?]+$/;
// A message can contain a normal macOS path such as
// `/tmp/Buzz Viewer Evidence/quarterly report.md`.  Prefer the first
// extension-terminated path so prose after the filename is never folded into
// the link, while retaining the no-whitespace form for extensionless files.
//
// The URL stored in the Markdown link is percent-encoded by `localFileHref`,
// so this matcher is the only place a space-containing source path is split.
const BARE_PATH_PATTERN =
  /(^|[\s(])((?:\/(?!\/))(?:[^\n`"<>]*?\.[A-Za-z0-9][A-Za-z0-9._-]*|[^\s`"<>]+))(?=$|[\s),;:!?])/g;
const INLINE_CODE_PATTERN = /(`+)([^\n]*?)\1/g;
const FENCED_CODE_PATTERN =
  /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2\3(?=\n|$)|$)/g;

export type LocalDocumentViewerRequest = {
  kind: "local";
  path: string;
  expectedSha256?: string;
};

export type AttachmentDocumentViewerRequest = {
  kind: "attachment";
  url: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
};

export type DocumentViewerRequest =
  | LocalDocumentViewerRequest
  | AttachmentDocumentViewerRequest;

export type LocalFileReference = {
  path: string;
  expectedSha256?: string;
};

let currentRequest: DocumentViewerRequest | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function documentExtension(value: string): string | null {
  const filename = value.split("/").at(-1) ?? value;
  const extension = filename.split(".").at(-1)?.toLowerCase();
  return extension && SUPPORTED_DOCUMENT_EXTENSIONS.has(extension)
    ? extension
    : null;
}

export function canPreviewDocument(filename: string): boolean {
  return documentExtension(filename) !== null;
}

export function openLocalDocument(reference: LocalFileReference | string) {
  currentRequest = {
    kind: "local",
    path: typeof reference === "string" ? reference : reference.path,
    ...(typeof reference === "string" || !reference.expectedSha256
      ? {}
      : { expectedSha256: reference.expectedSha256 }),
  };
  notify();
}

export function openAttachmentDocument(
  request: Omit<AttachmentDocumentViewerRequest, "kind">,
) {
  currentRequest = { kind: "attachment", ...request };
  notify();
}

export function closeDocumentViewer() {
  if (currentRequest === null) return;
  currentRequest = null;
  notify();
}

export function useDocumentViewerRequest() {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentRequest,
    () => null,
  );
}

export function localFileReferenceFromText(
  text: string,
): LocalFileReference | null {
  const path = text.trim().replace(TRAILING_PATH_PUNCTUATION, "");
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return { path };
}

export function localDocumentPathFromText(text: string): string | null {
  const reference = localFileReferenceFromText(text);
  return reference && canPreviewDocument(reference.path)
    ? reference.path
    : null;
}

function localFileHref(reference: LocalFileReference): string {
  const hash = reference.expectedSha256
    ? `?sha256=${encodeURIComponent(reference.expectedSha256)}`
    : "";
  return `${LOCAL_FILE_LINK_PREFIX}${encodeURIComponent(reference.path)}${hash}`;
}

function linkifyPlainText(text: string): string {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(BARE_PATH_PATTERN)) {
    const offset = match.index ?? 0;
    const [matched, prefix, candidate] = match;
    const reference = localFileReferenceFromText(candidate);
    if (!reference) continue;
    const preceding = text.slice(
      Math.max(0, offset - 2),
      offset + prefix.length,
    );
    if (preceding.endsWith("](")) continue;

    const end = offset + matched.length;
    const checksumMatch = text
      .slice(end)
      .match(/^\s*\(sha256\s+([a-f0-9]{64})\)/i);
    output += text.slice(cursor, offset);
    output += `${prefix}[${reference.path}](${localFileHref({
      ...reference,
      ...(checksumMatch ? { expectedSha256: checksumMatch[1] } : {}),
    })})${candidate.slice(reference.path.length)}`;
    cursor = end + (checksumMatch?.[0].length ?? 0);
  }
  return output + text.slice(cursor);
}

function linkifyOutsideInlineCode(text: string): string {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(INLINE_CODE_PATTERN)) {
    const index = match.index ?? 0;
    output += linkifyPlainText(text.slice(cursor, index));
    output += match[0];
    cursor = index + match[0].length;
  }
  return output + linkifyPlainText(text.slice(cursor));
}

/** Linkify bare absolute paths without rewriting fenced or inline code. */
export function linkifyLocalDocumentPaths(content: string): string {
  let output = "";
  let cursor = 0;
  for (const match of content.matchAll(FENCED_CODE_PATTERN)) {
    const index = match.index ?? 0;
    output += linkifyOutsideInlineCode(content.slice(cursor, index));
    output += match[0];
    cursor = index + match[0].length;
  }
  return output + linkifyOutsideInlineCode(content.slice(cursor));
}

export function localFileReferenceFromHref(
  href: string | undefined,
): LocalFileReference | null {
  const prefix = href?.startsWith(LOCAL_FILE_LINK_PREFIX)
    ? LOCAL_FILE_LINK_PREFIX
    : href?.startsWith(LEGACY_LOCAL_DOCUMENT_LINK_PREFIX)
      ? LEGACY_LOCAL_DOCUMENT_LINK_PREFIX
      : null;
  if (!prefix || !href) return null;
  try {
    const payload = href.slice(prefix.length);
    const [encodedPath, query] = payload.split("?", 2);
    const reference = localFileReferenceFromText(
      decodeURIComponent(encodedPath),
    );
    if (!reference) return null;
    const expectedSha256 = new URLSearchParams(query).get("sha256");
    return expectedSha256 && /^[a-f0-9]{64}$/i.test(expectedSha256)
      ? { ...reference, expectedSha256 }
      : reference;
  } catch {
    return null;
  }
}

export function localDocumentPathFromHref(
  href: string | undefined,
): string | null {
  const reference = localFileReferenceFromHref(href);
  return reference && canPreviewDocument(reference.path)
    ? reference.path
    : null;
}
