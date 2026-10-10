import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { collectReviewEvidence } from "../src/github.ts";

test("retrieves formal decisions and later comment pages for overlapping PRs", (t) => {
  const originalRepo = process.env.GH_REPO;
  const originalLimit = process.env.REDZONE_PR_LIMIT;
  process.env.GH_REPO = "test/repository";
  process.env.REDZONE_PR_LIMIT = "30";
  t.after(() => {
    for (const [key, value] of [["GH_REPO", originalRepo], ["REDZONE_PR_LIMIT", originalLimit]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const calls = [];
  const comment = (id, path) => ({
    id, path, body: `comment ${id}`, html_url: `https://example.invalid/${id}`,
    created_at: "2026-10-10", user: { login: "reviewer" },
  });
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    assert.equal(command, "gh");
    const [api, endpoint, ...flags] = args;
    assert.equal(api, "api");
    calls.push(endpoint);
    if (endpoint.includes("/pulls?")) {
      assert.deepEqual(flags, []);
      return JSON.stringify([
        { number: 1, title: "Earlier PR", html_url: "https://example.invalid/pr/1", head: { sha: "old" } },
        { number: 2, head: { sha: "current" } },
      ]);
    }
    assert.deepEqual(flags, ["--paginate", "--slurp"]);
    if (endpoint.includes("/files?")) {
      return JSON.stringify([Array.from({ length: 100 }, (_, i) => ({ filename: `other-${i}` })), [{ filename: "target" }]]);
    }
    if (endpoint.includes("/reviews?")) {
      return JSON.stringify([[{
        id: 5, state: "CHANGES_REQUESTED", body: "Please handle the race.",
        html_url: "https://example.invalid/review/5", submitted_at: "2026-10-10",
        user: { login: "reviewer" },
      }]]);
    }
    if (endpoint.includes("/pulls/1/comments?")) {
      return JSON.stringify([Array.from({ length: 100 }, (_, i) => comment(i, "unrelated")), [comment(101, "target")]]);
    }
    assert.match(endpoint, /\/issues\/1\/comments\?/);
    return JSON.stringify([[comment(102)], [comment(103, "unrelated")]]);
  });
  syncBuiltinESMExports();
  const collection = collectReviewEvidence({ changedFiles: ["target"], headSha: "current" });
  assert.deepEqual(collection.evidence.map(({ id }) => id), [
    "formal-5", "review-101", "conversation-102", "conversation-103",
  ]);
  assert.equal(collection.evidence[0].decision, "CHANGES_REQUESTED");
  assert.deepEqual(collection.coverage, {
    githubConfigured: true,
    repository: "test/repository",
    pullRequestLimit: 30,
    pullRequestsFetched: 2,
    overlappingPullRequests: 1,
    mayHaveMorePullRequests: false,
    evidenceCounts: { formalReviews: 1, inlineComments: 1, conversationComments: 2 },
  });
  assert.equal(calls.length, 5);
});
