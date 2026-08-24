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

test("uses the native default-app command for a local Markdown card", async ({
  page,
}) => {
  const path = "/Users/adminmat/.buzz/RESEARCH/REPORT.md";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = localFileCard(page, "REPORT.md");
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
  const path = "/Users/adminmat/.buzz/RESEARCH/REPORT.md";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = localFileCard(page, "REPORT.md");
  await card.getByTestId("local-file-card-menu").click();
  await page.getByRole("button", { name: "Preview in Buzz" }).click();

  await expect(page.getByTestId("document-viewer-content")).toBeVisible();
  await expect(page.getByTestId("document-viewer-markdown")).toContainText(
    "Viewer heading",
  );
  await expect(page.getByTestId("message-timeline")).toBeVisible();

  await page.getByRole("button", { name: "Close document viewer" }).click();
  await expect(page.getByTestId("document-viewer-content")).toBeHidden();
});

test("shows an explicit denial for a local path outside the approved root", async ({
  page,
}) => {
  const path = "/Users/adminmat/.codex/NOTES.txt";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = localFileCard(page, "NOTES.txt");
  await card.getByTestId("local-file-card-menu").click();
  await page.getByRole("button", { name: "Preview in Buzz" }).click();

  await expect(page.getByTestId("document-viewer-content")).toContainText(
    "outside the locally approved document folders",
  );
});

test("renders a local-file card without reading the path", async ({ page }) => {
  const path = "/Users/adminmat/.codex/private/archive.zip";
  await emitMessage(page, {
    channelName: "general",
    content: `Keep ${path} for later.`,
  });

  await expect(localFileCard(page, "archive.zip")).toContainText("Reveal only");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__BUZZ_E2E_COMMANDS__?.includes("read_local_document"),
      ),
    )
    .toBe(false);
});

test("approves a document folder through the backend-owned picker flow", async ({
  page,
}) => {
  const path = "/Users/adminmat/.codex/private/REPORT.md";
  await emitMessage(page, {
    channelName: "general",
    content: `Open ${path}.`,
  });

  const card = localFileCard(page, "REPORT.md");
  await card.getByTestId("local-file-card-menu").click();
  const menu = page.locator("[data-local-file-context-menu]");
  await expect(menu).toBeVisible();
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const margin = 8;
        return (
          bounds.left >= margin &&
          bounds.top >= margin &&
          bounds.right <= window.innerWidth - margin &&
          bounds.bottom <= window.innerHeight - margin
        );
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Choose approved folder…" }).click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__BUZZ_E2E_COMMANDS__?.includes("choose_document_root"),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__BUZZ_E2E_COMMANDS__?.some((command) =>
          ["pick_document_root", "add_document_root"].includes(command),
        ),
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
    page.getByRole("button", { name: `Download ${filename}` }),
  ).toBeVisible();
});
