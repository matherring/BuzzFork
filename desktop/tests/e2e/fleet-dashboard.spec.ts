import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const AGENT_PUBKEY =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";
const CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301";
const RELAY_URL = "ws://localhost:3000";
const SECRET = "BUZZ_PRIVATE_KEY=nsec1must-never-render";
const SHOTS = "test-results/fleet-dashboard";

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
        status: "running" as const,
        channelNames: ["agents"],
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

async function waitForFleetSeedHooks(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () =>
      typeof window.__BUZZ_E2E_SEED_ACTIVE_TURNS__ === "function" &&
      typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
    null,
    { timeout: 10_000 },
  );
}

async function seedFleetActivity(page: import("@playwright/test").Page) {
  await waitForFleetSeedHooks(page);
  await page.evaluate(
    ({ agentPubkey, channelId, secret }) => {
      window.__BUZZ_E2E_SEED_ACTIVE_TURNS__?.({
        agentPubkey,
        channelId,
        turnId: "turn-fleet-1",
      });
      const timestamp = new Date().toISOString();
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey,
        events: [
          {
            seq: 9001,
            timestamp,
            kind: "acp_read",
            agentIndex: 0,
            channelId,
            sessionId: "session-fleet-1",
            turnId: "turn-fleet-1",
            payload: {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: "Reviewed the deployment queue safely.",
                  },
                },
              },
            },
          },
          {
            seq: 9002,
            timestamp,
            kind: "acp_read",
            agentIndex: 0,
            channelId,
            sessionId: "session-fleet-1",
            turnId: "turn-fleet-1",
            payload: {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "secret-tool",
                  title: "Shell",
                  kind: "execute",
                  rawInput: { command: `echo ${secret}` },
                  rawOutput: `unredacted output ${secret}`,
                  status: "completed",
                },
              },
            },
          },
        ],
      });
    },
    { agentPubkey: AGENT_PUBKEY, channelId: CHANNEL_ID, secret: SECRET },
  );
}

test.describe("owner-only Fleet dashboard", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (error) =>
      console.error("PAGE ERROR:", error.message),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        console.error("CONSOLE ERROR:", message.text());
    });
  });

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

  test("shows a safe owner-only empty state without mutation controls", async ({
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
      page.getByRole("button", {
        name: /start|stop|restart|send|approve|configure/i,
      }),
    ).toHaveCount(0);
  });

  test("projects native observer state, filters, navigates, and never reveals tool payloads", async ({
    page,
  }) => {
    await installMockBridge(page, ownerFleetConfig());
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("open-fleet-view")).toBeVisible({
      timeout: 10_000,
    });
    await seedFleetActivity(page);
    await page.getByTestId("open-fleet-view").click();

    const fleet = page.getByTestId("fleet-screen");
    const row = page.getByTestId(`fleet-agent-${AGENT_PUBKEY}`);
    await expect(fleet).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("Charlie Fleet");
    await expect(row).toContainText("Codex (runtime catalog)");
    await expect(row).toContainText("Active");
    await expect(row).toContainText("#agents");
    await expect(row).toContainText("turn-fleet-1");
    await expect(row).toContainText(/Ran command|Turn started/);
    await expect(fleet).not.toContainText(SECRET);
    await expect(fleet).not.toContainText("unredacted output");
    await expect(fleet).not.toContainText("rawInput");
    await expect(
      page.getByRole("button", {
        name: /start|stop|restart|send|approve|configure/i,
      }),
    ).toHaveCount(0);

    await page.getByTestId("fleet-status-filter").selectOption("offline");
    await expect(page.getByTestId("fleet-filter-empty")).toBeVisible();
    await page.getByTestId("fleet-status-filter").selectOption("active");
    await expect(row).toBeVisible();

    await waitForAnimations(page);
    await fleet.screenshot({ path: `${SHOTS}/01-native-fleet-dashboard.png` });
    await page
      .getByTestId("app-sidebar")
      .screenshot({ path: `${SHOTS}/02-fleet-sidebar-entry.png` });

    await row.getByRole("button", { name: "#agents" }).click();
    await expect(page).toHaveURL(new RegExp(`#/channels/${CHANNEL_ID}`));
  });

  test("opens the existing agent profile surface", async ({ page }) => {
    await installMockBridge(page, ownerFleetConfig());
    await page.goto("/#/fleet", { waitUntil: "domcontentloaded" });
    const row = page.getByTestId(`fleet-agent-${AGENT_PUBKEY}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole("button", { name: "Charlie Fleet" }).click();
    await expect(page).toHaveURL(
      new RegExp(`#/agents\\?profile=${AGENT_PUBKEY}`),
    );
    await expect(page.getByTestId("user-profile-panel")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("renders classified errors without exposing raw error text", async ({
    page,
  }) => {
    await installMockBridge(
      page,
      ownerFleetConfig({
        managedAgents: [
          {
            pubkey: AGENT_PUBKEY,
            name: "Charlie Fleet",
            runtime: "codex",
            status: "stopped",
            channelNames: ["agents"],
            lastError: `process failed with ${SECRET}`,
          },
        ],
        managedAgentRuntimes: [
          {
            pubkey: AGENT_PUBKEY,
            relayUrl: RELAY_URL,
            lifecycle: "failed",
          },
        ],
      }),
    );
    await page.goto("/#/fleet", { waitUntil: "domcontentloaded" });

    const row = page.getByTestId(`fleet-agent-${AGENT_PUBKEY}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("Failed");
    await expect(row).toContainText("Runtime failed");
    await expect(row).not.toContainText(SECRET);
  });
});
