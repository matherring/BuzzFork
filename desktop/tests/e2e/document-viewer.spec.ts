import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

type MockMessageInput = {
  channelName: string;
  content: string;
  extraTags?: string[][];
};

async function emitMessage(page: Page, input: MockMessageInput) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
  );
  await page.evaluate((message) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.(message);
  }, input);
}

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
});

test("uses the native default-app command for a local Markdown card", async ({
  page,
}) => {
  const path = "/Users/adminmat/.buzz/RESEARCH/REPORT.md";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = page
    .getByTestId("message-row")
    .filter({ hasText: path })
    .getByTestId("local-file-card");
  await card.getByTestId("local-file-card-open").click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__BUZZ_E2E_COMMANDS__?.includes("open_local_document"),
      ),
    )
    .toBe(true);
  await expect(page.getByTestId("document-viewer-pane")).toBeHidden();
});

test("opens a local Markdown preview from the explicit card menu action", async ({
  page,
}) => {
  const path = "/Users/adminmat/.buzz/RESEARCH/REPORT.md";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = page
    .getByTestId("message-row")
    .filter({ hasText: path })
    .getByTestId("local-file-card");
  await card.getByTestId("local-file-card-menu").click();
  await page.getByRole("button", { name: "Preview in Buzz" }).click();

  await expect(page.getByTestId("document-viewer-pane")).toBeVisible();
  await expect(page.getByTestId("document-viewer-markdown")).toContainText(
    "Viewer heading",
  );
  await expect(page.getByTestId("message-timeline")).toBeVisible();

  await page.getByRole("button", { name: "Close document viewer" }).click();
  await expect(page.getByTestId("document-viewer-pane")).toBeHidden();
});

test("shows an explicit denial for a local path outside the approved root", async ({
  page,
}) => {
  const path = "/Users/adminmat/.codex/NOTES.txt";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = page
    .getByTestId("message-row")
    .filter({ hasText: path })
    .getByTestId("local-file-card");
  await card.getByTestId("local-file-card-menu").click();
  await page.getByRole("button", { name: "Preview in Buzz" }).click();

  await expect(page.getByTestId("document-viewer-pane")).toContainText(
    "outside the locally approved document folders",
  );
});

test("renders a local-file card without reading the path", async ({ page }) => {
  const path = "/Users/adminmat/.codex/private/archive.zip";
  await emitMessage(page, {
    channelName: "general",
    content: `Keep ${path} for later.`,
  });

  await expect(
    page
      .getByTestId("message-row")
      .filter({ hasText: path })
      .getByTestId("local-file-card"),
  ).toContainText("Reveal only");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__BUZZ_E2E_COMMANDS__?.includes("read_local_document"),
      ),
    )
    .toBe(false);
});

test("opens a verified CSV attachment in the same side panel and keeps download", async ({
  page,
}) => {
  const url = `https://relay.example/media/${"a".repeat(64)}.bin`;
  const filename = "REPORT.csv";
  await emitMessage(page, {
    channelName: "general",
    content: `[${filename}](${url})`,
    extraTags: [
      [
        "imeta",
        `url ${url}`,
        "m application/octet-stream",
        `x ${"a".repeat(64)}`,
        "size 21",
        `filename ${filename}`,
      ],
    ],
  });

  const card = page.getByTestId("file-card").filter({ hasText: filename });
  await expect(card.getByTestId("file-card-download")).toBeVisible();
  await card.getByTestId("file-card-open").click();

  await expect(page.getByTestId("document-viewer-pane")).toBeVisible();
  await expect(page.getByTestId("document-viewer-csv")).toContainText(
    "answer,42",
  );
  await expect(
    page.getByRole("button", { name: `Download ${filename}` }),
  ).toBeVisible();
});
