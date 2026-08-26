import assert from "node:assert/strict";
import test from "node:test";

import {
  canPreviewDocument,
  linkifyLocalDocumentPaths,
  localFileExternalActionLabel,
  localFileReferenceFromHref,
  localFileReferenceFromText,
  localDocumentPathFromHref,
  localDocumentPathFromText,
} from "./localDocumentViewer.ts";

test("recognizes the supported preview document families", () => {
  assert.equal(
    localDocumentPathFromText("/Users/adminmat/.buzz/RESEARCH/REPORT.md"),
    "/Users/adminmat/.buzz/RESEARCH/REPORT.md",
  );
  assert.equal(
    localDocumentPathFromText("/Users/adminmat/.buzz/RESEARCH/REPORT.pdf"),
    "/Users/adminmat/.buzz/RESEARCH/REPORT.pdf",
  );
  assert.equal(canPreviewDocument("REPORT.markdown"), true);
  assert.equal(canPreviewDocument("REPORT.txt"), true);
  assert.equal(canPreviewDocument("REPORT.csv"), true);
  assert.equal(canPreviewDocument("REPORT.pdf"), true);
  assert.equal(localDocumentPathFromText("relative/REPORT.md"), null);
  assert.equal(localDocumentPathFromText("/tmp/source.ts"), null);
  assert.equal(localDocumentPathFromText("/tmp/archive.zip"), null);
  assert.equal(canPreviewDocument("REPORT.docx"), false);
  assert.deepEqual(localFileReferenceFromText("/tmp/archive.zip"), {
    path: "/tmp/archive.zip",
  });
});

test("linkifies bare paths but leaves fenced and non-path inline code unchanged", () => {
  const path = "/Users/adminmat/.buzz/RESEARCH/REPORT.md";
  const output = linkifyLocalDocumentPaths(
    `Open ${path}. Inline \`const path = \"${path}\"\`.\n\n\`\`\`text\n${path}\n\`\`\``,
  );
  assert.match(
    output,
    /\[\/Users\/adminmat\/\.buzz\/RESEARCH\/REPORT\.md\]\(buzz-local-file:/,
  );
  assert.ok(output.includes(`Inline \`const path = \"${path}\"\``));
  assert.ok(output.includes(`text\n${path}\n`));
});

test("linkifies an absolute local path when it is the complete inline-code payload", () => {
  const path = "/Users/adminmat/.buzz/REPOS/fleet/LIVE_FLEET.html";
  const output = linkifyLocalDocumentPaths(`Open \`${path}\` externally.`);
  const href = output.match(/\((buzz-local-file:[^)]+)\)/)?.[1];

  assert.match(
    output,
    /\[`\/Users\/adminmat\/\.buzz\/REPOS\/fleet\/LIVE_FLEET\.html`\]\(buzz-local-file:/,
  );
  assert.ok(href);
  assert.deepEqual(localFileReferenceFromHref(href), { path });
});

test("round-trips encoded viewer hrefs", () => {
  const path = "/Users/adminmat/.buzz/RESEARCH/REPORT.md";
  assert.equal(
    localDocumentPathFromHref(
      `buzz-local-document:${encodeURIComponent(path)}`,
    ),
    path,
  );
  assert.deepEqual(
    localFileReferenceFromHref(
      `buzz-local-file:${encodeURIComponent("/tmp/archive.zip")}`,
    ),
    { path: "/tmp/archive.zip" },
  );
  assert.equal(
    localDocumentPathFromHref("https://example.com/report.md"),
    null,
  );
});

test("carries a declared SHA-256 into a local-file reference", () => {
  const hash = "a".repeat(64);
  const path = "/Users/adminmat/Projects/drafts/REPORT.pdf";
  const output = linkifyLocalDocumentPaths(`PDF: ${path} (sha256 ${hash})`);
  const href = output.match(/\((buzz-local-file:[^)]+)\)/)?.[1];
  assert.ok(href);
  assert.deepEqual(localFileReferenceFromHref(href), {
    expectedSha256: hash,
    path,
  });
  assert.doesNotMatch(output, /\s\(sha256\s+[a-f0-9]{64}\)/i);
});

test("round-trips the serialized local link from a space-containing message path", () => {
  const hash = "b".repeat(64);
  const path = "/private/tmp/Buzz Viewer Evidence/quarterly report.md";
  const output = linkifyLocalDocumentPaths(
    `Open ${path} (sha256 ${hash}) before the review.`,
  );
  const href = output.match(/\((buzz-local-file:[^)]+)\)/)?.[1];

  assert.ok(href, "the message path becomes a local-file link");
  assert.deepEqual(localFileReferenceFromHref(href), {
    expectedSha256: hash,
    path,
  });
  assert.doesNotMatch(output, /quarterly\]$/);
  assert.doesNotMatch(output, /\s\(sha256\s+[a-f0-9]{64}\)/i);
});

test("linkifies unsupported absolute paths as Finder-only local files", () => {
  const output = linkifyLocalDocumentPaths(
    "Keep /Users/adminmat/.buzz/REPOS/app/main.ts as ordinary text.",
  );
  assert.match(output, /buzz-local-file:/);
});

test("keeps local HTML external and labels that action explicitly", () => {
  const path = "/Users/adminmat/.buzz/REPOS/fleet/LIVE_FLEET.html";
  assert.equal(canPreviewDocument(path), false);
  assert.equal(localFileExternalActionLabel(path), "Open externally");
  assert.equal(
    localFileExternalActionLabel("/tmp/meeting-notes.md"),
    "Open with Default App",
  );
  assert.match(linkifyLocalDocumentPaths(`Open \`${path}\`.`), /buzz-local-file:/);
});
