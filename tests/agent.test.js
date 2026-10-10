import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSnapshot, redZoneAgent } from "../src/agent.ts";

const snapshot = { baseRef: "main", headRef: "HEAD", changedFiles: [], diff: "", history: [] };
const object = {
  summary: "summary", riskLevel: "low", rationale: "rationale",
  commitEvidenceHashes: ["known", "invented"], reviewEvidenceIds: ["review-1", "invented"], followUpQuestions: [],
};

test("rejects oversized serialized evidence before generation", async (t) => {
  const generate = t.mock.method(redZoneAgent, "generate", async () => ({ object }));
  for (const [input, reviews] of [
    [{ ...snapshot, diff: "x".repeat(65536) }, []],
    [{ ...snapshot, history: [{ subject: "x".repeat(65536) }] }, []],
    [snapshot, [{ body: "", pullRequestTitle: "x".repeat(65536) }]],
    [{ ...snapshot, diff: "é".repeat(32768) }, []],
    [{ ...snapshot, diff: "\0".repeat(12000) }, []],
    [{ ...snapshot, changedFiles: ["x".repeat(65536)] }, []],
  ]) {
    await assert.rejects(analyzeSnapshot(input, reviews), /Analysis input is too large .*maximum 65536.*Reduce/);
  }
  assert.equal(generate.mock.callCount(), 0);
});

test("accepts the byte limit and preserves structured output and evidence filtering", async (t) => {
  const input = { ...snapshot, history: [{ hash: "known", date: "2026-10-10", subject: "change", files: [] }] };
  const reviews = [{ id: "review-1", body: "evidence" }];
  const initialBytes = Buffer.byteLength(JSON.stringify({
    candidateChange: {
      baseRef: input.baseRef, headRef: input.headRef, changedFiles: input.changedFiles, diff: input.diff,
    },
    historicalEvidence: { commits: input.history, reviewEvidence: reviews },
  }));
  input.diff = "x".repeat(65536 - initialBytes);
  const generate = t.mock.method(redZoneAgent, "generate", async (prompt, options) => {
    assert.equal(Buffer.byteLength(prompt), 65536);
    assert.deepEqual(JSON.parse(prompt), {
      candidateChange: {
        baseRef: input.baseRef,
        headRef: input.headRef,
        changedFiles: input.changedFiles,
        diff: input.diff,
      },
      historicalEvidence: { commits: input.history, reviewEvidence: reviews },
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
  for (const body of ["x".repeat(65536), "é".repeat(32768), "😀".repeat(16384), "\0".repeat(12000)]) {
    const reviews = [...formalReviews, {
      ...provenance, id: "review-1", source: "inline-review", path: "target", body,
    }];
    const original = structuredClone(reviews);
    const generate = t.mock.method(redZoneAgent, "generate", async (prompt) => {
      assert.ok(Buffer.byteLength(prompt, "utf8") <= 65536);
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
