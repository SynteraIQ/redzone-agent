import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { FatalError, RetryableError } from "workflow";
import { dehydrateStepError, hydrateStepError } from "@workflow/core/serialization";

function loadModule(path, mocks, globals = {}, suffix = "") {
  const filename = new URL(path, import.meta.url);
  const require = createRequire(filename);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports = {};
  new Function("require", "exports", ...Object.keys(globals), outputText + suffix)(
    (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id), exports, ...Object.values(globals),
  );
  return exports;
}

const input = {
  repository: "test/repository", installationId: 1, requestId: "test-run",
  startedAt: "2026-10-14T00:00:00Z", config: { staleAfterDays: 30, includeDrafts: false },
};
const roundTrip = async (error) => hydrateStepError(
  await dehydrateStepError(error, "test-run"), "test-run",
);

for (const stepId of ["fetch-open-pull-requests", "apply-staleness-rule"]) {
  for (const recovers of [true, false]) {
    test(`${stepId}: ${recovers ? "recovered retry emits no failure" : "exhausted retries emit one failure for the active step"}`, async () => {
      const events = [];
      let attempts = 0;
      let writers = 0;
      let released = 0;
      let closed = 0;
      const workflow = loadModule("../src/automations/stale-pr/workflow.ts", {
        "../../github-app.ts": { createInstallationTokenForWorkflow: async () => "synthetic-token" },
        "../../github.ts": { collectOpenPullRequests: async () => [] },
        workflow: { getWritable: () => ({ getWriter: () => {
          writers++;
          return {
            async write(event) {
              if (event.stepId === stepId && event.status === "running" && (!recovers || attempts < 3)) {
                throw new RetryableError("Synthetic scan error", { retryAfter: 1000 });
              }
              events.push(event);
            },
            async close() { closed++; },
            releaseLock() { released++; },
          };
        } }) },
      }, { console: { info() {} } }, `
        exports.retryScan = (retry) => {
          const scan = scanStalePullRequests;
          scanStalePullRequests = (...args) => retry(() => scan(...args));
        };
      `);
      workflow.retryScan(async (scan) => {
        while (attempts < 3) {
          attempts++;
          try { return await scan(); }
          catch (error) {
            assert.equal(events.filter(({ status }) => status === "failed").length, 0);
            const hydrated = await roundTrip(error);
            assert.ok(RetryableError.is(hydrated));
            assert.equal(hydrated.cause.stepId, stepId);
            if (attempts === 3) {
              const exhausted = new FatalError("Retries exhausted");
              exhausted.cause = hydrated;
              throw await roundTrip(exhausted);
            }
          }
        }
      });
      if (recovers) {
        assert.equal((await workflow.runStalePullRequestWorkflow(input)).scannedPullRequestCount, 0);
        assert.deepEqual(events.filter(({ status }) => status === "failed"), []);
      } else {
        await assert.rejects(workflow.runStalePullRequestWorkflow(input), /Retries exhausted/);
        assert.deepEqual(events.filter(({ status }) => status === "failed").map((event) => event.stepId), [stepId]);
      }
      assert.equal(attempts, 3);
      assert.equal(closed, 1);
      assert.equal(released, writers);
    });
  }
}

test("history rejects invalid dates and preserves the inclusive one-day cutoff", async (t) => {
  const now = Date.parse("2026-10-14T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  const run = (requestId, startedAt, createdAt = startedAt) => ({
    runId: requestId, status: "completed", startedAt, createdAt,
    attributes: { requestId, threshold: "30", unit: "days" },
  });
  const { GET } = loadModule("../src/app/api/automations/stale-pr/route.ts", {
    "workflow/api": {},
    "workflow/runtime": { getWorld: async () => ({ analytics: { runs: { list: async () => ({ data: [
      run("recent", new Date(now)), run("boundary", new Date(now - 86_400_000)),
      run("old", new Date(now - 86_400_001)), run("invalid", "bad-date"),
      run("nan", NaN), run("infinite", Infinity), run("invalid-date", new Date(NaN)),
      run("invalid-start", "bad-date", new Date(now)), run("fallback", undefined, new Date(now)),
    ] }) } } }) },
    "next-auth": { getServerSession: async () => null },
    "next/server": {},
    "../../../../auth.ts": { githubOAuthConfigured: false },
    "../../../../github-app.ts": { getSelectedRepositoryContextForRequest: async () => ({ repository: input.repository, subject: "test-user" }) },
    "../../../../history.ts": {},
    "../../../../automations/stale-pr/run-reference.ts": {
      createStalePullRequestSubjectKey: (subject) => subject,
      createStalePullRequestRunReference: (runId) => runId,
    },
    "../../../../automations/stale-pr/workflow.ts": {},
  }, { process: { env: { NODE_ENV: "test" } } });
  const response = await GET({ nextUrl: new URL("https://example.invalid/?history=1") });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).runs.map(({ requestId }) => requestId), ["recent", "boundary", "fallback"]);
});

test("history opening cleanup clears its own ID and preserves a newer opening", async () => {
  const history = ["first", "second"].map((requestId) => ({
    requestId, runRef: requestId, repository: input.repository, threshold: 30, unit: "days",
    status: "completed", startedAt: input.startedAt, includeDrafts: false,
  }));
  const state = ["30", "days", false, false, {}, null, null, history, false, null, null];
  const timers = new Map();
  let stateIndex = 0;
  let nextTimer = 0;
  const jsx = (type, props) => ({ type, props });
  const { AutomationWorkspace } = loadModule("../src/app/ui/automation-workspace.tsx", {
    react: {
      useState: () => {
        const index = stateIndex++;
        return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
      },
      useRef: () => ({ current: null }), useEffect() {}, useCallback: (callback) => callback,
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
  }, {
    window: {
      setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
      clearTimeout(id) { timers.delete(id); },
    },
    fetch: async () => Response.json({ status: "completed", repository: input.repository, result: { candidates: [], steps: [] } }),
  });
  const tree = AutomationWorkspace({ repository: input.repository, connected: true, configured: true });
  const historySection = tree.props.children.find((child) => child?.props?.className === "automation-history");
  const rows = historySection.props.children.at(-1).props.children;
  rows[0].props.children.at(-1).props.onClick();
  assert.equal(state[10], "first");
  rows[1].props.children.at(-1).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state[10], "second");
  const poll = [...timers.values()].find(({ delay }) => delay === 1200);
  assert.ok(poll);
  poll.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state[10], null);
});
