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
  new Function("require", "exports", "fetch", "console", "process", outputText)(
    (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id),
    exports, globals.fetch ?? globalThis.fetch, globals.console ?? console,
    { env: { NODE_ENV: "test", NEXTAUTH_SECRET: "synthetic-test-secret" }, cwd: process.cwd },
  );
  return exports;
}

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
  const result = { repository: "test/repository", candidates: [], steps: [], scannedPullRequestCount: 0 };
  for (const [name, response, expectedError, expectedResult] of [
    ["HTML error", new Response("<html>Bad gateway</html>", { status: 502 }), "Could not run this automation.", null],
    ["invalid JSON success", new Response("invalid JSON"), "Could not run this automation.", null],
    ["JSON error", Response.json({ error: "Choose a repository.", requestId: "test-run" }, { status: 400 }), "Choose a repository. (request test-run)", null],
    ["JSON error without message", Response.json({}, { status: 500 }), "Could not run this automation.", null],
    ["success", Response.json(result), null, result],
  ]) {
    await t.test(name, async () => {
      const state = ["30", false, false, null, null];
      let index = 0;
      const jsx = (type, props) => ({ type, props });
      const { AutomationWorkspace } = loadModule("../src/app/ui/automation-workspace.tsx", {
        react: { useState: () => {
          const current = index++;
          return [state[current], (value) => { state[current] = value; }];
        } },
        "react/jsx-runtime": { jsx, jsxs: jsx },
      }, { fetch: async () => response });
      const tree = AutomationWorkspace({ repository: "test/repository", connected: true, configured: true });
      const form = tree.props.children.find((child) => child?.type === "form");
      await form.props.onSubmit({ preventDefault() {} });
      assert.equal(state[2], false);
      assert.deepEqual(state[3], expectedResult);
      assert.equal(state[4], expectedError);
    });
  }
});
