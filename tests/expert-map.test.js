import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildExpertMap } from "../src/expert-map.ts";

function mapForPaths(t, contents, paths) {
  const directory = mkdtempSync(join(tmpdir(), "redzone-codeowners-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "CODEOWNERS"), contents);
  return buildExpertMap({
    repository: "test/repository", pullRequestLimit: 30, pullRequestsFetched: 1,
    pullRequestsWithReviewEvidence: 0, mayHaveMorePullRequests: false,
    records: paths.map((filePath, index) => ({
      filePath, reviewId: `submission-${index}`, author: "contributor", source: "submission",
      pullRequestNumber: 1, pullRequestTitle: "Change", pullRequestUrl: "https://example.invalid/pr/1",
      pullRequestOutcome: "open", reviewUrl: "https://example.invalid/pr/1",
      createdAt: "2026-10-13", hasWrittenFeedback: false,
    })),
  }, directory);
}

test("retains ownerless rules and applies the last matching ownership rule", (t) => {
  const map = mapForPaths(t, [
    "# Ownership defaults", "", "* @default", "src/ @team owner@example.invalid",
    "src/generated/", "src/generated/manual.ts @maintainer", "",
  ].join("\r\n"), ["README.md", "src/main.ts", "src/generated/auto.ts", "src/generated/manual.ts"]);
  assert.deepEqual(map.ownershipRules, [
    { pattern: "*", owners: ["@default"] },
    { pattern: "src/", owners: ["@team", "owner@example.invalid"] },
    { pattern: "src/generated/", owners: [] },
    { pattern: "src/generated/manual.ts", owners: ["@maintainer"] },
  ]);
  const owners = (path) => map.areas.find((area) => area.path === path).codeOwners;
  assert.deepEqual(owners("README.md"), ["@default"]);
  assert.deepEqual(owners("src/main.ts"), ["@team", "owner@example.invalid"]);
  assert.deepEqual(owners("src/generated/auto.ts"), []);
  assert.deepEqual(owners("src/generated/manual.ts"), ["@maintainer"]);
});

test("keeps root anchors and matches unanchored directories at any depth", (t) => {
  for (const [pattern, matches, misses] of [
    ["/README.md", ["README.md"], ["nested/README.md"]],
    ["/*.js", ["app.js"], ["src/app.js"]],
    ["/docs/", ["docs/page.md", "docs/nested/page.md"], ["nested/docs/page.md", "docs.md"]],
    ["docs/", ["docs/page.md", "nested/docs/page.md", "nested/docs/deep/page.md"], ["docs.md", "mydocs/page.md"]],
    ["docs", ["docs/page.md", "nested/docs/page.md"], ["mydocs/page.md"]],
    ["docs/*.md", ["docs/page.md"], ["nested/docs/page.md", "docs/deep/page.md"]],
    ["**/docs/", ["docs/page.md", "nested/docs/page.md"], ["mydocs/page.md"]],
    ["*.js", ["app.js", "src/app.js"], ["src/app.ts"]],
  ]) {
    const map = mapForPaths(t, `* @default\n${pattern} @owner\n`, [...matches, ...misses]);
    for (const path of matches) {
      assert.deepEqual(map.areas.find((area) => area.path === path).codeOwners, ["@owner"], `${pattern} matches ${path}`);
    }
    for (const path of misses) {
      assert.deepEqual(map.areas.find((area) => area.path === path).codeOwners, ["@default"], `${pattern} excludes ${path}`);
    }
  }
});
