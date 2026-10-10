import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectRepositorySnapshot } from '../src/history.ts';

test('snapshot preserves unusual paths and explicitly frames multiple commits', (t) => {
  const repository = mkdtempSync(join(tmpdir(), 'redzone-history-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const paths = ['\nfirst\n', ' spaces ', 'tab\tname', 'quote"and\\slash', 'café', '__REDZONE_COMMIT__filename'];
  for (const path of paths) writeFileSync(join(repository, path), 'first\n');
  git('add', '--all');
  git('commit', '-qm', 'first\twith tabs');
  const first = git('rev-parse', 'HEAD');
  for (const path of paths) writeFileSync(join(repository, path), 'second\n');
  git('commit', '-qam', '__REDZONE_COMMIT__subject');
  const second = git('rev-parse', 'HEAD');

  const snapshot = collectRepositorySnapshot(repository, base);
  assert.deepEqual(new Set(snapshot.changedFiles), new Set(paths));
  assert.equal(snapshot.headSha, second);
  assert.deepEqual(snapshot.history.map(({ hash, subject }) => ({ hash, subject })), [
    { hash: second, subject: '__REDZONE_COMMIT__subject' },
    { hash: first, subject: 'first\twith tabs' },
  ]);
  for (const commit of snapshot.history) {
    assert.deepEqual(new Set(commit.files), new Set(paths));
    assert.match(commit.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.match(snapshot.diff, /\+second/);
  assert.equal(collectRepositorySnapshot(repository, base, 'HEAD', 1).history.length, 1);
  const unchanged = collectRepositorySnapshot(repository, 'HEAD');
  assert.deepEqual(unchanged.changedFiles, []);
  assert.deepEqual(unchanged.history, []);
});
