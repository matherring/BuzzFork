import assert from "node:assert/strict";
import test from "node:test";

import {
  allTurns,
  countWorkingTurns,
  findTurn,
  matchesTurnSearch,
  turnIdentityKey,
  turnsByStatus,
} from "./controlTowerSelectors.ts";

const alphaIdentity = {
  agentPubkey: "a".repeat(64),
  channelId: "channel-a",
  turnId: "turn-1",
  sessionId: "session-1",
};
const betaIdentity = {
  agentPubkey: "b".repeat(64),
  channelId: "channel-b",
  turnId: "turn-2",
  sessionId: "session-2",
};

function turn(identity, overrides = {}) {
  return {
    ...identity,
    id: turnIdentityKey(identity),
    agentName: "Alpha",
    avatarUrl: null,
    role: "Implementation",
    status: "working",
    statusLabel: "Working",
    operation: "Porting Control Tower",
    startedAt: "2026-09-02T20:00:00Z",
    completedAt: null,
    lastActivityAt: "2026-09-02T20:01:00Z",
    model: "gpt-5.6-sol",
    branch: "feat/control-tower-fleet-v0.8.2",
    head: "abc1234",
    helperCount: 0,
    archived: false,
    activity: [],
    context: [],
    evidence: [],
    artifacts: [],
    ...overrides,
  };
}

const alpha = turn(alphaIdentity);
const beta = turn(betaIdentity, {
  agentName: "Beta",
  status: "archived",
  statusLabel: "Archived",
  operation: "Finished evidence checks",
  archived: true,
});
const snapshot = {
  generatedAt: "2026-09-02T20:02:00Z",
  source: "observer",
  connection: "connected",
  channels: [
    {
      id: "channel-a",
      name: "agents",
      description: "",
      workstreams: [
        { id: "session-1", title: "Session 1", phase: "Live", turns: [alpha] },
      ],
    },
    {
      id: "channel-b",
      name: "delivery",
      description: "",
      workstreams: [
        {
          id: "session-2",
          title: "Session 2",
          phase: "Archive",
          turns: [beta],
        },
      ],
    },
  ],
};

test("ports Control Tower flatten, find, count, status, and search selectors", () => {
  assert.equal(allTurns(snapshot).length, 2);
  assert.equal(findTurn(snapshot, alpha.id)?.agentName, "Alpha");
  assert.equal(countWorkingTurns(snapshot), 1);
  assert.deepEqual(
    turnsByStatus(snapshot, "archived").map((item) => item.id),
    [beta.id],
  );
  assert.equal(matchesTurnSearch(alpha, "control tower"), true);
  assert.equal(matchesTurnSearch(alpha, "TURN-1"), true);
  assert.equal(matchesTurnSearch(alpha, "unrelated"), false);
});

test("exact turn keys cannot mix concurrent channels or sessions", () => {
  const channelVariant = turnIdentityKey({
    ...alphaIdentity,
    channelId: "channel-b",
  });
  const sessionVariant = turnIdentityKey({
    ...alphaIdentity,
    sessionId: "session-2",
  });
  assert.notEqual(channelVariant, alpha.id);
  assert.notEqual(sessionVariant, alpha.id);
  assert.notEqual(channelVariant, sessionVariant);
});
