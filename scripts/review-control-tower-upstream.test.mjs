import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("./review-control-tower-upstream.sh", import.meta.url)
  .pathname;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("reports exact commits, changed files, and license status from a local fixture", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-upstream-review-test-"));
  try {
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    mkdirSync(source);
    git(source, "init", "--quiet");
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.test");
    writeFileSync(path.join(source, "behavior.txt"), "baseline\n");
    git(source, "add", "behavior.txt");
    git(source, "commit", "--quiet", "-m", "baseline behavior");
    const baseline = git(source, "rev-parse", "HEAD");

    writeFileSync(path.join(source, "behavior.txt"), "changed\n");
    writeFileSync(path.join(source, "LICENSE"), "fixture license\n");
    git(source, "add", "behavior.txt", "LICENSE");
    git(source, "commit", "--quiet", "-m", "change behavior and license");
    const requested = git(source, "rev-parse", "HEAD");
    git(root, "clone", "--quiet", "--bare", source, remote);

    const output = execFileSync(
      "sh",
      [script, "--remote", remote, "--baseline", baseline, "--ref", requested],
      { encoding: "utf8" },
    );

    assert.match(output, new RegExp(`Requested commit: ${requested}`));
    assert.match(output, new RegExp(`Resolved baseline commit: ${baseline}`));
    assert.match(output, /change behavior and license/);
    assert.match(output, /M\s+behavior\.txt/);
    assert.match(output, /A\s+LICENSE/);
    assert.match(
      output,
      /License-file status at requested commit:\npresent\nLICENSE/,
    );
    assert.match(output, /temporary bare fetch only/);
    assert.match(output, /no baseline update and no production-state mutation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports no changes and an absent license at an unchanged baseline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-upstream-review-same-"));
  try {
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    mkdirSync(source);
    git(source, "init", "--quiet");
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.test");
    writeFileSync(path.join(source, "README.md"), "fixture\n");
    git(source, "add", "README.md");
    git(source, "commit", "--quiet", "-m", "fixture baseline");
    const baseline = git(source, "rev-parse", "HEAD");
    git(root, "clone", "--quiet", "--bare", source, remote);

    const output = execFileSync(
      "sh",
      [script, "--remote", remote, "--baseline", baseline, "--ref", baseline],
      { encoding: "utf8" },
    );
    assert.match(
      output,
      /Changed commits \(baseline\.\.requested\):\n\(none\)/,
    );
    assert.match(output, /Changed files \(baseline\.\.requested\):\n\(none\)/);
    assert.match(output, /License-file status at requested commit:\nabsent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
