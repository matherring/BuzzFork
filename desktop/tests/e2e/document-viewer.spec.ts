import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

type MockMessageInput = {
  channelName: string;
  content: string;
  extraTags?: string[][];
};

function cliDocumentUpload(filename: string, mime: string, size: number) {
  const hash = "a".repeat(64);
  const url = `https://relay.example/media/${hash}.bin`;
  return {
    // Exact generic-document shape emitted by `buzz messages send --file`:
    // a normal filename anchor plus the filename-bearing imeta tag. This must
    // not regress to the image syntax used for photos.
    content: `\n[${filename}](${url})`,
    extraTags: [
      [
        "imeta",
        `url ${url}`,
        `m ${mime}`,
        `x ${hash}`,
        `size ${size}`,
        `filename ${filename}`,
      ],
    ],
    url,
  };
}

async function emitMessage(page: Page, input: MockMessageInput) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
  );
  await page.evaluate((message) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.(message);
  }, input);
}

function localFileCard(page: Page, filename: string) {
  return page.getByTestId("local-file-card").filter({
    has: page.getByRole("button", {
      exact: true,
      name: `More actions for ${filename}`,
    }),
  });
}

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
});

test("uses the native default-app command for a local DOCX card", async ({
  page,
}) => {
  const path =
    "/Users/adminmat/Projects/business-ops/entities/vbw-events/drafts/REPORT.docx";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = localFileCard(page, "REPORT.docx");
  await expect(card).toContainText("opens in default app");
  await card.getByTestId("local-file-card-open").click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__BUZZ_E2E_COMMANDS__?.includes("open_local_document"),
      ),
    )
    .toBe(true);
  await expect(page.getByTestId("document-viewer-content")).toBeHidden();
});

test("opens a local Markdown preview from the explicit card menu action", async ({
  page,
}) => {
  const path = "/Users/adminmat/Projects/business-ops/drafts/REPORT.md";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = localFileCard(page, "REPORT.md");
  await card.getByTestId("local-file-card-menu").click();
  await page.getByRole("button", { name: "Open in Buzz Preview" }).click();

  await expect(page.getByTestId("document-viewer-content")).toBeVisible();
  await expect(page.getByTestId("document-viewer-markdown")).toContainText(
    "Viewer heading",
  );
  await expect(page.getByTestId("message-timeline")).toBeVisible();

  await page.getByRole("button", { name: "Close document viewer" }).click();
  await expect(page.getByTestId("document-viewer-content")).toBeHidden();
});

test("previews a local PDF without setup", async ({ page }) => {
  const path =
    "/Users/adminmat/Projects/business-ops/entities/vbw-events/drafts/REPORT.pdf";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = localFileCard(page, "REPORT.pdf");
  await card.getByTestId("local-file-card-menu").click();
  await page.getByRole("button", { name: "Open in Buzz Preview" }).click();

  await expect(page.getByTestId("document-viewer-pdf")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close document viewer" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("document-viewer-content")).toBeHidden();
});

test("explains that local DOCX preview is not available yet", async ({
  page,
}) => {
  const path = "/Users/adminmat/Projects/business-ops/drafts/REPORT.docx";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = localFileCard(page, "REPORT.docx");
  await card.getByTestId("local-file-card-menu").click();
  await page.getByRole("button", { name: "Open in Buzz Preview" }).click();

  await expect(page.getByTestId("document-viewer-content")).toContainText(
    "Buzz preview does not support this file type yet. Open it in its default app instead.",
  );
});

test("renders a local-file card without reading the path", async ({ page }) => {
  const path = "/Users/adminmat/.codex/private/archive.zip";
  await emitMessage(page, {
    channelName: "general",
    content: `Keep ${path} for later.`,
  });

  const card = localFileCard(page, "archive.zip");
  await expect(card).toContainText("opens in default app");
  await card.getByTestId("local-file-card-menu").click();
  await expect(
    page.getByRole("button", { name: "Open in Buzz Preview" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose approved folder…" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Document access settings…" }),
  ).toHaveCount(0);
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
  const filename = "REPORT.csv";
  const upload = cliDocumentUpload(filename, "application/octet-stream", 21);
  await emitMessage(page, {
    channelName: "general",
    content: upload.content,
    extraTags: upload.extraTags,
  });

  const card = page.getByTestId("file-card").filter({ hasText: filename });
  await expect(card.getByTestId("file-card-download")).toBeVisible();
  await card.getByTestId("file-card-open").click();

  await expect(page.getByTestId("document-viewer-content")).toBeVisible();
  await expect(page.getByTestId("document-viewer-csv")).toContainText(
    "answer,42",
  );
  await expect(
    page
      .getByTestId("document-viewer-content")
      .getByRole("button", { name: `Download ${filename}` }),
  ).toBeVisible();
});
