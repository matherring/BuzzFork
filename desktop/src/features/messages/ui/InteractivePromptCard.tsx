import { Check, ShieldAlert, X } from "lucide-react";
import * as React from "react";

import {
  parseInteractivePrompt,
  type InteractivePromptOption,
} from "@/features/messages/lib/interactivePrompt";
import { sendPromptResponse } from "@/shared/api/tauri";
import { Button } from "@/shared/ui/button";

export function InteractivePromptCard({
  channelId,
  currentPubkey,
  messageId,
  tags,
}: {
  channelId: string;
  currentPubkey?: string;
  messageId: string;
  tags?: string[][];
}) {
  const prompt = React.useMemo(() => parseInteractivePrompt(tags), [tags]);
  const [now, setNow] = React.useState(() => Date.now());
  const [status, setStatus] = React.useState<
    "idle" | "submitting" | "responded" | "error"
  >("idle");
  const [responseLabel, setResponseLabel] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!prompt) return;
    const delay = Math.max(0, prompt.expiresAt * 1000 - Date.now());
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(delay + 25, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [prompt]);

  if (!prompt) return null;

  const authorized =
    currentPubkey?.toLowerCase() === prompt.authorizedResponder;
  const expired = now >= prompt.expiresAt * 1000;
  const disabled = !authorized || expired || status !== "idle";

  const respond = async (option: InteractivePromptOption) => {
    if (disabled) return;
    setStatus("submitting");
    setError(null);
    try {
      await sendPromptResponse(
        channelId,
        messageId,
        prompt.promptId,
        option.id,
      );
      setResponseLabel(option.label);
      setStatus("responded");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  };

  return (
    <div
      className="mt-2 max-w-xl rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
      data-testid="interactive-prompt-card"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <ShieldAlert aria-hidden="true" className="h-4 w-4" />
        Approval required
      </div>
      <div className="flex flex-wrap gap-2">
        {prompt.options.map((option) => (
          <Button
            className={
              option.style === "primary"
                ? "bg-green-600 text-white hover:bg-green-700"
                : undefined
            }
            disabled={disabled}
            key={option.id}
            onClick={() => void respond(option)}
            size="sm"
            type="button"
            variant={option.style === "danger" ? "destructive" : "default"}
          >
            {option.id === "once" ? (
              <Check aria-hidden="true" className="mr-1 h-4 w-4" />
            ) : (
              <X aria-hidden="true" className="mr-1 h-4 w-4" />
            )}
            {option.label}
          </Button>
        ))}
      </div>
      {!authorized ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Only the named responder can answer this request.
        </p>
      ) : null}
      {expired ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This request expired.
        </p>
      ) : null}
      {status === "submitting" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Submitting signed response…
        </p>
      ) : null}
      {status === "responded" ? (
        <p className="mt-2 text-xs font-medium text-foreground">
          Responded: {responseLabel}
        </p>
      ) : null}
      {status === "error" ? (
        <div className="mt-2 text-xs text-destructive" role="alert">
          Response failed: {error}
          <Button
            className="ml-2 h-auto p-0 text-xs"
            onClick={() => setStatus("idle")}
            type="button"
            variant="link"
          >
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
