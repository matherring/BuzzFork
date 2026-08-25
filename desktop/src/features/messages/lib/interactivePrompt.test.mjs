import assert from "node:assert/strict";
import test from "node:test";

import { parseInteractivePrompt } from "./interactivePrompt.ts";

const PUBKEY = "ab".repeat(32);
const PROMPT_ID = "prompt-abc123";

function validTags() {
  return [
    ["h", "11111111-2222-3333-4444-555555555555"],
    ["prompt", "v1", PROMPT_ID, "exec-approval", "1800000060"],
    ["prompt-option", PROMPT_ID, "once", "Allow once", "primary"],
    ["prompt-option", PROMPT_ID, "deny", "Deny", "danger"],
    ["p", PUBKEY.toUpperCase()],
  ];
}

test("parses the exact exec-approval prompt contract", () => {
  assert.deepEqual(parseInteractivePrompt(validTags()), {
    promptId: PROMPT_ID,
    kind: "exec-approval",
    expiresAt: 1_800_000_060,
    authorizedResponder: PUBKEY,
    options: [
      { id: "once", label: "Allow once", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
  });
});

test("rejects a misleading label or style", () => {
  for (const [index, value] of [
    [3, "Deny"],
    [4, "danger"],
  ]) {
    const tags = validTags();
    tags[2][index] = value;
    assert.equal(parseInteractivePrompt(tags), null);
  }
});

test("rejects duplicate descriptors, options, and responders", () => {
  for (const duplicateIndex of [1, 2, 4]) {
    const tags = validTags();
    tags.push([...tags[duplicateIndex]]);
    assert.equal(parseInteractivePrompt(tags), null);
  }
});

test("rejects unknown, missing, and cross-prompt options", () => {
  const unknown = validTags();
  unknown[2][2] = "always";
  assert.equal(parseInteractivePrompt(unknown), null);

  const missing = validTags();
  missing.splice(3, 1);
  assert.equal(parseInteractivePrompt(missing), null);

  const crossed = validTags();
  crossed[2][1] = "another-prompt";
  assert.equal(parseInteractivePrompt(crossed), null);
});

test("rejects malformed prompt ids, expiries, and responder pubkeys", () => {
  const shortId = validTags();
  shortId[1][2] = "short";
  assert.equal(parseInteractivePrompt(shortId), null);

  const unsafeId = validTags();
  unsafeId[1][2] = "prompt id with spaces";
  assert.equal(parseInteractivePrompt(unsafeId), null);

  for (const expiry of ["0", "-1", "tomorrow", "1.5"]) {
    const tags = validTags();
    tags[1][4] = expiry;
    assert.equal(parseInteractivePrompt(tags), null);
  }

  const badResponder = validTags();
  badResponder[4][1] = "not-a-pubkey";
  assert.equal(parseInteractivePrompt(badResponder), null);
});
