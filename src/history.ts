import { execFileSync } from "node:child_process";

export type CommitEvidence = {
  hash: string;
  date: string;
  subject: string;
  files: string[];
};

export type RepositorySnapshot = {
  source?: "local-checkout" | "github-pull-request";
  pullRequestNumber?: number;
  limitations?: string[];
  baseRef: string;
  headRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  changedFiles: string[];
  workingTreeFiles: string[];
  diff: string;
  history: CommitEvidence[];
  historyCoverage?: {
    pathsSearched: number;
    pathsTotal: number;
    pathsFailed: number;
    commitsPerPath: number;
    mayHaveMore: boolean;
  };
};

function git(repositoryPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
}

export function getGitHubOriginRepository(repositoryPath: string): string | undefined {
  try {
    const remote = git(repositoryPath, ["config", "--get", "remote.origin.url"]).trim();
    const match = remote.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i);
    return match?.[1]?.replace(/\.git$/i, "");
  } catch {
    return undefined;
  }
}

export function collectRepositorySnapshot(
  repositoryPath: string,
  baseRef: string,
  headRef = "HEAD",
  historyLimit = 40,
): RepositorySnapshot {
  const baseSha = git(repositoryPath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseRef}^{commit}`,
  ]).trim();
  const headSha = git(repositoryPath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${headRef}^{commit}`,
  ]).trim();
  const mergeBase = git(repositoryPath, ["merge-base", baseSha, headSha]).trim();
  const committedFiles = git(repositoryPath, [
    "diff",
    "--name-only",
    "-z",
    mergeBase,
    headSha,
  ])
    .split("\0")
    .filter(Boolean);
  const workingTreeFiles = git(repositoryPath, ["diff", "--name-only", "-z", headSha])
    .split("\0")
    .filter(Boolean);
  const changedFiles = [...new Set([...committedFiles, ...workingTreeFiles])];
  const diff = changedFiles.length
    ? git(repositoryPath, ["--literal-pathspecs", "diff", "--no-ext-diff", mergeBase, "--", ...changedFiles])
    : "";
  const rawHistory = changedFiles.length
    ? git(repositoryPath, [
        "--literal-pathspecs",
        "log",
        `-${historyLimit}`,
        "--date=short",
        "--format=%x00%H%x00%ad%x00%s",
        "-z",
        "--name-only",
        baseSha,
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
    source: "local-checkout",
    baseRef,
    headRef,
    headSha,
    baseSha,
    mergeBaseSha: mergeBase,
    changedFiles,
    workingTreeFiles,
    diff,
    history,
  };
}
