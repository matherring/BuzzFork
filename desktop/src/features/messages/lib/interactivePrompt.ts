const PROMPT_VERSION = "v1";
const EXEC_APPROVAL_KIND = "exec-approval";
const PROMPT_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
const HEX_PUBKEY_PATTERN = /^[0-9a-f]{64}$/i;

export type InteractivePromptOption = {
  id: "once" | "deny";
  label: "Allow once" | "Deny";
  style: "primary" | "danger";
};

export type InteractivePrompt = {
  promptId: string;
  kind: "exec-approval";
  expiresAt: number;
  authorizedResponder: string;
  options: InteractivePromptOption[];
};

const EXEC_APPROVAL_OPTIONS: Record<
  InteractivePromptOption["id"],
  Omit<InteractivePromptOption, "id">
> = {
  once: { label: "Allow once", style: "primary" },
  deny: { label: "Deny", style: "danger" },
};

/** Parse the exact bounded v1 prompt contract; malformed cards fail closed. */
export function parseInteractivePrompt(
  tags: readonly (readonly string[])[] | undefined,
): InteractivePrompt | null {
  if (!tags) return null;

  const descriptors = tags.filter((tag) => tag[0] === "prompt");
  if (descriptors.length !== 1) return null;
  const descriptor = descriptors[0];
  if (
    descriptor.length !== 5 ||
    descriptor[1] !== PROMPT_VERSION ||
    !PROMPT_ID_PATTERN.test(descriptor[2] ?? "") ||
    descriptor[3] !== EXEC_APPROVAL_KIND
  ) {
    return null;
  }

  const expiresAt = Number(descriptor[4]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;

  const promptId = descriptor[2];
  const optionTags = tags.filter((tag) => tag[0] === "prompt-option");
  if (optionTags.length !== 2) return null;

  const seen = new Set<string>();
  const options: InteractivePromptOption[] = [];
  for (const tag of optionTags) {
    if (tag.length !== 5 || tag[1] !== promptId) return null;
    const id = tag[2] as InteractivePromptOption["id"];
    const expected = EXEC_APPROVAL_OPTIONS[id];
    if (
      !expected ||
      seen.has(id) ||
      tag[3] !== expected.label ||
      tag[4] !== expected.style
    ) {
      return null;
    }
    seen.add(id);
    options.push({ id, ...expected });
  }
  if (!seen.has("once") || !seen.has("deny")) return null;

  const responders = tags.filter((tag) => tag[0] === "p");
  if (responders.length !== 1 || responders[0].length < 2) return null;
  const responder = responders[0][1];
  if (!HEX_PUBKEY_PATTERN.test(responder)) return null;

  return {
    promptId,
    kind: EXEC_APPROVAL_KIND,
    expiresAt,
    authorizedResponder: responder.toLowerCase(),
    options,
  };
}
