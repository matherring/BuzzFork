import * as React from "react";
import { FileText, FolderOpen, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import {
  canOpenLocalDocument,
  canPreviewDocument,
  openDocumentRootSettings,
  openLocalDocument,
  type LocalFileReference,
} from "@/features/documents/localDocumentViewer";
import { invokeTauri } from "@/shared/api/tauri";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import {
  MediaContextMenu,
  type MediaContextMenuPosition,
  useDismissMediaContextMenu,
} from "@/shared/ui/markdown/MediaContextMenu";

function filenameFromPath(path: string) {
  return path.split("/").at(-1) || "Local file";
}

function extensionLabel(path: string) {
  const extension = filenameFromPath(path).split(".").at(-1);
  return extension && extension !== filenameFromPath(path)
    ? extension.toUpperCase()
    : "FILE";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * A message-local reference, not an upload. This component never inspects the
 * referenced path while rendering; every filesystem operation is an explicit
 * user action and is revalidated in the Rust command boundary.
 */
export function LocalFileCard({
  reference,
}: {
  reference: LocalFileReference;
}) {
  const [menu, setMenu] = React.useState<MediaContextMenuPosition | null>(null);
  const closeMenu = React.useCallback(() => setMenu(null), []);
  useDismissMediaContextMenu(Boolean(menu), closeMenu);

  const filename = filenameFromPath(reference.path);
  const previewable = canPreviewDocument(reference.path);
  const openable = canOpenLocalDocument(reference.path);

  const chooseApprovedFolder = React.useCallback(async () => {
    try {
      const selected = await invokeTauri<string | null>(
        "pick_document_root",
        {},
      );
      if (!selected) return;
      const confirmed = window.confirm(
        `Allow Buzz to access local files under:\n\n${selected}\n\n` +
          "Buzz will not upload those files. You can revoke this folder in Document access settings.",
      );
      if (!confirmed) return;
      await invokeTauri("add_document_root", { root: selected });
      toast.success("Document folder approved");
    } catch (error) {
      toast.error(errorMessage(error, "Could not approve the selected folder"));
    }
  }, []);

  const openDefault = React.useCallback(() => {
    void invokeTauri("open_local_document", {
      expectedSha256: reference.expectedSha256,
      path: reference.path,
    }).catch((error: unknown) => {
      toast.error(errorMessage(error, "Could not open this local document"));
    });
  }, [reference.expectedSha256, reference.path]);

  const reveal = React.useCallback(() => {
    void invokeTauri("reveal_local_file", { path: reference.path }).catch(
      (error: unknown) => {
        toast.error(errorMessage(error, "Could not reveal this local file"));
      },
    );
  }, [reference.path]);

  const copyChecksum = React.useCallback(() => {
    void invokeTauri<string>("local_document_checksum", {
      path: reference.path,
    })
      .then((checksum) =>
        copyTextToClipboard(checksum, "SHA-256 copied to clipboard"),
      )
      .catch((error: unknown) => {
        toast.error(
          errorMessage(error, "Could not calculate this file's checksum"),
        );
      });
  }, [reference.path]);

  const openCard = React.useCallback(() => {
    if (openable) {
      openDefault();
    } else {
      reveal();
    }
  }, [openDefault, openable, reveal]);

  const menuItems = [
    ...(previewable
      ? [
          {
            label: "Preview in Buzz",
            onSelect: () => {
              closeMenu();
              openLocalDocument(reference);
            },
          },
        ]
      : []),
    ...(openable
      ? [
          {
            label: "Open with Default App",
            onSelect: () => {
              closeMenu();
              openDefault();
            },
          },
        ]
      : []),
    {
      label: "Reveal in Finder",
      onSelect: () => {
        closeMenu();
        reveal();
      },
    },
    {
      label: "Copy file path",
      onSelect: () => {
        closeMenu();
        copyTextToClipboard(reference.path, "File path copied to clipboard");
      },
    },
    ...(previewable
      ? [
          {
            label: "Copy SHA-256",
            onSelect: () => {
              closeMenu();
              copyChecksum();
            },
          },
        ]
      : []),
    {
      label: "Choose approved folder…",
      onSelect: () => {
        closeMenu();
        void chooseApprovedFolder();
      },
    },
    {
      label: "Document access settings…",
      onSelect: () => {
        closeMenu();
        openDocumentRootSettings();
      },
    },
  ];

  return (
    <>
      <span
        className="my-1 inline-flex max-w-sm items-stretch overflow-hidden rounded-xl border border-border/70 bg-muted/40 align-middle no-underline"
        data-testid="local-file-card"
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/70"
          data-testid="local-file-card-open"
          onClick={openCard}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          title={
            openable
              ? `Open ${filename} with its default app`
              : `Reveal ${filename} in Finder`
          }
          type="button"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
            <FileText className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {filename}
            </span>
            <span className="block text-xs text-muted-foreground">
              {extensionLabel(reference.path)} · local file
              {previewable ? " · Preview available" : " · Reveal only"}
            </span>
          </span>
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
        <button
          aria-label={`More actions for ${filename}`}
          className="flex w-10 shrink-0 items-center justify-center border-l border-border/70 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          data-testid="local-file-card-menu"
          onClick={(event) =>
            setMenu({
              x: event.currentTarget.getBoundingClientRect().right,
              y: event.currentTarget.getBoundingClientRect().bottom,
            })
          }
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          title={`More actions for ${filename}`}
          type="button"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </span>
      {menu ? (
        <MediaContextMenu
          dataAttributes={["data-local-file-context-menu"]}
          items={menuItems}
          position={menu}
        />
      ) : null}
    </>
  );
}
