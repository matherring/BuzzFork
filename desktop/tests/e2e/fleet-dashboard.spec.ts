import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const AGENT_PUBKEY =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";
const AGENTS_CHANNEL = "94a444a4-c0a3-5966-ab05-530c6ddc2301";
const ENGINEERING_CHANNEL = "1c7e1c02-87bb-5e88-b2da-5a7a9432d0c9";
const RELAY_URL = "ws://localhost:3000";
const SECRET = "BUZZ_PRIVATE_KEY=nsec1must-never-render";
const SHOTS = "test-results/fleet-control-tower";

const CODEX_CATALOG = [
  {
    id: "codex",
    label: "Codex (runtime catalog)",
    avatar_url: "",
    availability: "available",
    command: "codex",
    binary_path: "/usr/local/bin/codex",
    default_args: [],
    mcp_command: null,
    install_hint: "Available in this fixture.",
    install_instructions_url: "https://example.test/codex",
    can_auto_install: false,
    underlying_cli_path: "/usr/local/bin/codex",
  },
];

function ownerFleetConfig(overrides = {}) {
  return {
    ownerOnlyAccessBuild: true,
    acpRuntimesCatalog: CODEX_CATALOG,
    managedAgents: [
      {
        pubkey: AGENT_PUBKEY,
        name: "Charlie Fleet",
        runtime: "codex",
        model: "gpt-5.6-sol",
        status: "running" as const,
        channelNames: ["agents", "engineering"],
      },
    ],
    managedAgentRuntimes: [
      {
        pubkey: AGENT_PUBKEY,
        relayUrl: RELAY_URL,
        lifecycle: "ready" as const,
      },
    ],
    ...overrides,
  };
}

function observerFrame(
  seq: number,
  channelId: string,
  turnId: string,
  sessionId: string | null,
  kind: string,
  payload: unknown,
) {
  const timestamp = new Date(Date.now() - 500 + seq).toISOString();
  return {
    seq,
    timestamp,
    kind,
    agentIndex: 0,
    channelId,
    sessionId,
    turnId,
    startedAt: new Date(Date.now() - 42_000).toISOString(),
    payload,
  };
}

function updateFrame(
  seq: number,
  channelId: string,
  turnId: string,
  sessionId: string,
  update: Record<string, unknown>,
) {
  return observerFrame(seq, channelId, turnId, sessionId, "acp_read", {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

function manifestFrame(
  seq: number,
  channelId: string,
  turnId: string,
  sessionId: string,
  title: string,
  operation: string,
) {
  return observerFrame(seq, channelId, turnId, sessionId, "turn_manifest", {
    operation,
    role: "Implementation agent",
    model: "gpt-5.6-sol",
    branch: "feat/control-tower-fleet-v0.8.2",
    head: "0d7d28476",
    helperCount: channelId === AGENTS_CHANNEL ? 2 : 0,
    workstreamId: `work-${channelId}`,
    workstreamTitle: title,
    phase: "Implementation",
    context: [
      {
        id: `${turnId}-runtime`,
        kind: "repository",
        label: "Runtime context",
        detail: "Safe runtime metadata for this exact ACP session.",
        hash: "6e52094f9aed",
        size: "184 B",
        visibility: "full",
        fields: [
          { label: "Workspace", value: "BuzzFork-control-tower-fleet" },
          { label: "Model", value: "gpt-5.6-sol" },
          { label: "Branch", value: "feat/control-tower-fleet-v0.8.2" },
        ],
      },
      {
        id: `${turnId}-trigger`,
        kind: "thread",
        label: "Triggering Buzz turn",
        detail: "The human-authored request that started this turn.",
        hash: "f00ba4c0ffee",
        size: "428 B",
        visibility: "summary",
        content:
          "Port Control Tower directly into Fleet and preserve exact attribution.",
      },
      {
        id: `${turnId}-base`,
        kind: "base",
        label: "Base instructions",
        detail: "Platform instructions supplied to the runtime.",
        hash: "decafbad1234",
        size: "8.3 KiB",
        visibility: "provenance",
        withheldReason:
          "Raw platform instructions stay at the harness because they can contain security policy and internal control text.",
      },
      {
        id: `${turnId}-memory`,
        kind: "memory",
        label: "Agent memory",
        detail: "Durable memory shaped the turn.",
        hash: "44a1b3c5d7e9",
        size: "2.1 KiB",
        visibility: "provenance",
        withheldReason:
          "Raw durable memory stays at the harness because it can contain private operational history.",
      },
      {
        id: `${turnId}-project`,
        kind: "project",
        label: "Buzz project",
        detail: "Authoritative NIP-MP project metadata.",
        hash: "a1b2c3d4e5f6",
        size: "312 B",
        visibility: "full",
        fields: [
          { label: "Project", value: "BuzzFork" },
          { label: "Repository", value: "matherring/BuzzFork" },
        ],
      },
    ],
    evidence: [
      {
        stage: "local",
        label: "Runtime observed",
        detail: "The exact ACP turn was observed locally.",
        complete: true,
        facts: [
          {
            label: "Exact turn",
            value: `channel=${channelId} turn=${turnId} session=${sessionId}`,
          },
        ],
      },
      {
        stage: "committed",
        label: "Committed",
        detail: "A signed commit contains the port.",
        complete: true,
        facts: [{ label: "Commit", value: "0d7d28476" }],
      },
      {
        stage: "pushed",
        label: "Pushed",
        detail: "The feature branch is on origin.",
        complete: true,
        facts: [{ label: "Branch", value: "feat/control-tower-fleet-v0.8.2" }],
      },
      {
        stage: "pr-open",
        label: "Draft PR open",
        detail: "Pull request 13 is open for review.",
        complete: true,
        facts: [{ label: "Pull request", value: "matherring/BuzzFork#13" }],
      },
      {
        stage: "merged",
        label: "No merge evidence",
        detail: "Fleet does not infer merge state.",
        complete: false,
      },
      {
        stage: "deployed",
        label: "No deployment evidence",
        detail: "Fleet does not infer deployment state.",
        complete: false,
      },
    ],
    artifacts: [
      {
        id: `${turnId}-ui`,
        kind: "code",
        name: "FleetScreen.tsx",
        detail: "desktop/src/features/fleet/ui/FleetScreen.tsx",
        changedAt: new Date().toISOString(),
      },
      {
        id: `${turnId}-projection`,
        kind: "code",
        name: "controlTowerProjection.ts",
        detail: "desktop/src/features/fleet/controlTowerProjection.ts",
        changedAt: new Date().toISOString(),
      },
      {
        id: `${turnId}-design`,
        kind: "document",
        name: "fleet-control-tower-port.md",
        detail: "docs/design/fleet-control-tower-port.md",
        changedAt: new Date().toISOString(),
      },
    ],
  });
}

async function waitForFleetSeedHooks(page: Page) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
    null,
    { timeout: 10_000 },
  );
}

async function seedFleetActivity(page: Page) {
  await waitForFleetSeedHooks(page);
  const events = [
    observerFrame(1, AGENTS_CHANNEL, "turn-alpha", null, "turn_started", {
      source: "channel",
    }),
    observerFrame(
      2,
      AGENTS_CHANNEL,
      "turn-alpha",
      "session-alpha",
      "session_resolved",
      { sessionId: "session-alpha", isNewSession: true },
    ),
    manifestFrame(
      3,
      AGENTS_CHANNEL,
      "turn-alpha",
      "session-alpha",
      "Control Tower port",
      "Port the dense observer interface",
    ),
    updateFrame(4, AGENTS_CHANNEL, "turn-alpha", "session-alpha", {
      sessionUpdate: "agent_thought_chunk",
      messageId: "thought-alpha",
      content: {
        type: "text",
        text: "Preserve channel → workstream → turn navigation while keeping the owner boundary.",
      },
    }),
    updateFrame(5, AGENTS_CHANNEL, "turn-alpha", "session-alpha", {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-alpha",
      content: {
        type: "text",
        text: "The live reply is streaming from the exact selected turn. ",
      },
    }),
    updateFrame(6, AGENTS_CHANNEL, "turn-alpha", "session-alpha", {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-alpha",
      content: {
        type: "text",
        text: "Context, evidence, and artifacts stay attributed to this session.",
      },
    }),
    updateFrame(7, AGENTS_CHANNEL, "turn-alpha", "session-alpha", {
      sessionUpdate: "tool_call",
      toolCallId: "shell-alpha",
      status: "completed",
      title: "shell",
      kind: "shell",
      rawInput: { command: `cargo test -p buzz-acp ${SECRET}` },
      rawOutput: `tests passed; ${SECRET}`,
    }),
    observerFrame(8, ENGINEERING_CHANNEL, "turn-beta", null, "turn_started", {
      source: "channel",
    }),
    observerFrame(
      9,
      ENGINEERING_CHANNEL,
      "turn-beta",
      "session-beta",
      "session_resolved",
      { sessionId: "session-beta", isNewSession: true },
    ),
    manifestFrame(
      10,
      ENGINEERING_CHANNEL,
      "turn-beta",
      "session-beta",
      "Concurrent verification",
      "Verify the second channel independently",
    ),
    updateFrame(11, ENGINEERING_CHANNEL, "turn-beta", "session-beta", {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-beta",
      content: {
        type: "text",
        text: "Engineering verification remains isolated from the Agents-channel turn.",
      },
    }),
  ];
  await page.evaluate(
    ({ agentPubkey, observerEvents }) => {
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey,
        events: observerEvents,
      });
    },
    { agentPubkey: AGENT_PUBKEY, observerEvents: events },
  );
}

async function openSeededFleet(page: Page) {
  await installMockBridge(page, ownerFleetConfig());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await seedFleetActivity(page);
  await page.getByTestId("open-fleet-view").click();
  await expect(page.getByTestId("fleet-screen")).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByTestId(`fleet-turn-turn-alpha-${AGENTS_CHANNEL}`),
  ).toBeVisible();
}

test.describe("owner-only Fleet Control Tower", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("is hidden outside owner-only builds and guards direct navigation", async ({
    page,
  }) => {
    await installMockBridge(page, {
      ...ownerFleetConfig(),
      ownerOnlyAccessBuild: false,
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("open-fleet-view")).toHaveCount(0);

    await page.goto("/#/fleet", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/#\/agents(?:\?|$)/, { timeout: 10_000 });
    await expect(page.getByTestId("fleet-screen")).toHaveCount(0);
  });

  test("keeps Fleet observational in its owner-only empty state", async ({
    page,
  }) => {
    await installMockBridge(
      page,
      ownerFleetConfig({ managedAgents: [], managedAgentRuntimes: [] }),
    );
    await page.goto("/#/fleet", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("fleet-empty")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: /start|stop|restart|send|approve/i }),
    ).toHaveCount(0);
  });

  test("renders exact concurrent turns and captures the Control Tower states", async ({
    page,
  }) => {
    await openSeededFleet(page);

    const fleet = page.getByTestId("fleet-screen");
    const workGraph = page.getByTestId("fleet-work-graph");
    await expect(fleet).toContainText("Fleet Control Tower");
    await expect(fleet).toContainText("Charlie Fleet");
    await expect(fleet).toContainText("Port the dense observer interface");
    await expect(fleet).toContainText("The live reply is streaming");
    await expect(fleet).not.toContainText(SECRET);
    await expect(fleet).not.toContainText("nsec1must-never-render");
    await expect(fleet).not.toContainText("rawInput");
    await expect(
      page.getByRole("button", { name: /start|stop|restart|send|approve/i }),
    ).toHaveCount(0);

    await workGraph.getByRole("button", { name: /engineering/i }).click();
    await expect(
      page.getByTestId(`fleet-turn-turn-beta-${ENGINEERING_CHANNEL}`),
    ).toBeVisible();
    await waitForAnimations(page);
    await workGraph.screenshot({ path: `${SHOTS}/01-work-graph.png` });

    await waitForAnimations(page);
    await fleet.screenshot({ path: `${SHOTS}/02-live-turn-tools.png` });

    const reasoning = page.getByTestId("fleet-reasoning");
    await reasoning.locator("summary").click();
    await expect(reasoning).toHaveAttribute("open", "");
    await waitForAnimations(page);
    await page
      .locator(".tower-live-stream")
      .screenshot({ path: `${SHOTS}/03-reasoning-expanded.png` });

    await page.getByRole("tab", { name: /Context/ }).click();
    const contextManifest = page.getByTestId("fleet-context-manifest");
    await contextManifest
      .getByRole("button", { name: /Base instructions/ })
      .click();
    await expect(page.getByTestId("fleet-context-inspector")).toContainText(
      "Body withheld at source",
    );
    await expect(contextManifest).toContainText("decafbad1234");
    await expect(contextManifest).toContainText("8.3 KiB");
    await waitForAnimations(page);
    await contextManifest.screenshot({
      path: `${SHOTS}/04-context-manifest-inspector.png`,
    });

    await page.getByRole("tab", { name: /Evidence/ }).click();
    const evidence = page.getByTestId("fleet-delivery-evidence");
    await expect(evidence).toContainText("0d7d28476");
    await expect(evidence).toContainText("matherring/BuzzFork#13");
    await expect(evidence).toContainText("No merge evidence");
    await waitForAnimations(page);
    await evidence.screenshot({ path: `${SHOTS}/05-delivery-evidence.png` });

    await page.getByRole("tab", { name: /Artifacts/ }).click();
    const artifacts = page.getByTestId("fleet-artifacts");
    await expect(artifacts).toContainText("FleetScreen.tsx");
    await expect(artifacts).toContainText("controlTowerProjection.ts");
    await waitForAnimations(page);
    await artifacts.screenshot({ path: `${SHOTS}/06-turn-artifacts.png` });

    await page
      .getByTestId(`fleet-turn-turn-beta-${ENGINEERING_CHANNEL}`)
      .click();
    await expect(fleet).toContainText(
      "Verify the second channel independently",
    );
    await expect(fleet).toContainText(
      "Engineering verification remains isolated",
    );
    await expect(fleet).not.toContainText(
      "Context, evidence, and artifacts stay attributed to this session.",
    );
    await waitForAnimations(page);
    await page
      .locator(".tower-sidebar")
      .screenshot({ path: `${SHOTS}/07-concurrent-same-agent-turns.png` });
  });
});
