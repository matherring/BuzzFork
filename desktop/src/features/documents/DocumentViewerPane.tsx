import * as React from "react";
import { AlertCircle, Download, FileText, RefreshCw } from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { toast } from "sonner";

import type { DocumentViewerRequest } from "@/features/documents/localDocumentViewer";
import { invokeTauri } from "@/shared/api/tauri";
import {
  AuxiliaryPanel,
  AuxiliaryPanelBody,
  AuxiliaryPanelHeader,
  AuxiliaryPanelHeaderActions,
  AuxiliaryPanelHeaderGroup,
  AuxiliaryPanelHeaderTitleBlock,
  type AuxiliaryPanelLayout,
  AUXILIARY_PANEL_DEFAULT_WIDTH_PX,
} from "@/shared/layout/AuxiliaryPanel";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type DocumentDeniedReason = "not_a_file" | "untrusted_attachment_url";

export type DocumentIntegrityReason =
  | "hash_mismatch"
  | "invalid_hash"
  | "missing_hash"
  | "missing_size"
  | "size_mismatch";

export type DocumentReadResult =
  | { status: "binary"; source: string }
  | { status: "denied"; source: string; reason: DocumentDeniedReason }
  | {
      status: "empty";
      source: string;
      file_name: string;
      extension: string;
    }
  | { status: "failed"; source: string }
  | {
      status: "integrity";
      source: string;
      reason: DocumentIntegrityReason;
    }
  | { status: "invalid_pdf"; source: string }
  | { status: "missing"; source: string }
  | {
      status: "oversized";
      source: string;
      bytes_total: number;
      max_bytes: number;
    }
  | {
      status: "pdf";
      source: string;
      file_name: string;
      extension: string;
      content_base64: string;
      bytes_total: number;
    }
  | {
      status: "ready";
      source: string;
      file_name: string;
      extension: string;
      content: string;
      bytes_total: number;
      bytes_read: number;
      line_count: number;
      truncated: boolean;
    }
  | { status: "unsupported"; source: string; extension: string | null };

const DENIED_MESSAGES: Record<DocumentDeniedReason, string> = {
  not_a_file: "This path does not identify a regular file.",
  untrusted_attachment_url:
    "This attachment URL is not a trusted media path on the active Buzz relay.",
};

const INTEGRITY_MESSAGES: Record<DocumentIntegrityReason, string> = {
  hash_mismatch:
    "This attachment does not match the SHA-256 recorded in its message.",
  invalid_hash: "This attachment has an invalid SHA-256 value in its message.",
  missing_hash: "This attachment has no SHA-256 value and cannot be verified.",
  missing_size: "This attachment has no verified size and cannot be opened.",
  size_mismatch:
    "This attachment does not match the size recorded in its message.",
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function failureMessage(
  result: Exclude<DocumentReadResult, { status: "ready" } | { status: "pdf" }>,
  request: DocumentViewerRequest,
) {
  const local = request.kind === "local";
  switch (result.status) {
    case "binary":
      return local
        ? "This file is unreadable."
        : "This file contains binary or non-UTF-8 data and cannot be displayed as text.";
    case "denied":
      return local
        ? "This file is unreadable."
        : DENIED_MESSAGES[result.reason];
    case "empty":
      return local ? "This file is unreadable." : "This document is empty.";
    case "failed":
      return local
        ? "This file is unreadable."
        : "Buzz could not read this document.";
    case "integrity":
      return local
        ? "This file's checksum does not match the SHA-256 recorded in its message."
        : INTEGRITY_MESSAGES[result.reason];
    case "invalid_pdf":
      return local
        ? "This file is unreadable."
        : "This file has a .pdf name but is not a structurally complete PDF.";
    case "missing":
      return local
        ? "This file is missing."
        : "This document no longer exists at the requested path.";
    case "oversized":
      return local
        ? "This file is unreadable."
        : `This document is ${formatBytes(result.bytes_total)}; the viewer limit is ${formatBytes(result.max_bytes)}.`;
    case "unsupported":
      if (local) {
        return "Buzz preview does not support this file type yet. Open it in its default app instead.";
      }
      return result.extension
        ? `Files with the .${result.extension} extension are not supported in the viewer.`
        : "Files without a supported document extension are not available in the viewer.";
  }
}

function displayContent(
  result: Extract<DocumentReadResult, { status: "ready" }>,
) {
  return { content: result.content, notice: null as string | null };
}

type DocumentPreviewRequest = DocumentViewerRequest;

function loadDocument(request: DocumentPreviewRequest) {
  if (request.kind === "local") {
    return invokeTauri<DocumentReadResult>("read_local_document", {
      expectedSha256: request.expectedSha256,
      path: request.path,
    });
  }
  return invokeTauri<DocumentReadResult>("read_document_attachment", {
    expectedSha256: request.sha256,
    expectedSize: request.size,
    filename: request.filename,
    url: request.url,
  });
}

function requestTitle(request: DocumentPreviewRequest) {
  return request.kind === "local"
    ? (request.path.split("/").at(-1) ?? "Document")
    : request.filename;
}

function requestSourceLabel(request: DocumentPreviewRequest) {
  return request.kind === "local" ? request.path : "Buzz attachment";
}

function pdfBytes(contentBase64: string): Uint8Array {
  const decoded = window.atob(contentBase64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function PdfPreview({
  contentBase64,
  title,
}: {
  contentBase64: string;
  title: string;
}) {
  const pagesRef = React.useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = React.useState(false);

  React.useEffect(() => {
    const pages = pagesRef.current;
    if (!pages) return;

    let disposed = false;
    const loadingTask = getDocument({ data: pdfBytes(contentBase64) });
    pages.replaceChildren();
    setRenderError(false);

    void loadingTask.promise
      .then(async (document) => {
        for (
          let pageNumber = 1;
          pageNumber <= document.numPages;
          pageNumber += 1
        ) {
          if (disposed) return;
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = window.document.createElement("canvas");
          canvas.className = "block h-auto max-w-full bg-white shadow-sm";
          canvas.dataset.testid = "document-viewer-pdf-page";
          canvas.setAttribute("aria-label", `${title}, page ${pageNumber}`);
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvas, viewport }).promise;
          if (disposed) return;
          pages.append(canvas);
        }
      })
      .catch(() => {
        if (!disposed) setRenderError(true);
      });

    return () => {
      disposed = true;
      pages.replaceChildren();
      void loadingTask.destroy();
    };
  }, [contentBase64, title]);

  if (renderError) {
    return (
      <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-muted-foreground">
        Buzz could not render this PDF. Open it in the default app instead.
      </div>
    );
  }

  return (
    <section
      aria-label={title}
      className="flex min-h-0 flex-1 flex-col items-center gap-4 overflow-auto bg-muted/30 p-4"
      data-testid="document-viewer-pdf"
      ref={pagesRef}
    />
  );
}

export function DocumentViewerPane({
  isSinglePanelView = false,
  layout = "standalone",
  onClose,
  request,
  transparentChrome = false,
  widthPx = AUXILIARY_PANEL_DEFAULT_WIDTH_PX,
}: {
  isSinglePanelView?: boolean;
  layout?: AuxiliaryPanelLayout;
  onClose: () => void;
  request: DocumentViewerRequest;
  transparentChrome?: boolean;
  widthPx?: number;
}) {
  return (
    <DocumentPreviewPane
      isSinglePanelView={isSinglePanelView}
      layout={layout}
      onClose={onClose}
      request={request}
      transparentChrome={transparentChrome}
      widthPx={widthPx}
    />
  );
}

function DocumentPreviewPane({
  isSinglePanelView,
  layout,
  onClose,
  request,
  transparentChrome,
  widthPx,
}: {
  isSinglePanelView: boolean;
  layout: AuxiliaryPanelLayout;
  onClose: () => void;
  request: DocumentPreviewRequest;
  transparentChrome: boolean;
  widthPx: number;
}) {
  const [reloadToken, setReloadToken] = React.useState(0);
  const [result, setResult] = React.useState<DocumentReadResult | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);

  React.useEffect(() => {
    void reloadToken;
    let disposed = false;
    setLoading(true);
    setResult(null);
    void loadDocument(request)
      .then((next) => {
        if (!disposed) setResult(next);
      })
      .catch(() => {
        if (!disposed) {
          setResult({
            status: "failed",
            source: request.kind === "local" ? request.path : request.url,
          });
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [request, reloadToken]);

  const ready = result?.status === "ready" ? displayContent(result) : null;
  const title =
    result &&
    (result.status === "ready" ||
      result.status === "pdf" ||
      result.status === "empty")
      ? result.file_name
      : requestTitle(request);

  const downloadAttachment =
    request.kind === "attachment"
      ? () => {
          invokeTauri("download_file", {
            filename: request.filename,
            url: request.url,
          }).catch((error: unknown) => {
            toast.error(
              error instanceof Error ? error.message : "Download failed",
            );
          });
        }
      : null;

  const header = (
    <AuxiliaryPanelHeader>
      <AuxiliaryPanelHeaderGroup>
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <AuxiliaryPanelHeaderTitleBlock
          subtitle={requestSourceLabel(request)}
          subtitleTitle={result?.source ?? requestSourceLabel(request)}
          title={title}
        />
      </AuxiliaryPanelHeaderGroup>
      <AuxiliaryPanelHeaderActions>
        {downloadAttachment ? (
          <Button
            aria-label={`Download ${title}`}
            onClick={downloadAttachment}
            size="icon"
            title={`Download ${title}`}
            type="button"
            variant="ghost"
          >
            <Download className="h-4 w-4" />
          </Button>
        ) : null}
        <Button
          aria-label="Reload document"
          disabled={loading}
          onClick={() => setReloadToken((value) => value + 1)}
          size="icon"
          title="Reload document"
          type="button"
          variant="ghost"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </AuxiliaryPanelHeaderActions>
    </AuxiliaryPanelHeader>
  );

  return (
    <AuxiliaryPanel
      header={header}
      isSinglePanelView={isSinglePanelView}
      layout={layout}
      onClose={onClose}
      testId="document-viewer-shell"
      transparentChrome={transparentChrome}
      widthPx={widthPx}
    >
      <AuxiliaryPanelBody
        className="flex min-h-0 flex-1 flex-col"
        data-testid="document-viewer-content"
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Reading document…
          </div>
        ) : result?.status === "pdf" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
              PDF · {formatBytes(result.bytes_total)} · verified read-only
              preview
            </div>
            <PdfPreview contentBase64={result.content_base64} title={title} />
          </div>
        ) : result?.status === "ready" && ready ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
              <span>{result.extension.toUpperCase()}</span>
              <span>{result.line_count.toLocaleString()} lines</span>
              <span>{formatBytes(result.bytes_read)} shown</span>
              {result.truncated ? (
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  Truncated from {formatBytes(result.bytes_total)}
                </span>
              ) : null}
            </div>
            {ready.notice ? (
              <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
                {ready.notice}
              </div>
            ) : null}
            {result.extension === "md" || result.extension === "markdown" ? (
              <div
                className="min-h-0 flex-1 overflow-auto p-5"
                data-testid="document-viewer-markdown"
              >
                <Markdown content={ready.content} interactive={false} />
              </div>
            ) : (
              <pre
                className="min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-5 text-foreground selection:bg-primary/20"
                data-testid={`document-viewer-${result.extension}`}
              >
                {ready.content}
              </pre>
            )}
          </div>
        ) : result && result.status !== "ready" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <AlertCircle className="h-6 w-6 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">
              {failureMessage(result, request)}
            </p>
          </div>
        ) : null}
      </AuxiliaryPanelBody>
    </AuxiliaryPanel>
  );
}
