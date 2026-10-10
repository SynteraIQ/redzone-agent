import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSnapshot, redZoneAgent } from '../src/agent.ts';

const snapshot = { baseRef: 'main', headRef: 'HEAD', headSha: 'head', changedFiles: ['file.ts'], diff: 'small diff', history: [] };
const analysis = { summary: 'Summary', riskLevel: 'low', rationale: 'Rationale', commitEvidenceHashes: [], reviewEvidenceIds: [], followUpQuestions: [] };

test('rejects oversized serialized evidence before calling the provider', async (t) => {
  const generate = t.mock.method(redZoneAgent, 'generate', async () => { throw new Error('Provider must not be called'); });
  for (const [input, evidence] of [
    [{ ...snapshot, diff: 'x'.repeat(65537) }, []],
    [{ ...snapshot, history: [{ hash: 'hash', subject: 'x'.repeat(65537), date: '', files: [] }] }, []],
    [snapshot, [{ body: 'x'.repeat(65537) }]],
    [{ ...snapshot, diff: 'é'.repeat(40000) }, []],
    [{ ...snapshot, diff: '\0'.repeat(12000) }, []],
    [{ ...snapshot, changedFiles: ['x'.repeat(65537)] }, []],
  ]) {
    await assert.rejects(analyzeSnapshot(input, evidence), /input is \d+ bytes, exceeding the 65536-byte limit/);
  }
  assert.equal(generate.mock.callCount(), 0);
});

test('accepts the size boundary and preserves structured output and evidence filtering', async (t) => {
  const input = { ...snapshot, diff: '', history: [{ hash: 'known', date: '2026-10-10', subject: 'subject', files: ['file.ts'] }] };
  const evidence = [{ id: 'review-known', body: 'Review' }];
  const serialized = { baseRef: input.baseRef, headRef: input.headRef, changedFiles: input.changedFiles, diff: '', history: input.history, reviewEvidence: evidence };
  input.diff = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(serialized)));
  const generate = t.mock.method(redZoneAgent, 'generate', async (prompt, options) => {
    assert.equal(Buffer.byteLength(prompt), 65536);
    assert.deepEqual(JSON.parse(prompt), { ...serialized, diff: input.diff });
    assert.deepEqual(options.structuredOutput.schema.parse(analysis), analysis);
    return { object: { ...analysis, commitEvidenceHashes: ['known', 'invented'], reviewEvidenceIds: ['review-known', 'invented'] } };
  });
  const result = await analyzeSnapshot(input, evidence);
  assert.deepEqual(result.commitEvidenceHashes, ['known']);
  assert.deepEqual(result.reviewEvidenceIds, ['review-known']);
  assert.equal(result.riskLevel, 'low');
  await assert.rejects(analyzeSnapshot({ ...input, diff: input.diff + 'x' }, evidence), /exceeding/);
  assert.equal(generate.mock.callCount(), 1);
});
