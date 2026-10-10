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
    [snapshot, [{ body: "x".repeat(65536) }]],
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
  const initialBytes = Buffer.byteLength(JSON.stringify({ ...input, reviewEvidence: reviews }));
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
