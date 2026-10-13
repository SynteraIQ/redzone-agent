import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { collectReviewEvidence } from "../src/github.ts";

test("retrieves formal decisions and later comment pages for overlapping PRs", async (t) => {
  const originalLimit = process.env.REDZONE_PR_LIMIT;
  process.env.REDZONE_PR_LIMIT = "30";
  t.after(() => {
    if (originalLimit === undefined) delete process.env.REDZONE_PR_LIMIT;
    else process.env.REDZONE_PR_LIMIT = originalLimit;
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
      }, {
        id: 6, state: "APPROVED", body: "",
        html_url: "https://example.invalid/review/6", submitted_at: "2026-10-10",
      }, {
        id: 7, state: "COMMENTED",
        html_url: "https://example.invalid/review/7", submitted_at: "2026-10-10",
      }, {
        id: 8, state: "PENDING", body: "Unsubmitted draft",
      }]]);
    }
    if (endpoint.includes("/pulls/1/comments?")) {
      return JSON.stringify([Array.from({ length: 100 }, (_, i) => comment(i, "unrelated")), [comment(101, "target")]]);
    }
    assert.match(endpoint, /\/issues\/1\/comments\?/);
    return JSON.stringify([
      [comment(102)],
      [
        comment(103, "unrelated"),
        { ...comment(104), user: { login: "coderabbitai[bot]" } },
      ],
    ]);
  });
  syncBuiltinESMExports();
  const collection = await collectReviewEvidence(
    { changedFiles: ["target"], headSha: "current" },
    undefined,
    "test/repository",
  );
  assert.deepEqual(collection.evidence.map(({ id }) => id), [
    "formal-5", "formal-6", "formal-7", "review-101", "conversation-102", "conversation-103",
  ]);
  assert.equal(collection.evidence[0].decision, "CHANGES_REQUESTED");
  assert.deepEqual(collection.evidence.slice(1, 3).map(({ decision, body }) => ({ decision, body })), [
    { decision: "APPROVED", body: "" },
    { decision: "COMMENTED", body: "" },
  ]);
  assert.deepEqual(collection.coverage, {
    githubConfigured: true,
    repository: "test/repository",
    pullRequestLimit: 30,
    pullRequestsFetched: 2,
    overlappingPullRequests: 1,
    mayHaveMorePullRequests: false,
    evidenceCounts: {
      formalReviews: 3,
      inlineComments: 1,
      conversationComments: 2,
      automatedConversationCommentsSkipped: 1,
    },
  });
  assert.equal(calls.length, 5);
});
