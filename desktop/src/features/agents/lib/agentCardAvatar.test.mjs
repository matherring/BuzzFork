import assert from "node:assert/strict";
import test from "node:test";

import {
  isAgentCardAvatarLoading,
  resolveAgentCardAvatarUrl,
} from "./agentCardAvatar.ts";

test("running agent card prefers persisted custom metadata to a provider profile", () => {
  assert.equal(
    resolveAgentCardAvatarUrl(
      "https://relay.example/instance.png",
      "https://relay.example/definition.png",
      "https://relay.example/provider.png",
    ),
    "https://relay.example/instance.png",
  );
});

test("running agent card falls back to the definition avatar", () => {
  assert.equal(
    resolveAgentCardAvatarUrl(
      null,
      " https://relay.example/definition.png ",
      "https://relay.example/provider.png",
    ),
    "https://relay.example/definition.png",
  );
});

test("running agent card ignores blank avatar values", () => {
  assert.equal(resolveAgentCardAvatarUrl("  ", "", null), null);
});

test("linked agent actions only wait for relay metadata without persisted avatars", () => {
  assert.equal(isAgentCardAvatarLoading(true, true, false), true);
  assert.equal(isAgentCardAvatarLoading(true, false, false), false);
  assert.equal(isAgentCardAvatarLoading(true, true, true), false);
});

test("unlinked persona actions do not wait for a profile", () => {
  assert.equal(isAgentCardAvatarLoading(false, true, false), false);
});
