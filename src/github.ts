import { execFileSync } from "node:child_process";
import type { RepositorySnapshot } from "./history.ts";

export type ReviewEvidence = {
  id: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  source: "inline-review" | "pr-conversation";
  author: string;
  body: string;
  path?: string;
  commitId?: string;
  commentUrl: string;
  createdAt: string;
};

type PullRequestRecord = {
  number: number;
  title: string;
  html_url: string;
  head: { sha: string };
};

type PullRequestFile = { filename: string };
type GitHubComment = {
  id: number;
  user?: { login?: string };
  body?: string;
  path?: string;
  commit_id?: string;
  html_url: string;
  created_at: string;
};

function ghJson<T>(endpoint: string, args: string[] = []): T {
  const output = execFileSync("gh", ["api", endpoint, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output) as T;
}

function ghPaginated<T>(endpoint: string): T[] {
  return ghJson<T[][]>(endpoint, ["--paginate", "--slurp"]).flat();
}

function configuredRepository(): string | undefined {
  const repository = process.env.GH_REPO?.trim();
  if (!repository) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GH_REPO must use the owner/repository format.");
  }
  return repository;
}

function pullRequestLimit(): number {
  const configuredLimit = Number(process.env.REDZONE_PR_LIMIT ?? "30");
  if (!Number.isInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 100) {
    throw new Error("REDZONE_PR_LIMIT must be an integer from 1 to 100.");
  }
  return configuredLimit;
}

export function collectReviewEvidence(snapshot: RepositorySnapshot): ReviewEvidence[] {
  const repository = configuredRepository();
  if (!repository || snapshot.changedFiles.length === 0) return [];

  const limit = pullRequestLimit();
  const pullRequests = ghJson<PullRequestRecord[]>(
    `repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`,
  );
  const changedPathSet = new Set(snapshot.changedFiles);
  const evidence: ReviewEvidence[] = [];

  for (const pullRequest of pullRequests) {
    if (pullRequest.head.sha === snapshot.headSha) continue;

    const files = ghPaginated<PullRequestFile>(
      `repos/${repository}/pulls/${pullRequest.number}/files?per_page=100`,
    );
    const overlappingFiles = files
      .map((file) => file.filename)
      .filter((file) => changedPathSet.has(file));
    if (overlappingFiles.length === 0) continue;

    const inlineComments = ghPaginated<GitHubComment>(
      `repos/${repository}/pulls/${pullRequest.number}/comments?per_page=100`,
    );
    for (const comment of inlineComments) {
      if (!comment.body || !comment.path || !changedPathSet.has(comment.path)) continue;
      evidence.push({
        id: `review-${comment.id}`,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestUrl: pullRequest.html_url,
        source: "inline-review",
        author: comment.user?.login ?? "unknown",
        body: comment.body,
        path: comment.path,
        commitId: comment.commit_id,
        commentUrl: comment.html_url,
        createdAt: comment.created_at,
      });
    }

    const conversationComments = ghPaginated<GitHubComment>(
      `repos/${repository}/issues/${pullRequest.number}/comments?per_page=100`,
    );
    for (const comment of conversationComments) {
      if (!comment.body) continue;
      evidence.push({
        id: `conversation-${comment.id}`,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestUrl: pullRequest.html_url,
        source: "pr-conversation",
        author: comment.user?.login ?? "unknown",
        body: comment.body,
        commentUrl: comment.html_url,
        createdAt: comment.created_at,
      });
    }
  }

  return evidence;
}
