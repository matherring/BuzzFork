import assert from "node:assert/strict";
import test from "node:test";

import {
  FLEET_ACTIVE_FRAME_STALE_MS,
  aggregateFleetAgents,
  filterAndSortFleetAgents,
  summarizeFleetActivity,
} from "./fleetAggregation.ts";

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);
const CHANNEL = "channel-1";
const NOW = Date.parse("2026-09-01T20:00:00.000Z");

function agent(overrides = {}) {
  return {
    pubkey: PUBKEY_A,
    name: "Alpha",
    runtime: "codex",
    relayUrl: "wss://relay.example",
    agentCommand: "codex-acp",
    avatarUrl: null,
    model: "gpt-5.5",
    provider: "openai",
    status: "running",
    lastError: null,
    lastErrorCode: null,
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    seq: 1,
    timestamp: new Date(NOW - 1_000).toISOString(),
    kind: "turn_liveness",
    agentIndex: 0,
    channelId: CHANNEL,
    sessionId: "session-1",
    turnId: "turn-1",
    payload: null,
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    agent: agent(),
    activeTurns: [{ channelId: CHANNEL, anchorAt: NOW - 5_000 }],
    events: [event()],
    transcript: [],
    observerConnectionState: "open",
    observerErrorMessage: null,
    ...overrides,
  };
}

function aggregate(sources, overrides = {}) {
  return aggregateFleetAgents({
    sources,
    runtimes: [
      {
        id: "codex",
        label: "Codex",
        command: "codex-acp",
      },
    ],
    runtimeStatuses: [],
    channels: [{ id: CHANNEL, name: "agents" }],
    presence: { [PUBKEY_A]: "online", [PUBKEY_B]: "away" },
    presenceResolution: "ready",
    now: NOW,
    ...overrides,
  });
}

test("uses canonical runtime metadata and keeps missing configuration explicit", () => {
  const [configured, missing] = aggregate([
    source(),
    source({
      agent: agent({
        pubkey: PUBKEY_B,
        name: "Beta",
        runtime: "not-in-catalog",
        model: null,
      }),
      activeTurns: [],
      events: [],
    }),
  ]);

  assert.equal(configured.runtimeLabel, "Codex");
  assert.equal(configured.modelLabel, "gpt-5.5");
  assert.equal(missing.runtimeLabel, null);
  assert.equal(missing.modelLabel, null);
  assert.equal(missing.observationState, "idle");
});

test("defines the active/stale clock boundary and rejects malformed clocks", () => {
  const boundary = event({
    timestamp: new Date(NOW - FLEET_ACTIVE_FRAME_STALE_MS).toISOString(),
  });
  const stale = event({
    timestamp: new Date(NOW - FLEET_ACTIVE_FRAME_STALE_MS - 1).toISOString(),
  });
  const future = event({ timestamp: new Date(NOW + 1).toISOString() });
  const rows = aggregate([
    source({ agent: agent({ name: "Boundary" }), events: [boundary] }),
    source({
      agent: agent({ pubkey: PUBKEY_B, name: "Stale" }),
      events: [stale],
    }),
    source({
      agent: agent({ pubkey: "c".repeat(64), name: "Malformed" }),
      events: [event({ timestamp: "not-a-clock" })],
    }),
    source({
      agent: agent({ pubkey: "d".repeat(64), name: "Future clock" }),
      events: [future],
    }),
  ]);

  assert.equal(rows[0].observationState, "active");
  assert.equal(rows[1].observationState, "stale");
  assert.equal(rows[2].observationState, "unknown");
  assert.equal(rows[2].lastObserverAt, null);
  assert.equal(rows[3].observationState, "unknown");
});

test("duplicates and out-of-order frames cannot move the latest observer backward", () => {
  const older = event({
    seq: 99,
    timestamp: new Date(NOW - 20_000).toISOString(),
    turnId: "turn-old",
  });
  const newer = event({
    seq: 2,
    timestamp: new Date(NOW - 2_000).toISOString(),
    turnId: "turn-new",
  });
  const [row] = aggregate([source({ events: [newer, older, { ...newer }] })]);

  assert.equal(row.lastObserverAt, NOW - 2_000);
  assert.equal(row.currentTurnId, "turn-new");
  assert.equal(row.observationState, "active");
});

test("disconnect becomes stale and a newer reconnect frame restores active", () => {
  const disconnected = aggregate([
    source({
      observerConnectionState: "closed",
      events: [
        event({
          timestamp: new Date(
            NOW - FLEET_ACTIVE_FRAME_STALE_MS - 10_000,
          ).toISOString(),
        }),
      ],
    }),
  ])[0];
  const reconnected = aggregate([
    source({ observerConnectionState: "open", events: [event()] }),
  ])[0];

  assert.equal(disconnected.observationState, "stale");
  assert.equal(reconnected.observationState, "active");
});

test("missing channel and turn data remain absent and unresolved presence is unknown", () => {
  const [row] = aggregate(
    [
      source({
        activeTurns: [],
        events: [event({ channelId: null, turnId: null })],
      }),
    ],
    { presenceResolution: "error", presence: {} },
  );
  assert.equal(row.currentChannelId, null);
  assert.equal(row.currentChannelName, null);
  assert.equal(row.currentTurnId, null);
  assert.equal(row.observationState, "unknown");
});

test("attention-first ordering is stable and filters preserve it", () => {
  const rows = [
    {
      ...aggregate([source({ activeTurns: [] })])[0],
      name: "Zulu",
      observationState: "offline",
    },
    { ...aggregate([source()])[0], name: "Beta", observationState: "active" },
    {
      ...aggregate([source()])[0],
      pubkey: PUBKEY_B,
      name: "Alpha",
      observationState: "active",
    },
    {
      ...aggregate([source()])[0],
      name: "Failure",
      observationState: "failed",
    },
  ];
  const sorted = filterAndSortFleetAgents(rows, {
    status: "all",
    channelId: "all",
  });
  assert.deepEqual(
    sorted.map((row) => row.name),
    ["Alpha", "Beta", "Failure", "Zulu"],
  );
  assert.deepEqual(
    filterAndSortFleetAgents(rows, { status: "active" }).map((row) => row.name),
    ["Alpha", "Beta"],
  );
});

test("activity allowlist never surfaces raw tool payloads, output, thoughts, plans, or error bodies", () => {
  const secret = "BUZZ_PRIVATE_KEY=nsec-secret";
  const transcript = [
    {
      id: "thought",
      type: "thought",
      renderClass: "thought",
      title: "Reasoning",
      text: secret,
      timestamp: new Date(NOW).toISOString(),
    },
    {
      id: "tool",
      type: "tool",
      renderClass: "shell",
      descriptor: {
        renderClass: "shell",
        label: "Ran command",
        preview: secret,
        action: { verb: "Inspected", object: "workspace status" },
      },
      title: "shell",
      toolName: "exec",
      buzzToolName: null,
      status: "completed",
      args: { command: secret },
      result: `raw output ${secret}`,
      isError: false,
      timestamp: new Date(NOW).toISOString(),
      startedAt: new Date(NOW).toISOString(),
      completedAt: new Date(NOW).toISOString(),
    },
    {
      id: "error",
      type: "lifecycle",
      renderClass: "error",
      title: "Turn failed",
      text: secret,
      timestamp: new Date(NOW).toISOString(),
    },
  ];

  const summary = summarizeFleetActivity(transcript);
  assert.equal(summary, "Ran command");
  assert.doesNotMatch(summary, /nsec|BUZZ_PRIVATE_KEY|raw output/);
});
