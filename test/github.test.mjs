import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectReviewEvidence } from '../src/github.ts';

test('paginates PR files and both comment streams, retaining unfiltered conversations', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'redzone-gh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const oldEnvironment = { PATH: process.env.PATH, GH_REPO: process.env.GH_REPO, REDZONE_PR_LIMIT: process.env.REDZONE_PR_LIMIT };
  t.after(() => {
    for (const [key, value] of Object.entries(oldEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.PATH = `${directory}:${process.env.PATH}`;
  process.env.GH_REPO = 'test/repository';
  process.env.REDZONE_PR_LIMIT = '30';
  const endpoint = 'repos/test/repository';
  const comment = (id, path) => ({ id, path, body: `comment ${id}`, html_url: `https://example.invalid/${id}`, created_at: '2026-10-10' });
  const fixtures = {
    [`${endpoint}/pulls?state=all&sort=updated&direction=desc&per_page=30`]: [[
      { number: 1, title: 'Overlapping PR', html_url: 'https://example.invalid/pr/1', head: { sha: 'old-head' } },
      { number: 2, head: { sha: 'current-head' } },
      { number: 3, head: { sha: 'unrelated-head' } },
    ]],
    [`${endpoint}/pulls/1/files?per_page=100`]: [Array.from({ length: 100 }, (_, i) => ({ filename: `unrelated-${i}` })), [{ filename: 'changed.ts' }]],
    [`${endpoint}/pulls/1/comments?per_page=100`]: [Array.from({ length: 100 }, (_, i) => comment(i, 'unrelated.ts')), [comment(101, 'changed.ts')]],
    [`${endpoint}/issues/1/comments?per_page=100`]: [Array.from({ length: 100 }, (_, i) => comment(i, undefined)), [comment(102, 'unrelated.ts')]],
    [`${endpoint}/pulls/3/files?per_page=100`]: [[{ filename: 'unrelated.ts' }]],
  };
  const callsPath = join(directory, 'calls.jsonl');
  writeFileSync(join(directory, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
const pages = ${JSON.stringify(fixtures)}[args[1]];
if (!pages) throw new Error('Unexpected endpoint: ' + args[1]);
process.stdout.write(JSON.stringify(args.includes('--paginate') && args.includes('--slurp') ? pages : pages[0]));
`, { mode: 0o755 });

  const evidence = collectReviewEvidence({ changedFiles: ['changed.ts'], headSha: 'current-head' });
  assert.deepEqual(evidence.filter((entry) => entry.source === 'inline-review').map((entry) => entry.id), ['review-101']);
  assert.equal(evidence.filter((entry) => entry.source === 'pr-conversation').length, 101);
  assert.equal(evidence.at(-1).id, 'conversation-102');
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0].slice(2), []);
  for (const call of calls.slice(1)) assert.deepEqual(call.slice(2), ['--paginate', '--slurp']);
});
