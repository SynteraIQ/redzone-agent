import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { collectOpenPullRequests } from "../src/github.ts";
import { identifyStalePullRequests } from "../src/automations/stale-pr/workflow.ts";

// Compile the Next.js modules so Node's test runner can exercise their handlers
// without starting a server or loading authentication providers.
function loadModule(path, mocks = {}, globals = {}) {
  const filename = new URL(path, import.meta.url);
  const require = createRequire(filename);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports = {};
  new Function("require", "exports", "fetch", "console", "process", "window", outputText)(
    (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id),
    exports, globals.fetch ?? globalThis.fetch, globals.console ?? console,
    { env: { NODE_ENV: "test", NEXTAUTH_SECRET: "synthetic-test-secret" }, cwd: process.cwd },
    globals.window ?? globalThis,
  );
  return exports;
}

function loadWorkspace(fetch, { unit = "days", result = null } = {}) {
  const state = ["30", unit, false, false, result, null];
  const timers = new Map();
  let nextTimer = 0;
  let stateIndex = 0;
  let cleanup;
  const jsx = (type, props) => ({ type, props });
  const { AutomationWorkspace } = loadModule("../src/app/ui/automation-workspace.tsx", {
    react: {
      useState: () => {
        const current = stateIndex++;
        return [state[current], (value) => { state[current] = value; }];
      },
      useRef: () => ({ current: null }),
      useEffect: (effect) => { cleanup = effect(); },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
  }, { fetch, window: {
    setTimeout(callback, delay) {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout(id) { timers.delete(id); },
  } });
  const tree = AutomationWorkspace({ repository: "test/repository", connected: true, configured: true });
  const form = tree.props.children.find((child) => child?.type === "form");
  return {
    state, tree, timers,
    submit: () => form.props.onSubmit({ preventDefault() {} }),
    unmount: () => cleanup(),
    fireTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a timer for ${delay}ms`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));
const startedRun = () => Response.json({ status: "running", runRef: "test-run" });

const githubApp = loadModule("../src/github-app.ts", {
  "next-auth/jwt": { getToken: async () => ({ sub: "test-user" }) },
});

function loadRoute(overrides = {}) {
  const failures = [];
  const route = loadModule("../src/app/api/automations/stale-pr/route.ts", {
    "next-auth": {},
    "next/server": {},
    "../../../../auth.ts": { githubOAuthConfigured: false },
    "../../../../github-app.ts": {
      ...githubApp,
      getSelectedRepositoryForRequest: async () => "test/repository",
      getInstallationTokenForRequest: async () => "local-test-token",
      ...overrides.access,
    },
    "../../../../history.ts": {
      getGitHubOriginRepository: () => "test/repository", ...overrides.history,
    },
    "../../../../github.ts": { collectOpenPullRequests: async () => [], ...overrides.github },
  }, { console: { info() {}, error: (_message, details) => failures.push(details) } });
  return { ...route, failures };
}

function request() {
  const value = new Request("https://example.invalid/api/automations/stale-pr", {
    method: "POST",
    body: JSON.stringify({ staleAfterDays: 30, includeDrafts: false }),
  });
  value.cookies = { get: (name) => name === githubApp.GITHUB_INSTALLATION_COOKIE
    ? { value: githubApp.createInstallationCookie(1, "test-user") } : undefined };
  return value;
}

test("scans multiple pages by creation time but evaluates staleness by update time", async (t) => {
  const calls = [];
  const record = (number) => ({
    number, title: `PR ${number}`, html_url: `https://example.invalid/pull/${number}`,
    created_at: "2020-01-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z",
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const page = parsed.searchParams.get("page");
    return Response.json(page === "1"
      ? Array.from({ length: 100 }, (_, index) => record(index + 1))
      : [{ ...record(101), updated_at: "2026-08-01T00:00:00Z" }]);
  });
  const records = await collectOpenPullRequests("test/repository", "local-test-token", "test-run");
  assert.equal(calls.length, 2);
  for (const [index, url] of calls.entries()) {
    assert.equal(url.searchParams.get("sort"), "created");
    assert.equal(url.searchParams.get("direction"), "asc");
    assert.equal(url.searchParams.get("page"), String(index + 1));
  }
  assert.equal(records.length, 101);
  const stale = identifyStalePullRequests(records, { staleAfterDays: 30, includeDrafts: false }, new Date("2026-10-13T00:00:00Z"));
  assert.deepEqual(stale.map(({ number }) => number), [101]);
});

test("stale PR route distinguishes selection errors and keeps unexpected failures private", async (t) => {
  const signedOutApp = loadModule("../src/github-app.ts", {
    "next-auth/jwt": { getToken: async () => null },
  });
  for (const [name, overrides, expectedStatus, expectedError] of [
    ["mismatch", { access: { getSelectedRepositoryForRequest: async () => "other/repository" } }, 400,
      "Selected repository other/repository does not match the current checkout origin test/repository."],
    ["no selection", { access: { getSelectedRepositoryForRequest: githubApp.getSelectedRepositoryForRequest } }, 400,
      "Choose a repository from the Repositories menu before analyzing."],
    ["no installation", { access: { getSelectedRepositoryForRequest: () =>
      githubApp.getSelectedRepositoryForRequest({ cookies: { get: () => undefined } }) } }, 400,
      "Connect the RedZone GitHub App before selecting a repository."],
    ["no session", { access: signedOutApp }, 400, "Sign in with GitHub before connecting a repository."],
    ["origin failure", { history: { getGitHubOriginRepository: () => null } }, 500],
    ["token failure", { access: { getInstallationTokenForRequest: async () => {
      throw new Error("Private installation details");
    } } }, 500],
    ["GitHub failure", { github: { collectOpenPullRequests: async () => {
      throw new Error("Private GitHub details");
    } } }, 500],
    ["non-Error failure", { github: { collectOpenPullRequests: async () => { throw "private details"; } } }, 500],
  ]) {
    await t.test(name, async () => {
      const route = loadRoute(overrides);
      const response = await route.POST(request());
      const payload = await response.json();
      assert.equal(response.status, expectedStatus);
      assert.equal(payload.error, expectedError ?? "Could not scan stale pull requests.");
      assert.ok(payload.requestId);
      assert.equal(route.failures.length, 1);
      assert.equal(route.failures[0].requestId, payload.requestId);
      if (name === "GitHub failure") {
        assert.equal(route.failures[0].error.message, "Private GitHub details");
        assert.equal(route.failures[0].stage, "fetch-open-pull-requests");
      }
    });
  }
  await t.test("success", async () => {
    const { POST } = loadRoute();
    const response = await POST(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const result = await response.json();
    assert.equal(result.repository, "test/repository");
    assert.deepEqual(result.candidates, []);
  });
});

test("automation form handles non-JSON responses and preserves JSON errors and results", async (t) => {
  const result = { repository: "test/repository", candidates: [], steps: [], scannedPullRequestCount: 0, requestId: undefined };
  for (const [name, response, expectedError, expectedResult] of [
    ["HTML error", new Response("<html>Bad gateway</html>", { status: 502 }), "Could not run this automation.", null],
    ["invalid JSON success", new Response("invalid JSON"), "Could not run this automation.", null],
    ["JSON error", Response.json({ error: "Choose a repository.", requestId: "test-run" }, { status: 400 }), "Choose a repository. (request test-run)", null],
    ["JSON error without message", Response.json({}, { status: 500 }), "Could not run this automation.", null],
    ["success", startedRun(), null, result],
  ]) {
    await t.test(name, async () => {
      const workspace = loadWorkspace(async (_url, options) => options.method === "POST" ? response
        : Response.json({ status: "completed", repository: result.repository, result }));
      const pending = workspace.submit();
      if (name === "success") {
        await flushAsync();
        workspace.fireTimer(1200);
      }
      await pending;
      assert.equal(workspace.state[3], false);
      assert.deepEqual(workspace.state[4], expectedResult);
      assert.equal(workspace.state[5], expectedError);
      assert.equal(workspace.timers.size, 0);
    });
  }
});

test("durable scans evaluate elapsed hours at execution time, including retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-13T00:00:00Z") });
  const { runStalePullRequestWorkflow } = loadModule("../src/automations/stale-pr/workflow.ts", {
    "../../github-app.ts": { createInstallationTokenForWorkflow: async () => "local-test-token" },
    "../../github.ts": { collectOpenPullRequests: async () => [{
      number: 1, draft: false, updatedAt: "2026-10-12T00:00:00Z",
    }] },
  }, { console: { info() {} } });
  const input = {
    repository: "test/repository", installationId: 1, requestId: "test-run",
    startedAt: "2026-10-12T23:00:00Z",
    config: { staleAfterHours: 25, includeDrafts: false },
  };
  assert.deepEqual((await runStalePullRequestWorkflow(input)).candidates, []);
  t.mock.timers.tick(3_600_000);
  const result = await runStalePullRequestWorkflow(input);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].hoursSinceUpdate, 25);
});

test("polling reports terminal workflow errors", async (t) => {
  for (const terminal of ["failed", "cancelled"]) {
    await t.test(terminal, async () => {
      const workspace = loadWorkspace(async (_url, options) => options.method === "POST" ? startedRun()
        : Response.json({ status: terminal, error: "Workflow stopped.", requestId: "test-request" }));
      const pending = workspace.submit();
      await flushAsync();
      workspace.fireTimer(1200);
      await pending;
      assert.equal(workspace.state[3], false);
      assert.equal(workspace.state[5], "Workflow stopped. (request test-request)");
      assert.equal(workspace.timers.size, 0);
    });
  }
});

test("polling deadline stops both poll waits and pending status fetches", async (t) => {
  for (const phase of ["waiting", "fetching"]) {
    await t.test(phase, async () => {
      let statusSignal;
      const workspace = loadWorkspace(async (_url, options) => {
        if (options.method === "POST") return startedRun();
        statusSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      });
      const pending = workspace.submit();
      await flushAsync();
      if (phase === "fetching") {
        workspace.fireTimer(1200);
        await flushAsync();
        assert.equal(statusSignal.aborted, false);
      }
      workspace.fireTimer(120000);
      await pending;
      assert.equal(workspace.state[3], false);
      assert.match(workspace.state[5], /workflow is still running/);
      assert.equal(workspace.state[4], null);
      assert.equal(workspace.timers.size, 0);
      if (statusSignal) assert.equal(statusSignal.aborted, true);
    });
  }
});

test("unmount aborts requests and poll timers without updating state", async (t) => {
  for (const phase of ["starting", "waiting", "fetching"]) {
    await t.test(phase, async () => {
      let requestSignal;
      const workspace = loadWorkspace(async (_url, options) => {
        requestSignal = options.signal;
        if (phase !== "starting" && options.method === "POST") return startedRun();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      });
      const pending = workspace.submit();
      await flushAsync();
      if (phase === "fetching") {
        workspace.fireTimer(1200);
        await flushAsync();
      }
      const beforeUnmount = [...workspace.state];
      workspace.unmount();
      await pending;
      assert.equal(requestSignal.aborted, true);
      assert.deepEqual(workspace.state, beforeUnmount);
      assert.equal(workspace.timers.size, 0);
    });
  }
});

test("starting another run aborts the old fetch and ignores its late response", async () => {
  let oldSignal;
  let resolveOldStatus;
  let starts = 0;
  const result = { candidates: [], steps: [], scannedPullRequestCount: 0 };
  const workspace = loadWorkspace(async (_url, options) => {
    if (options.method === "POST") {
      starts++;
      return startedRun();
    }
    if (starts === 1) {
      oldSignal = options.signal;
      return new Promise((resolve) => { resolveOldStatus = resolve; });
    }
    return Response.json({ status: "completed", repository: "test/repository", result });
  });
  const first = workspace.submit();
  await flushAsync();
  workspace.fireTimer(1200);
  await flushAsync();
  const second = workspace.submit();
  assert.equal(oldSignal.aborted, true);
  resolveOldStatus(Response.json({ status: "failed", error: "Obsolete error." }));
  await first;
  assert.equal(workspace.state[3], true);
  assert.equal(workspace.state[5], null);
  await flushAsync();
  workspace.fireTimer(1200);
  await second;
  assert.deepEqual(workspace.state[4], { ...result, repository: "test/repository", requestId: undefined });
  assert.equal(workspace.timers.size, 0);
});

test("hour thresholds render a 25-hour candidate in elapsed hours", () => {
  const result = {
    repository: "test/repository", steps: [], scannedPullRequestCount: 1,
    candidates: [{ number: 1, hoursSinceUpdate: 25, daysSinceUpdate: 1, updatedAt: "2026-10-12T00:00:00Z" }],
  };
  const { tree } = loadWorkspace(async () => {}, { unit: "hours", result });
  function findAge(node) {
    if (!node || typeof node !== "object") return null;
    if (node.props?.className === "stale-pr-age") return node;
    const children = Array.isArray(node) ? node : node.props?.children;
    return (Array.isArray(children) ? children : [children]).map(findAge).find(Boolean);
  }
  const age = findAge(tree);
  assert.equal(age.props.children[0].props.children, 25);
  assert.equal(age.props.children[1].props.children, "hours since update");
});
