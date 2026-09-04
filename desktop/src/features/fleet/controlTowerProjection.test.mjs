import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_TOWER_STALE_MS,
  projectControlTowerSnapshot,
} from "./controlTowerProjection.ts";
import { allTurns } from "./controlTowerSelectors.ts";

const AGENT = "a".repeat(64);
const AGENT_B = "b".repeat(64);
const CHANNEL_A = "11111111-1111-4111-8111-111111111111";
const CHANNEL_B = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-09-02T21:00:00Z");

const managedAgent = {
  pubkey: AGENT,
  name: "Builder",
  runtime: "codex",
  relayUrl: "wss://relay.example",
  agentCommand: "codex-acp",
  avatarUrl: null,
  model: "gpt-5.6-sol",
  provider: "openai",
  status: "running",
  lastError: null,
  lastErrorCode: null,
};

const secondManagedAgent = {
  ...managedAgent,
  pubkey: AGENT_B,
  name: "Reviewer",
};

const channels = [
  { id: CHANNEL_A, name: "alpha", description: "First stream" },
  { id: CHANNEL_B, name: "beta", description: "Second stream" },
];

function frame({
  seq,
  channelId = CHANNEL_A,
  turnId = "turn-a",
  sessionId = "session-a",
  kind = "turn_started",
  timestamp = new Date(NOW - 1_000).toISOString(),
  payload = {},
}) {
  return {
    seq,
    timestamp,
    kind,
    agentIndex: 0,
    channelId,
    sessionId,
    turnId,
    startedAt: new Date(NOW - 10_000).toISOString(),
    payload,
  };
}

function chunk({ seq, channelId, turnId, sessionId, text, thought = false }) {
  return frame({
    seq,
    channelId,
    turnId,
    sessionId,
    kind: "acp_read",
    payload: {
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: thought
            ? "agent_thought_chunk"
            : "agent_message_chunk",
          messageId: thought ? `thought-${turnId}` : `message-${turnId}`,
          content: { type: "text", text },
        },
      },
    },
  });
}

function tool({
  seq,
  channelId = CHANNEL_A,
  turnId = "turn-a",
  sessionId = "session-a",
}) {
  return frame({
    seq,
    channelId,
    turnId,
    sessionId,
    kind: "acp_read",
    payload: {
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `tool-${turnId}`,
          status: "executing",
          title: "Read repository",
          kind: "read_file",
          rawInput: { path: `src/${turnId}.ts` },
        },
      },
    },
  });
}

function editTool({
  seq,
  channelId = CHANNEL_A,
  turnId = "turn-a",
  sessionId = "session-a",
}) {
  return frame({
    seq,
    channelId,
    turnId,
    sessionId,
    kind: "acp_read",
    payload: {
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `edit-${turnId}`,
          status: "completed",
          title: "str_replace",
          kind: "str_replace",
          rawInput: {
            path: "src/safe.ts",
            input: "*** Update File: src/safe.ts\n-token=old\n+token=new",
          },
          rawOutput: "api_key=do-not-show",
        },
      },
    },
  });
}

function manifest({
  seq = 2,
  channelId = CHANNEL_A,
  turnId = "turn-a",
  sessionId = "session-a",
} = {}) {
  return frame({
    seq,
    channelId,
    turnId,
    sessionId,
    kind: "turn_manifest",
    payload: {
      operation: `Ship ${turnId}`,
      workstreamId: `work-${channelId}`,
      workstreamTitle:
        channelId === CHANNEL_A ? "Alpha delivery" : "Beta review",
      phase: "Implementation",
      branch: `feat/${turnId}`,
      head: "abc1234",
      context: [
        {
          id: `context-${turnId}`,
          kind: "thread",
          label: "Triggering Buzz turn",
          detail: "Exact human request",
          hash: "f00ba4",
          size: "42 B",
          visibility: "full",
          content: `request for ${turnId}`,
        },
        {
          id: `base-${turnId}`,
          kind: "base",
          label: "Base instructions",
          detail: "Runtime policy",
          hash: "decafe",
          size: "8 KiB",
          visibility: "provenance",
          withheldReason: "Body withheld at source.",
        },
      ],
      evidence: [
        {
          stage: "committed",
          label: "Committed",
          detail: "Commit created",
          complete: true,
          facts: [{ label: "Commit", value: "abc1234" }],
        },
      ],
      artifacts: [
        {
          id: `artifact-${turnId}`,
          kind: "code",
          name: `${turnId}.ts`,
          detail: `src/${turnId}.ts`,
          changedAt: new Date(NOW - 500).toISOString(),
        },
      ],
    },
  });
}

function snapshot(
  liveEvents,
  { sourceConnectionState = "open", ...overrides } = {},
) {
  return projectControlTowerSnapshot({
    sources: [
      {
        agent: managedAgent,
        observerConnectionState: sourceConnectionState,
        liveEvents,
      },
    ],
    channels,
    now: NOW,
    ...overrides,
  });
}

test("attributes concurrent turns for one agent to exact channels and sessions", () => {
  const events = [
    frame({ seq: 1, channelId: CHANNEL_A, turnId: "turn-a", sessionId: null }),
    manifest(),
    chunk({
      seq: 4,
      channelId: CHANNEL_A,
      turnId: "turn-a",
      sessionId: "session-a",
      text: "alpha reply",
    }),
    frame({ seq: 3, channelId: CHANNEL_B, turnId: "turn-b", sessionId: null }),
    manifest({
      seq: 5,
      channelId: CHANNEL_B,
      turnId: "turn-b",
      sessionId: "session-b",
    }),
    chunk({
      seq: 6,
      channelId: CHANNEL_B,
      turnId: "turn-b",
      sessionId: "session-b",
      text: "beta reply",
    }),
    tool({
      seq: 7,
      channelId: CHANNEL_A,
      turnId: "turn-a",
      sessionId: "session-a",
    }),
  ];
  const turns = allTurns(snapshot(events));
  assert.equal(turns.length, 2);
  const alpha = turns.find((turn) => turn.channelId === CHANNEL_A);
  const beta = turns.find((turn) => turn.channelId === CHANNEL_B);
  assert.equal(alpha.liveText, "alpha reply");
  assert.equal(beta.liveText, "beta reply");
  assert.equal(alpha.sessionId, "session-a");
  assert.equal(beta.sessionId, "session-b");
  assert.equal(
    alpha.activity.some((item) => item.kind === "tool"),
    true,
  );
  assert.equal(
    beta.activity.some((item) => item.kind === "tool"),
    false,
  );
});

test("live frames update reply, reasoning, tools, context, evidence, and artifacts", () => {
  const before = allTurns(snapshot([frame({ seq: 1 }), manifest()]))[0];
  const after = allTurns(
    snapshot([
      frame({ seq: 1 }),
      manifest(),
      chunk({
        seq: 3,
        channelId: CHANNEL_A,
        turnId: "turn-a",
        sessionId: "session-a",
        text: "Streaming",
      }),
      chunk({
        seq: 4,
        channelId: CHANNEL_A,
        turnId: "turn-a",
        sessionId: "session-a",
        text: " safely",
        thought: true,
      }),
      tool({ seq: 5 }),
    ]),
  )[0];
  assert.equal(before.liveText, undefined);
  assert.equal(after.liveText, "Streaming");
  assert.equal(after.liveThought, " safely");
  assert.equal(after.context.length, 2);
  assert.equal(after.evidence[0].facts[0].value, "abc1234");
  assert.equal(after.artifacts[0].detail, "src/turn-a.ts");
});

test("archive-only reload preserves the turn and marks it archived", () => {
  const archived = [
    frame({ seq: 1 }),
    manifest(),
    chunk({
      seq: 3,
      channelId: CHANNEL_A,
      turnId: "turn-a",
      sessionId: "session-a",
      text: "final",
    }),
    frame({ seq: 4, kind: "turn_completed" }),
  ];
  const archivedEventsByChannel = new Map([[CHANNEL_A, archived]]);
  const result = projectControlTowerSnapshot({
    sources: [
      {
        agent: managedAgent,
        observerConnectionState: "closed",
        liveEvents: [],
        archivedEventsByChannel,
      },
    ],
    channels,
    now: NOW,
  });
  const [turn] = allTurns(result);
  assert.equal(result.source, "archive");
  assert.equal(result.connection, "stale");
  assert.equal(turn.status, "archived");
  assert.equal(turn.liveText, "final");
});

test("duplicate and out-of-order frames reduce idempotently", () => {
  const start = frame({
    seq: 1,
    timestamp: new Date(NOW - 5_000).toISOString(),
  });
  const reply = chunk({
    seq: 3,
    channelId: CHANNEL_A,
    turnId: "turn-a",
    sessionId: "session-a",
    text: "one reply",
  });
  const result = allTurns(snapshot([reply, start, manifest(), reply]))[0];
  assert.equal(result.liveText, "one reply");
  assert.equal(
    result.activity.filter((item) => item.kind === "message").length,
    1,
  );
});

test("missing identity stays absent instead of contaminating another turn", () => {
  const result = snapshot([
    frame({ seq: 1, channelId: null, turnId: "turn-a" }),
    frame({ seq: 2, channelId: CHANNEL_A, turnId: null }),
  ]);
  assert.equal(allTurns(result).length, 0);
  assert.equal(result.source, "observer");
});

test("reconnect and stale clocks preserve data without claiming it is live", () => {
  const old = frame({
    seq: 1,
    timestamp: new Date(NOW - CONTROL_TOWER_STALE_MS - 1).toISOString(),
  });
  assert.equal(allTurns(snapshot([old]))[0].status, "stale");

  const reconnecting = snapshot([frame({ seq: 1 })], {
    sourceConnectionState: "connecting",
  });
  assert.equal(reconnecting.connection, "reconnecting");
  assert.equal(allTurns(reconnecting)[0].status, "stale");

  const unavailable = snapshot([], { sourceConnectionState: "error" });
  assert.equal(unavailable.connection, "unavailable");
  assert.equal(
    unavailable.channels.every((channel) => channel.workstreams.length === 0),
    true,
  );
});

test("classifies each live turn from its owning agent connection", () => {
  const result = projectControlTowerSnapshot({
    sources: [
      {
        agent: managedAgent,
        observerConnectionState: "open",
        liveEvents: [frame({ seq: 1 })],
      },
      {
        agent: secondManagedAgent,
        observerConnectionState: "closed",
        liveEvents: [
          frame({
            seq: 2,
            channelId: CHANNEL_B,
            turnId: "turn-b",
            sessionId: "session-b",
          }),
        ],
      },
    ],
    channels,
    now: NOW,
  });
  const turns = allTurns(result);
  const connected = turns.find((turn) => turn.agentPubkey === AGENT);
  const disconnected = turns.find((turn) => turn.agentPubkey === AGENT_B);
  assert.equal(connected.status, "working");
  assert.equal(disconnected.status, "stale");
});

test("keeps a recent incomplete archive non-live beside another agent's live turn", () => {
  const archived = frame({
    seq: 2,
    channelId: CHANNEL_B,
    turnId: "turn-b",
    sessionId: "session-b",
    timestamp: new Date(NOW - 500).toISOString(),
  });
  const result = projectControlTowerSnapshot({
    sources: [
      {
        agent: managedAgent,
        observerConnectionState: "open",
        liveEvents: [frame({ seq: 1 })],
      },
      {
        agent: secondManagedAgent,
        observerConnectionState: "open",
        liveEvents: [],
        archivedEventsByChannel: new Map([[CHANNEL_B, [archived]]]),
      },
    ],
    channels,
    now: NOW,
  });
  const turns = allTurns(result);
  const live = turns.find((turn) => turn.agentPubkey === AGENT);
  const archive = turns.find((turn) => turn.agentPubkey === AGENT_B);
  assert.equal(live.status, "working");
  assert.equal(archive.status, "archived");
  assert.equal(archive.archived, true);
});

test("file-edit artifacts stay inside their exact turn and tool secrets are redacted", () => {
  const alphaEdit = editTool({ seq: 3 });
  const betaEdit = editTool({
    seq: 5,
    channelId: CHANNEL_B,
    turnId: "turn-b",
    sessionId: "session-b",
  });
  betaEdit.payload.params.update.rawInput.input =
    "*** Add File: docs/beta.md\n+# Beta";
  betaEdit.payload.params.update.rawInput.path = "docs/beta.md";
  const result = allTurns(
    snapshot([
      frame({ seq: 1 }),
      manifest(),
      alphaEdit,
      frame({
        seq: 2,
        channelId: CHANNEL_B,
        turnId: "turn-b",
        sessionId: "session-b",
      }),
      manifest({
        seq: 4,
        channelId: CHANNEL_B,
        turnId: "turn-b",
        sessionId: "session-b",
      }),
      betaEdit,
    ]),
  );
  const alpha = result.find((turn) => turn.channelId === CHANNEL_A);
  const beta = result.find((turn) => turn.channelId === CHANNEL_B);
  assert.equal(
    alpha.artifacts.some((artifact) => artifact.detail === "src/safe.ts"),
    true,
  );
  assert.equal(
    alpha.artifacts.some((artifact) => artifact.detail === "docs/beta.md"),
    false,
  );
  assert.equal(
    beta.artifacts.some((artifact) => artifact.detail === "docs/beta.md"),
    true,
  );
  assert.equal(JSON.stringify(alpha.activity).includes("do-not-show"), false);
});
