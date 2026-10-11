import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSnapshot, redZoneAgent } from "../src/agent.ts";
import { changeScopeAgent } from "../src/agents/change-scope-agent.ts";
import { rollbackHistoryAgent } from "../src/agents/rollback-history-agent.ts";
import { reviewContextAgent } from "../src/agents/review-context-agent.ts";

const maxPromptBytes = 256 * 1024;
const snapshot = { baseRef: "main", headRef: "HEAD", changedFiles: [], diff: "", history: [] };
const object = {
  summary: "summary", riskLevel: "low", rationale: "rationale",
  commitEvidenceHashes: ["known", "invented"], reviewEvidenceIds: ["review-1", "invented"], followUpQuestions: [],
};

function mockSpecialists(t) {
  return [changeScopeAgent, rollbackHistoryAgent, reviewContextAgent].map((agent) =>
    t.mock.method(agent, "generate", async () => ({ text: "specialist findings" })),
  );
}

test("rejects oversized serialized candidates before any specialist or planner calls", async (t) => {
  const specialists = mockSpecialists(t);
  const generate = t.mock.method(redZoneAgent, "generate", async () => ({ object }));
  const candidateBytes = Buffer.byteLength(JSON.stringify({ candidateChange: {
    baseRef: snapshot.baseRef, headRef: snapshot.headRef, changedFiles: snapshot.changedFiles, diff: snapshot.diff,
  } }));
  for (const candidate of [
    { diff: "x".repeat(maxPromptBytes - candidateBytes + 1) },
    { diff: "é".repeat(maxPromptBytes / 2) },
    { diff: "\0".repeat(Math.ceil(maxPromptBytes / 6)) },
    { changedFiles: ["x".repeat(maxPromptBytes)] },
    { baseRef: "x".repeat(maxPromptBytes) },
    { headRef: "x".repeat(maxPromptBytes) },
  ]) {
    const input = { ...snapshot, ...candidate, history: [{ subject: "Revert earlier change" }] };
    await assert.rejects(analyzeSnapshot(input, []), /Analysis input is too large .*maximum 262144/);
  }
  for (const specialist of specialists) assert.equal(specialist.mock.callCount(), 0);
  assert.equal(generate.mock.callCount(), 0);
});

test("rejects oversized final evidence before planner generation", async (t) => {
  mockSpecialists(t);
  const generate = t.mock.method(redZoneAgent, "generate", async () => ({ object }));
  for (const [input, reviews] of [
    [{ ...snapshot, history: [{ subject: "x".repeat(maxPromptBytes) }] }, []],
    [snapshot, [{ body: "", pullRequestTitle: "x".repeat(maxPromptBytes) }]],
  ]) {
    await assert.rejects(analyzeSnapshot(input, reviews), /Analysis input is too large .*maximum 262144/);
  }
  assert.equal(generate.mock.callCount(), 0);
});

test("accepts the candidate byte limit but keeps the final guard for specialist findings", async (t) => {
  const specialists = mockSpecialists(t);
  const generate = t.mock.method(redZoneAgent, "generate", async () => ({ object }));
  const input = { ...snapshot, history: [{ subject: "Revert earlier change" }] };
  const candidateChange = {
    baseRef: input.baseRef, headRef: input.headRef, changedFiles: input.changedFiles, diff: input.diff,
  };
  input.diff = "x".repeat(maxPromptBytes - Buffer.byteLength(JSON.stringify({ candidateChange })));
  await assert.rejects(analyzeSnapshot(input, []), /Analysis input is too large .*maximum 262144/);
  for (const specialist of specialists) assert.equal(specialist.mock.callCount(), 1);
  assert.equal(Buffer.byteLength(specialists[0].mock.calls[0].arguments[0]), maxPromptBytes);
  assert.equal(generate.mock.callCount(), 0);
});

test("accepts the byte limit and preserves structured output and evidence filtering", async (t) => {
  mockSpecialists(t);
  const input = { ...snapshot, history: [{ hash: "known", date: "2026-10-10", subject: "Revert change", files: [] }] };
  const reviews = [{ id: "review-1", body: "evidence" }];
  const specialistFindings = {
    changeScope: "specialist findings", rollbackHistory: "specialist findings", reviewContext: "specialist findings",
  };
  const initialBytes = Buffer.byteLength(JSON.stringify({
    candidateChange: {
      baseRef: input.baseRef, headRef: input.headRef, changedFiles: input.changedFiles, diff: input.diff,
    },
    historicalEvidence: { commits: input.history, reviewEvidence: reviews },
    specialistFindings,
  }));
  input.diff = "x".repeat(maxPromptBytes - initialBytes);
  const generate = t.mock.method(redZoneAgent, "generate", async (prompt, options) => {
    assert.equal(Buffer.byteLength(prompt), maxPromptBytes);
    assert.deepEqual(JSON.parse(prompt), {
      candidateChange: {
        baseRef: input.baseRef,
        headRef: input.headRef,
        changedFiles: input.changedFiles,
        diff: input.diff,
      },
      historicalEvidence: { commits: input.history, reviewEvidence: reviews },
      specialistFindings,
    });
    assert.deepEqual(options.structuredOutput.schema.parse(object), object);
    return { object };
  });
  const analysis = await analyzeSnapshot(input, reviews);
  assert.deepEqual(analysis.commitEvidenceHashes, ["known"]);
  assert.deepEqual(analysis.reviewEvidenceIds, ["review-1"]);
  assert.equal(analysis.riskLevel, "low");
  input.diff += "x";
  await assert.rejects(analyzeSnapshot(input, reviews), /Analysis input is too large/);
  assert.equal(generate.mock.callCount(), 1);
});

test("compacts review bodies while preserving empty formal decisions and provenance", async (t) => {
  mockSpecialists(t);
  const input = {
    ...snapshot, changedFiles: ["target"], diff: "+candidate change",
    history: [{ hash: "known", date: "2026-10-10", subject: "Earlier change", files: ["target"] }],
  };
  const formalReviews = ["APPROVED", "COMMENTED"].map((decision, index) => ({
    id: `formal-${index + 1}`,
    source: "formal-review",
    decision,
    body: "",
    pullRequestNumber: 42,
    pullRequestTitle: "Earlier change",
    pullRequestUrl: "https://example.invalid/pr/42",
    author: "reviewer",
    commitId: "prior-commit",
    commentUrl: `https://example.invalid/review/${index + 1}`,
    createdAt: "2026-10-10",
  }));
  const coverage = { repository: "test/repository", evidenceCounts: { formalReviews: 2 } };
  const reviewIds = [...formalReviews.map(({ id }) => id), "review-1"];
  const { decision, ...provenance } = formalReviews[0];
  for (const body of ["x".repeat(maxPromptBytes), "é".repeat(maxPromptBytes / 2), "😀".repeat(maxPromptBytes / 4), "\0".repeat(Math.ceil(maxPromptBytes / 6))]) {
    const reviews = [...formalReviews, {
      ...provenance, id: "review-1", source: "inline-review", path: "target", body,
    }];
    const original = structuredClone(reviews);
    const generate = t.mock.method(redZoneAgent, "generate", async (prompt) => {
      assert.ok(Buffer.byteLength(prompt, "utf8") <= maxPromptBytes);
      const { candidateChange, historicalEvidence } = JSON.parse(prompt);
      assert.deepEqual(candidateChange, {
        baseRef: input.baseRef, headRef: input.headRef, changedFiles: input.changedFiles, diff: input.diff,
      });
      assert.deepEqual(historicalEvidence.commits, input.history);
      assert.deepEqual(historicalEvidence.sourceCoverage, coverage);
      assert.equal(historicalEvidence.reviewBodiesCompacted, true);
      assert.deepEqual(historicalEvidence.reviewEvidence.slice(0, 2), formalReviews);
      const compacted = historicalEvidence.reviewEvidence[2];
      assert.ok(compacted.body.length > 0 && compacted.body.length < body.length);
      assert.ok(body.startsWith(compacted.body));
      assert.ok(compacted.body.isWellFormed());
      assert.deepEqual({ ...compacted, body }, reviews[2]);
      return { object: { ...object, reviewEvidenceIds: [...reviewIds, "invented"] } };
    });
    const analysis = await analyzeSnapshot(input, reviews, coverage);
    assert.deepEqual(analysis.reviewEvidenceIds, reviewIds);
    assert.deepEqual(reviews, original);
    assert.equal(generate.mock.callCount(), 1);
    generate.mock.restore();
  }
});
