import { useThreadPanelWidth } from "@/shared/hooks/useThreadPanelWidth";
import { useElementWidth } from "@/shared/hooks/use-mobile";

/** Measures the channel surface and owns its resizable auxiliary-panel width. */
export function useChannelThreadPanelWidth() {
  const [channelContentRef, channelContentWidthPx] =
    useElementWidth<HTMLDivElement>();
  const panel = useThreadPanelWidth(channelContentWidthPx || undefined);

  return {
    channelContentRef,
    contentWidthPx: channelContentWidthPx,
    canReset: panel.canReset,
    onResize: panel.onResizeStart,
    onReset: panel.onResetWidth,
    widthPx: panel.widthPx,
  };
}
