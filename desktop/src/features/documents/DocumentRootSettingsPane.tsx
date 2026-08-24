import * as React from "react";
import { FolderOpen, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";

import { invokeTauri } from "@/shared/api/tauri";
import { Button } from "@/shared/ui/button";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Local-only permission management for the document viewer. */
export function DocumentRootSettingsPane({ onClose }: { onClose: () => void }) {
  const [roots, setRoots] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);

  const reload = React.useCallback(async () => {
    try {
      setRoots(await invokeTauri<string[]>("list_document_roots", {}));
    } catch (error) {
      toast.error(
        errorMessage(error, "Could not load document access settings"),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const chooseFolder = React.useCallback(async () => {
    try {
      const roots = await invokeTauri<string[] | null>(
        "choose_document_root",
        {},
      );
      if (roots) {
        setRoots(roots);
        toast.success("Document folder approved");
      }
    } catch (error) {
      toast.error(errorMessage(error, "Could not approve the selected folder"));
    }
  }, []);

  const revoke = React.useCallback(async (root: string) => {
    try {
      setRoots(await invokeTauri<string[]>("remove_document_root", { root }));
      toast.success("Document folder access revoked");
    } catch (error) {
      toast.error(
        errorMessage(error, "Could not revoke document folder access"),
      );
    }
  }, []);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="document-root-settings-pane"
    >
      <header className="flex min-h-13 shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
        <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Document access</h2>
          <p className="text-2xs text-muted-foreground">
            Local-only folders that Buzz may read after you choose an action.
          </p>
        </div>
        <Button
          aria-label="Close document access settings"
          onClick={onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-4 text-sm text-muted-foreground">
          Paths in chat are references only. File bytes are never uploaded by
          approving a folder or previewing a document.
        </p>
        <Button
          onClick={() => void chooseFolder()}
          type="button"
          variant="outline"
        >
          <FolderOpen className="h-4 w-4" />
          Choose approved folder…
        </Button>

        <section className="mt-6" aria-label="Approved document folders">
          <h3 className="text-sm font-medium">Approved folders</h3>
          {loading ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Loading folders…
            </p>
          ) : roots.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No folders are approved. Choose a folder to permit local preview,
              open, reveal, and checksum actions.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {roots.map((root) => (
                <li
                  className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 p-3"
                  key={root}
                >
                  <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <code className="min-w-0 flex-1 break-all font-mono text-xs">
                    {root}
                  </code>
                  <Button
                    onClick={() => void revoke(root)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
