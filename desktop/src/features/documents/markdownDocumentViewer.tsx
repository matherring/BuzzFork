import type * as React from "react";

import {
  canPreviewDocument,
  linkifyLocalDocumentPaths,
  localFileReferenceFromHref,
  localFileReferenceFromText,
  openAttachmentDocument,
} from "@/features/documents/localDocumentViewer";
import { LocalFileCard } from "@/features/documents/LocalFileCard";
import { FileCard } from "@/shared/ui/markdown/FileCard";
import type { ResolvedFileCard } from "@/shared/ui/markdownFileCard";

export function renderLocalDocumentAnchor(
  href: string | undefined,
  _children: React.ReactNode,
) {
  const reference = localFileReferenceFromHref(href);
  if (!reference) return null;
  return <LocalFileCard reference={reference} />;
}

export function renderLocalDocumentCode({
  children: _children,
  className: _className,
  code,
  interactive,
  isFencedCodeBlock,
}: {
  children: React.ReactNode;
  className?: string;
  code: string;
  interactive: boolean;
  isFencedCodeBlock: boolean;
}) {
  const reference = localFileReferenceFromText(code);
  if (!interactive || isFencedCodeBlock || code.includes("\n") || !reference) {
    return null;
  }
  return <LocalFileCard reference={reference} />;
}

export function DocumentFileCard({ card }: { card: ResolvedFileCard }) {
  const canOpen =
    canPreviewDocument(card.filename) &&
    card.size !== undefined &&
    card.sha256?.length === 64;
  return (
    <FileCard
      href={card.href}
      filename={card.filename}
      onOpen={
        canOpen
          ? () =>
              openAttachmentDocument({
                filename: card.filename,
                mime: card.mime,
                sha256: card.sha256 ?? "",
                size: card.size ?? 0,
                url: card.href,
              })
          : undefined
      }
      size={card.size}
    />
  );
}

export function prepareDocumentMarkdown(content: string, interactive: boolean) {
  return interactive ? linkifyLocalDocumentPaths(content) : content;
}
