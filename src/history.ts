import { execFileSync } from "node:child_process";

export type CommitEvidence = {
  hash: string;
  date: string;
  subject: string;
  files: string[];
};

export type RepositorySnapshot = {
  baseRef: string;
  headRef: string;
  headSha: string;
  changedFiles: string[];
  diff: string;
  history: CommitEvidence[];
};

function git(repositoryPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
}

export function collectRepositorySnapshot(
  repositoryPath: string,
  baseRef: string,
  headRef = "HEAD",
  historyLimit = 40,
): RepositorySnapshot {
  const changedFiles = git(repositoryPath, [
    "diff",
    "--name-only",
    "-z",
    `${baseRef}...${headRef}`,
  ])
    .split("\0")
    .filter(Boolean);

  const diff = git(repositoryPath, ["diff", "--no-ext-diff", `${baseRef}...${headRef}`, "--", ...changedFiles]);
  const rawHistory = changedFiles.length
    ? git(repositoryPath, [
        "log",
        `-${historyLimit}`,
        "--date=short",
        "--format=%x00%H%x00%ad%x00%s",
        "-z",
        "--name-only",
        "--",
        ...changedFiles,
      ])
    : "";

  const history: CommitEvidence[] = [];
  const fields = rawHistory.split("\0");
  let cursor = 0;

  while (cursor < fields.length - 1) {
    // An empty field starts each commit; the next three fields are metadata.
    cursor++;
    const hash = fields[cursor++];
    const date = fields[cursor++];
    const subject = fields[cursor++];
    const files: string[] = [];

    // Git inserts one newline before the first path. All other bytes belong
    // to the path, including any additional leading or trailing whitespace.
    if (fields[cursor]?.startsWith("\n")) {
      files.push(fields[cursor++].slice(1));
      while (cursor < fields.length - 1 && fields[cursor] !== "") {
        files.push(fields[cursor++]);
      }
    }
    history.push({ hash, date, subject, files });
  }

  return {
    baseRef,
    headRef,
    headSha: git(repositoryPath, ["rev-parse", headRef]).trim(),
    changedFiles,
    diff,
    history,
  };
}
