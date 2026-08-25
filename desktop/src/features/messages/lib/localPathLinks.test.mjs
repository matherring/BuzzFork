import assert from "node:assert/strict";
import test from "node:test";

const source = await import("./localPathLinks.ts");
const { decodeLocalPathHref, linkifyLocalPaths } = source;

test("linkifies supported absolute and home-relative paths", () => {
  const output = linkifyLocalPaths("See /Users/mat/notes.md and ~/Projects/app/main.ts.");
  assert.match(output, /buzz-local:\/\/open\?path=%2FUsers%2Fmat%2Fnotes.md/);
  assert.match(output, /buzz-local:\/\/open\?path=~%2FProjects%2Fapp%2Fmain.ts/);
});

test("does not link URLs or unapproved system paths", () => {
  const output = linkifyLocalPaths("https://example.com/x /etc/passwd");
  assert.doesNotMatch(output, /buzz-local:/);
});

test("decodes only buzz-local open paths", () => {
  assert.equal(
    decodeLocalPathHref("buzz-local://open?path=%2FUsers%2Fmat%2Fnotes.md"),
    "/Users/mat/notes.md",
  );
  assert.equal(decodeLocalPathHref("file:///Users/mat/notes.md"), null);
  assert.equal(decodeLocalPathHref("buzz-local://read?path=%2FUsers%2Fmat%2Fnotes.md"), null);
  assert.equal(decodeLocalPathHref("buzz-local://open?path=relative.md"), null);
});
