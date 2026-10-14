import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const { outputText } = ts.transpileModule(
  readFileSync(new URL("../src/connections/slack.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
);

function loadSlack(result) {
  const tokenCalls = [];
  const evictions = [];
  const errors = [];
  const exports = {};
  new Function("require", "exports", "process", "fetch", "console", outputText)(
    (id) => {
      assert.equal(id, "@vercel/connect");
      return {
        ConnectError: class extends Error {},
        getToken: async (...args) => { tokenCalls.push(args); return "synthetic-token"; },
        deleteTokenCacheEntry: (...args) => { evictions.push(args); },
      };
    },
    exports,
    { env: { VERCEL_CONNECT_SLACK_CONNECTOR: "test-slack" } },
    async () => Response.json(result),
    { error: (...args) => { errors.push(args); } },
  );
  return { ...exports, tokenCalls, evictions, errors };
}

test("evicts a Slack-rejected credential using the original token parameters before returning", async () => {
  const slack = loadSlack({ ok: false, error: "invalid_auth" });
  const status = await slack.verifySlackConnection();

  assert.equal(status.state, "failed");
  assert.equal(slack.evictions.length, 1);
  assert.deepEqual(slack.tokenCalls[0], ["slack/test-slack", { subject: { type: "app" }, scopes: [] }]);
  assert.equal(slack.evictions[0][0], slack.tokenCalls[0][0]);
  assert.equal(slack.evictions[0][1], slack.tokenCalls[0][1]);
  assert.equal(slack.errors[0][1].error, "invalid_auth");
});

test("keeps cached credentials and existing failure handling for incomplete Slack responses", async (t) => {
  const complete = { ok: true, team: "Test workspace", team_id: "T_TEST", user: "test-user" };
  for (const field of ["ok", "team", "team_id", "user"]) {
    await t.test(`missing ${field}`, async () => {
      const result = { ...complete };
      delete result[field];
      const slack = loadSlack(result);
      const status = await slack.verifySlackConnection();

      assert.equal(status.state, "failed");
      assert.equal(status.message, "Slack rejected this connection. Check its authorization in Vercel Connect.");
      assert.deepEqual(slack.evictions, []);
      assert.equal(slack.errors[0][1].error, "incomplete-auth-response");
    });
  }
});

test("keeps a verified Slack credential cached", async () => {
  const slack = loadSlack({ ok: true, team: "Test workspace", team_id: "T_TEST", user: "test-user" });
  assert.deepEqual(await slack.verifySlackConnection(), {
    state: "connected", workspace: "Test workspace", workspaceId: "T_TEST", actor: "test-user",
  });
  assert.deepEqual(slack.evictions, []);
  assert.deepEqual(slack.errors, []);
});
