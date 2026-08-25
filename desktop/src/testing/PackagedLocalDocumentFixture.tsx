import * as React from "react";

import {
  DocumentViewerPane,
  type DocumentReadResult,
} from "@/features/documents/DocumentViewerPane";
import {
  closeDocumentViewer,
  localFileReferenceFromHref,
  useDocumentViewerRequest,
} from "@/features/documents/localDocumentViewer";
import { prepareDocumentMarkdown } from "@/features/documents/markdownDocumentViewer";
import { LocalFileCard } from "@/features/documents/LocalFileCard";
import { invokeTauri } from "@/shared/api/tauri";
import { Button } from "@/shared/ui/button";

function fixtureMessage(path: string) {
  return `Open ${path}.`;
}

function fixtureReference(path: string) {
  const serialized = prepareDocumentMarkdown(fixtureMessage(path), true);
  const href = serialized.match(/\((buzz-local-file:[^)]+)\)/)?.[1];
  const reference = localFileReferenceFromHref(href);
  if (!reference) {
    throw new Error(
      "The packaged local-document fixture did not serialize its path",
    );
  }
  return { reference, serialized };
}

class FixtureErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    if (this.state.error) {
      return (
        <pre data-testid="packaged-document-render-error">
          {`${this.state.error.message}\n${this.state.error.stack ?? ""}`}
        </pre>
      );
    }
    return this.props.children;
  }
}

/**
 * Package-only native smoke surface. It exercises the same message-path
 * serialization, file card, preview store, viewer pane, and Tauri reader as
 * the desktop app without replacing Tauri's real IPC globals.
 */
export function PackagedLocalDocumentFixture({ path }: { path: string }) {
  const { reference, serialized } = React.useMemo(
    () => fixtureReference(path),
    [path],
  );
  const request = useDocumentViewerRequest();
  const [nativeResult, setNativeResult] = React.useState<unknown>(null);

  const runNativeProbe = React.useCallback(() => {
    setNativeResult({ status: "reading", source: path });
    void invokeTauri<DocumentReadResult>("read_local_document", {
      path,
    })
      .then((result) => {
        setNativeResult(
          result.status === "pdf"
            ? {
                ...result,
                content_base64: undefined,
                content_base64_length: result.content_base64.length,
              }
            : result,
        );
      })
      .catch((error: unknown) => {
        setNativeResult({
          status: "probe_error",
          source: path,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [path]);

  return (
    <main className="flex min-h-dvh flex-col gap-4 bg-background p-6 text-foreground">
      <h1 className="text-lg font-semibold">Packaged local document fixture</h1>
      <p data-testid="packaged-document-message" className="text-sm">
        {fixtureMessage(path)}
      </p>
      <code
        className="break-all rounded bg-muted p-2 text-2xs"
        data-testid="packaged-document-serialized-link"
      >
        {serialized}
      </code>
      <div>
        <LocalFileCard reference={reference} />
      </div>
      <div className="flex items-start gap-3">
        <Button onClick={runNativeProbe} type="button" variant="outline">
          Record native result
        </Button>
        {nativeResult ? (
          <pre
            className="max-h-40 min-w-0 flex-1 overflow-auto rounded bg-muted p-2 text-2xs"
            data-testid="packaged-native-result"
          >
            {JSON.stringify(nativeResult, null, 2)}
          </pre>
        ) : null}
      </div>
      {request ? (
        <section className="flex min-h-0 flex-1 rounded-lg border border-border">
          <FixtureErrorBoundary>
            <DocumentViewerPane
              layout="split"
              onClose={closeDocumentViewer}
              request={request}
            />
          </FixtureErrorBoundary>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          Select the file card to open the real native preview.
        </p>
      )}
    </main>
  );
}
