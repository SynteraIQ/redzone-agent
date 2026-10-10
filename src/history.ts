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
  }).trim();
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
    `${baseRef}...${headRef}`,
  ])
    .split("\n")
    .filter(Boolean);

  const diff = git(repositoryPath, ["diff", "--no-ext-diff", `${baseRef}...${headRef}`, "--", ...changedFiles]);
  const rawHistory = changedFiles.length
    ? git(repositoryPath, [
        "log",
        `-${historyLimit}`,
        "--date=short",
        "--format=__REDZONE_COMMIT__%H%x09%ad%x09%s",
        "--name-only",
        "--",
        ...changedFiles,
      ])
    : "";

  const history: CommitEvidence[] = [];
  let current: CommitEvidence | undefined;

  for (const line of rawHistory.split("\n")) {
    if (line.startsWith("__REDZONE_COMMIT__")) {
      if (current) history.push(current);
      const [hash, date, ...subjectParts] = line
        .slice("__REDZONE_COMMIT__".length)
        .split("\t");
      current = {
        hash,
        date,
        subject: subjectParts.join("\t"),
        files: [],
      };
    } else if (current && line.trim()) {
      current.files.push(line.trim());
    }
  }
  if (current) history.push(current);

  return {
    baseRef,
    headRef,
    headSha: git(repositoryPath, ["rev-parse", headRef]),
    changedFiles,
    diff,
    history,
  };
}
