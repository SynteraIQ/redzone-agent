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
        "--name-only",
        "-z",
        "--",
        ...changedFiles,
      ])
    : "";

  const history: CommitEvidence[] = [];
  const fields = rawHistory.split("\0");
  let index = 0;
  while (index < fields.length - 1) {
    // Each commit starts with an empty NUL field, followed by three header fields.
    index++;
    const hash = fields[index++];
    const date = fields[index++];
    const subject = fields[index++];
    const files: string[] = [];
    while (index < fields.length && fields[index] !== "") {
      const file = fields[index++];
      // Git inserts one newline before the first path; all other bytes are path data.
      files.push(files.length === 0 ? file.slice(1) : file);
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
