import * as React from "react";
import { toast } from "sonner";

import { isThreadReply } from "@/features/messages/lib/threading";
import type { MessageComposerEditTarget } from "@/features/messages/ui/MessageComposer.types";
import type { TimelineMessage } from "@/features/messages/types";

type RoutedEditOptions = {
  activeChannelId: string | null;
  channelIsCovered: boolean;
  editTarget: MessageComposerEditTarget | null;
  isSinglePanelView: boolean;
  onCloseThread: () => void;
  onEdit?: (message: TimelineMessage) => void;
  threadHeadMessageId: string | null;
  useFocusThreadDrawer: boolean;
};

/** Coordinates an edit that must move from the thread pane back to the timeline. */
export function useChannelPaneRoutedEdit({
  activeChannelId,
  channelIsCovered,
  editTarget,
  isSinglePanelView,
  onCloseThread,
  onEdit,
  threadHeadMessageId,
  useFocusThreadDrawer,
}: RoutedEditOptions) {
  const pendingMainEditRef = React.useRef<TimelineMessage | null>(null);
  const editTargetRef = React.useRef(editTarget);
  editTargetRef.current = editTarget;
  const pendingContextRef = React.useRef({
    channelId: activeChannelId,
    threadId: threadHeadMessageId,
  });
  const pendingContext = {
    channelId: activeChannelId,
    threadId: threadHeadMessageId,
  };
  const previousContext = pendingContextRef.current;
  if (
    previousContext.channelId !== pendingContext.channelId ||
    (previousContext.threadId !== null &&
      pendingContext.threadId !== null &&
      previousContext.threadId !== pendingContext.threadId)
  ) {
    pendingMainEditRef.current = null;
  }
  pendingContextRef.current = pendingContext;

  const handleRoutedEdit = React.useCallback(
    (message: TimelineMessage): boolean => {
      const currentEditTarget = editTargetRef.current;
      if (
        currentEditTarget &&
        currentEditTarget.id !== message.id &&
        currentEditTarget.isThreadReply !== isThreadReply(message.tags ?? [])
      ) {
        pendingMainEditRef.current = null;
        toast.info("Finish or cancel your edit first.");
        return false;
      }
      if (currentEditTarget?.id === message.id) {
        pendingMainEditRef.current = null;
        onEdit?.(message);
        return true;
      }
      if (
        !isThreadReply(message.tags ?? []) &&
        (isSinglePanelView || useFocusThreadDrawer)
      ) {
        pendingMainEditRef.current = message;
        onCloseThread();
        return true;
      }
      onEdit?.(message);
      return Boolean(onEdit);
    },
    [isSinglePanelView, onCloseThread, onEdit, useFocusThreadDrawer],
  );

  React.useEffect(() => {
    const pendingMainEdit = pendingMainEditRef.current;
    if (!pendingMainEdit || isSinglePanelView || channelIsCovered) return;
    pendingMainEditRef.current = null;
    onEdit?.(pendingMainEdit);
  }, [channelIsCovered, isSinglePanelView, onEdit]);

  return handleRoutedEdit;
}
