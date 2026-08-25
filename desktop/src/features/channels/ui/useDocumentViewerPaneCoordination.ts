import * as React from "react";

import {
  closeDocumentViewer,
  useDocumentViewerRequest,
} from "@/features/documents/localDocumentViewer";

type DocumentViewerPaneCoordinationOptions = {
  activeChannelId: string | null;
  channelManagementOpen: boolean;
  onCloseAgentSession: () => void;
  onCloseChannelManagement?: () => void;
  onCloseProfilePanel: () => void;
  onCloseThread: () => void;
  openThreadHeadId: string | null;
  profilePanelPubkey: string | null;
  selectedAgentPubkey: string | null;
  shouldShowThreadSkeleton: boolean;
  threadHeadMessageId: string | null;
};

/** Keep document previews in the channel's single exclusive auxiliary-pane slot. */
export function useDocumentViewerPaneCoordination({
  activeChannelId,
  channelManagementOpen,
  onCloseAgentSession,
  onCloseChannelManagement,
  onCloseProfilePanel,
  onCloseThread,
  openThreadHeadId,
  profilePanelPubkey,
  selectedAgentPubkey,
  shouldShowThreadSkeleton,
  threadHeadMessageId,
}: DocumentViewerPaneCoordinationOptions) {
  const documentViewerRequest = useDocumentViewerRequest();
  const competingAuxiliaryPanelKey = channelManagementOpen
    ? `channel-management:${activeChannelId ?? "unknown"}`
    : threadHeadMessageId
      ? `thread:${threadHeadMessageId}`
      : shouldShowThreadSkeleton
        ? `thread-loading:${openThreadHeadId ?? "unknown"}`
        : selectedAgentPubkey
          ? `agent:${selectedAgentPubkey}`
          : profilePanelPubkey
            ? `profile:${profilePanelPubkey}`
            : null;
  const previousRequestRef = React.useRef(documentViewerRequest);
  const previousCompetingPanelKeyRef = React.useRef(competingAuxiliaryPanelKey);
  const previousChannelIdRef = React.useRef(activeChannelId);

  React.useEffect(() => {
    const previousChannelId = previousChannelIdRef.current;
    previousChannelIdRef.current = activeChannelId;
    if (activeChannelId !== previousChannelId) {
      closeDocumentViewer();
    }
  }, [activeChannelId]);

  React.useEffect(() => {
    const previousRequest = previousRequestRef.current;
    previousRequestRef.current = documentViewerRequest;
    if (!documentViewerRequest || documentViewerRequest === previousRequest) {
      return;
    }

    if (channelManagementOpen) onCloseChannelManagement?.();
    if (threadHeadMessageId || shouldShowThreadSkeleton) onCloseThread();
    if (selectedAgentPubkey) onCloseAgentSession();
    if (profilePanelPubkey) onCloseProfilePanel();
  }, [
    channelManagementOpen,
    documentViewerRequest,
    onCloseAgentSession,
    onCloseChannelManagement,
    onCloseProfilePanel,
    onCloseThread,
    profilePanelPubkey,
    selectedAgentPubkey,
    shouldShowThreadSkeleton,
    threadHeadMessageId,
  ]);

  React.useEffect(() => {
    const previousKey = previousCompetingPanelKeyRef.current;
    previousCompetingPanelKeyRef.current = competingAuxiliaryPanelKey;
    if (
      documentViewerRequest &&
      competingAuxiliaryPanelKey &&
      competingAuxiliaryPanelKey !== previousKey
    ) {
      closeDocumentViewer();
    }
  }, [competingAuxiliaryPanelKey, documentViewerRequest]);

  return documentViewerRequest;
}
