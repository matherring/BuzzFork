import * as React from "react";
import { X } from "lucide-react";
import {
  readLocalDocument,
  type LocalDocument,
} from "@/shared/api/localDocument";
import { cn } from "@/shared/lib/cn";

const LocalDocumentContext = React.createContext<{
  openDocument: (path: string) => void;
} | null>(null);

export function useLocalDocumentViewer() {
  return React.useContext(LocalDocumentContext);
}

export function LocalDocumentViewer({
  children,
}: {
  children: React.ReactNode;
}) {
  const [document, setDocument] = React.useState<LocalDocument | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const openDocument = React.useCallback((path: string) => {
    setError(null);
    void readLocalDocument(path)
      .then(setDocument)
      .catch((reason: unknown) => {
        setDocument(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  return (
    <LocalDocumentContext.Provider value={{ openDocument }}>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
        {document || error ? (
          <aside
            className="flex min-h-0 w-[min(48vw,720px)] min-w-[360px] flex-col border-l border-border bg-background"
            data-testid="local-document-viewer"
          >
            <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  {document?.filename ?? "Document error"}
                </div>
                {document ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {document.path}
                  </div>
                ) : null}
              </div>
              <button
                aria-label="Close document viewer"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => {
                  setDocument(null);
                  setError(null);
                }}
                type="button"
              >
                <X className="size-4" />
              </button>
            </header>
            {error ? (
              <div className="p-4 text-sm text-destructive">{error}</div>
            ) : null}
            {document ? (
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <pre
                  className={cn(
                    "whitespace-pre-wrap break-words font-mono text-xs leading-5",
                    document.truncated && "pb-4",
                  )}
                >
                  {document.content}
                </pre>
                <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                  {document.lines.toLocaleString()} lines ·{" "}
                  {document.bytes.toLocaleString()} bytes · {document.language}
                  {document.truncated ? " · viewer limit reached" : ""}
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </LocalDocumentContext.Provider>
  );
}
