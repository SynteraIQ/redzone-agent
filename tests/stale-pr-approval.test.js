import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

// Exercise Next.js handlers without starting a server or loading auth providers.
function loadModule(path, mocks = {}) {
  const filename = new URL(path, import.meta.url);
  const require = createRequire(filename);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  new Function("require", "exports", "process", "console", outputText)(
    (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id), exports,
    { env: { NODE_ENV: "test", NEXTAUTH_SECRET: "synthetic-test-secret" } },
    { info() {}, error() {} },
  );
  return exports;
}

const references = loadModule("../src/automations/stale-pr/run-reference.ts");
const { createStalePullRequestApprovalToken } = loadModule("../src/automations/stale-pr/approval-token.ts");
const reportRunId = "wrun_report";
const ownerRunId = "wrun_owner";
const duplicateRunId = "wrun_duplicate";
const subject = "test-user";
const repository = "test/repository";
const decision = { decision: "approved", actor: "Reviewer", decidedAt: "2026-10-14T00:00:00Z" };

function reference(runId, requestId, kind = "approval") {
  return references.createStalePullRequestRunReference(runId, repository, subject, requestId, kind);
}

function request(body) {
  return new Request("https://example.invalid/api/automations/stale-pr/approval", {
    method: "POST", body: JSON.stringify(body),
  });
}

function loadRoute({ api = {}, find = async () => null, runs = {} } = {}) {
  return loadModule("../src/app/api/automations/stale-pr/approval/route.ts", {
    "next-auth": { getServerSession: async () => null },
    "next/server": {},
    "../../../../../auth.ts": { githubOAuthConfigured: false },
    "../../../../../github-app.ts": {
      getSelectedRepositoryContextForRequest: async () => ({ subject, repository }),
    },
    "../../../../../automations/stale-pr/run-reference.ts": references,
    "../../../../../automations/stale-pr/approval-token.ts": { createStalePullRequestApprovalToken },
    "../../../../../automations/stale-pr/workflow.ts": { waitForStalePullRequestApproval() {} },
    "workflow/runtime": { getWorld: async () => ({
      analytics: { runs: { list: async () => ({ data: [await find()].filter(Boolean) }) } },
    }) },
    "workflow/api": {
      getRun: (id) => ({ exists: true, status: "running", ...runs[id] }),
      getHookByToken: async () => { throw new Error("Hook not registered"); },
      start: async () => { throw new Error("Unexpected start"); },
      resumeHook: async () => { throw new Error("Unexpected resume"); },
      ...api,
    },
  });
}

test("concurrent review requests use one report token and return the hook owner", async () => {
  const starts = [];
  let lookups = 0;
  let releaseLookups;
  const bothLookups = new Promise((resolve) => { releaseLookups = resolve; });
  const { POST } = loadRoute({
    find: async () => {
      if (++lookups === 2) releaseLookups();
      await bothLookups;
      return null;
    },
    runs: { [reportRunId]: { status: "completed" } },
    api: {
      start: async (_workflow, [input], options) => {
        starts.push({ input, options });
        return { runId: starts.length === 1 ? ownerRunId : duplicateRunId };
      },
      getHookByToken: async (token) => {
        assert.equal(token, createStalePullRequestApprovalToken(reportRunId));
        return { runId: ownerRunId };
      },
    },
  });
  const body = { action: "request", reportRef: reference(reportRunId, "report-request", "report") };
  const responses = await Promise.all([POST(request(body)), POST(request(body))]);
  assert.equal(starts.length, 2); // start() enqueues before hook registration.
  for (const { input, options } of starts) {
    assert.equal(input.approvalRequestId, reportRunId);
    assert.equal(options.attributes.approvalRequestId, reportRunId);
  }
  for (const response of responses) {
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ready, true);
    assert.equal(references.readStalePullRequestRunReference(payload.approvalRef).runId, ownerRunId);
  }
});

test("a duplicate that finishes before its hook is polled resolves to the original decision", async () => {
  const { GET } = loadRoute({ runs: {
    [duplicateRunId]: { status: "completed", returnValue: { approvalRunId: ownerRunId } },
    [ownerRunId]: { status: "completed", returnValue: decision },
  } });
  const response = await GET({ nextUrl: new URL(
    `https://example.invalid/?approvalRef=${encodeURIComponent(reference(duplicateRunId, reportRunId))}`,
  ) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.decision, decision);
  assert.equal(references.readStalePullRequestRunReference(payload.approvalRef).runId, ownerRunId);
});

test("an existing approval is reused, including its original request identifier", async () => {
  const { POST } = loadRoute({
    find: async () => ({ runId: ownerRunId, status: "running", attributes: { approvalRequestId: "legacy-request" } }),
    runs: { [reportRunId]: { status: "completed" } },
    api: { getHookByToken: async (token) => {
      assert.equal(token, createStalePullRequestApprovalToken("legacy-request"));
      return { runId: ownerRunId };
    } },
  });
  const response = await POST(request({ action: "request", reportRef: reference(reportRunId, "report-request", "report") }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
});

test("the approval workflow returns a conflict owner without waiting for a second decision", async () => {
  const { waitForStalePullRequestApproval } = loadModule("../src/automations/stale-pr/workflow.ts", {
    "../../github.ts": {},
    "../../github-app.ts": {},
    "./approval-token.ts": { createStalePullRequestApprovalToken },
    workflow: { createHook: ({ token }) => {
      assert.equal(token, createStalePullRequestApprovalToken(reportRunId));
      return {
        getConflict: async () => ({ runId: ownerRunId }),
        then() { assert.fail("A duplicate must not wait for a decision"); },
      };
    } },
  });
  assert.deepEqual(await waitForStalePullRequestApproval({ approvalRequestId: reportRunId }), { approvalRunId: ownerRunId });
});

test("the approval workflow records a decision when it owns the token", async () => {
  const input = {
    approvalRequestId: reportRunId, reportRequestId: "report-request", repository,
    requestedBy: "Reviewer", requestedAt: "2026-10-14T00:00:00Z",
  };
  const { waitForStalePullRequestApproval } = loadModule("../src/automations/stale-pr/workflow.ts", {
    "../../github.ts": {}, "../../github-app.ts": {},
    "./approval-token.ts": { createStalePullRequestApprovalToken },
    workflow: { createHook: () => ({
      getConflict: async () => null,
      then: (resolve, reject) => Promise.resolve(decision).then(resolve, reject),
    }) },
  });
  assert.deepEqual(await waitForStalePullRequestApproval(input), {
    reportRequestId: input.reportRequestId, repository, requestedBy: input.requestedBy,
    requestedAt: input.requestedAt, ...decision,
  });
});

test("a decision is resumed only after verifying the hook belongs to the referenced run", async (t) => {
  for (const hookState of ["missing", "different-run", "matching"]) {
    await t.test(hookState, async () => {
      const events = [];
      const token = createStalePullRequestApprovalToken(reportRunId);
      const { POST } = loadRoute({ api: {
        getHookByToken: async (value) => {
          assert.equal(value, token);
          events.push("lookup");
          if (hookState === "missing") throw new Error("Hook not found");
          return { runId: hookState === "matching" ? ownerRunId : duplicateRunId };
        },
        resumeHook: async (value, payload) => {
          assert.equal(value, token);
          assert.equal(payload.decision, "rejected");
          assert.equal(payload.rationale, "Needs another review");
          events.push("resume");
        },
      } });
      const response = await POST(request({
        action: "decision", approvalRef: reference(ownerRunId, reportRunId),
        decision: "rejected", rationale: "Needs another review",
      }));
      assert.equal(response.status, hookState === "matching" ? 200 : 409);
      assert.deepEqual(events, hookState === "matching" ? ["lookup", "resume"] : ["lookup"]);
      if (hookState !== "matching") assert.deepEqual(await response.json(), { error: "Review step not ready." });
    });
  }
});
