import * as React from "react";
import { Download, Eye, FileText } from "lucide-react";
import { toast } from "sonner";

import { invokeTauri } from "@/shared/api/tauri";
import { useSmoothCorners } from "@/shared/ui/smoothCorners";

/** Human-readable byte size: "820 B", "12.4 KB", "3.1 MB". */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

function fileCardBody(filename: string, sizeLabel: string) {
  return (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
        <FileText className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {filename}
        </span>
        {sizeLabel ? (
          <span className="block text-xs text-muted-foreground">
            {sizeLabel}
          </span>
        ) : null}
      </span>
    </>
  );
}

/**
 * File card for a generic attachment. Previewable documents open in Buzz's
 * right-side viewer; every card retains an explicit native download action.
 */
export function FileCard({
  href,
  filename,
  onOpen,
  size,
}: {
  href: string;
  filename: string;
  onOpen?: () => void;
  size?: number;
}) {
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const sizeLabel = size != null ? formatFileSize(size) : "";
  useSmoothCorners(cardRef);

  const download = React.useCallback(() => {
    invokeTauri("download_file", { url: href, filename }).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : "Download failed";
        toast.error(message);
      },
    );
  }, [filename, href]);

  if (!onOpen) {
    return (
      <button
        type="button"
        onClick={download}
        data-testid="file-card"
        className="my-1 inline-flex max-w-sm items-center gap-3 rounded-2xl border border-border/70 bg-muted/40 px-3 py-2 text-left no-underline transition-colors hover:bg-muted/70"
        style={{ borderRadius: "1rem" }}
      >
        {fileCardBody(filename, sizeLabel)}
        <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  return (
    <div
      ref={cardRef}
      className="my-1 inline-flex max-w-sm items-stretch overflow-hidden rounded-2xl border border-border/70 bg-muted/40 no-underline"
      data-testid="file-card"
      style={{ borderRadius: "1rem" }}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/70"
        data-testid="file-card-open"
        onClick={onOpen}
        title={`Open ${filename} in the document viewer`}
        type="button"
      >
        {fileCardBody(filename, sizeLabel)}
        <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      <button
        aria-label={`Download ${filename}`}
        className="flex w-10 shrink-0 items-center justify-center border-l border-border/70 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
        data-testid="file-card-download"
        onClick={download}
        title={`Download ${filename}`}
        type="button"
      >
        <Download className="h-4 w-4" />
      </button>
    </div>
  );
}
