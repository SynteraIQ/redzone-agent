import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectRepositorySnapshot } from "../src/history.ts";

test("treats changed filenames as literal diff and history pathspecs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "redzone-literal-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const paths = ["star*.txt", "bracket[1].txt", ":(glob)*.txt"];
  const unrelatedPaths = ["star-other.txt", "bracket1.txt", "ordinary.txt"];
  for (const path of [...paths, ...unrelatedPaths]) writeFileSync(join(directory, path), "initial\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "initial files");
  const initialHash = git("rev-parse", "HEAD").trim();
  for (const path of unrelatedPaths) writeFileSync(join(directory, path), "unrelated change\n");
  git("commit", "--quiet", "-am", "unrelated history");
  const base = git("rev-parse", "HEAD").trim();
  for (const path of paths) writeFileSync(join(directory, path), "candidate change\n");
  git("commit", "--quiet", "-am", "candidate");

  const snapshot = collectRepositorySnapshot(directory, base);
  assert.deepEqual([...snapshot.changedFiles].sort(), [...paths].sort());
  for (const path of paths) assert.ok(snapshot.diff.includes(`diff --git a/${path} b/${path}`));
  for (const path of unrelatedPaths) assert.ok(!snapshot.diff.includes(path));
  assert.deepEqual(snapshot.history.map((commit) => commit.hash), [initialHash]);
  assert.deepEqual([...snapshot.history[0].files].sort(), [...paths].sort());
});

test("preserves path bytes and separates commit metadata from filenames", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "redzone-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  const paths = [
    " ordinary ", "tab\tname", "line\nbreak", "\n\nleading", "trailing\n",
    'quote"and\\slash', "café", "__REDZONE_COMMIT__pretend", "a".repeat(40),
  ];
  const commits = [];
  for (const subject of ["first\tcommit", "__REDZONE_COMMIT__second"]) {
    for (const path of paths) writeFileSync(join(directory, path), `${subject}\n`);
    git("add", "--all");
    git("commit", "--quiet", "-m", subject);
    commits.unshift({ hash: git("rev-parse", "HEAD").trim(), subject });
  }
  const snapshot = collectRepositorySnapshot(directory, base);
  assert.deepEqual([...snapshot.changedFiles].sort(), [...paths].sort());
  assert.equal(snapshot.headSha, commits[0].hash);
  assert.equal(snapshot.history.length, 2);
  for (const [index, commit] of snapshot.history.entries()) {
    assert.equal(commit.hash, commits[index].hash);
    assert.equal(commit.subject, commits[index].subject);
    assert.match(commit.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual([...commit.files].sort(), [...paths].sort());
  }
  const unchanged = collectRepositorySnapshot(directory, "HEAD");
  assert.deepEqual(unchanged.changedFiles, []);
  assert.deepEqual(unchanged.history, []);
});
