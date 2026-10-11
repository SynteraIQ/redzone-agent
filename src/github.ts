import { execFileSync } from "node:child_process";
import type { RepositorySnapshot } from "./history.ts";

export type ReviewEvidence = {
  id: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  source: "formal-review" | "inline-review" | "pr-conversation";
  author: string;
  body: string;
  decision?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  path?: string;
  commitId?: string;
  commentUrl: string;
  createdAt: string;
};

export type ReviewCoverage = {
  githubConfigured: boolean;
  repository: string | null;
  pullRequestLimit: number | null;
  pullRequestsFetched: number;
  overlappingPullRequests: number;
  mayHaveMorePullRequests: boolean;
  evidenceCounts: {
    formalReviews: number;
    inlineComments: number;
    conversationComments: number;
    automatedConversationCommentsSkipped: number;
  };
};

export type ReviewCollection = {
  evidence: ReviewEvidence[];
  coverage: ReviewCoverage;
};

export type PostedPullRequestSummary = {
  commentUrl: string;
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

type GitHubReview = {
  id: number;
  user?: { login?: string };
  body?: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  commit_id?: string;
  html_url: string;
  submitted_at?: string;
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

export async function postPullRequestSummary(
  pullRequestUrl: string,
  summary: string,
): Promise<PostedPullRequestSummary> {
  const repository = configuredRepository();
  if (!repository) {
    throw new Error("Set GH_REPO to the owner/repository allowed to receive comments.");
  }

  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (!token) {
    throw new Error("Set GITHUB_TOKEN or GH_TOKEN with permission to comment on pull requests.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(pullRequestUrl);
  } catch {
    throw new Error("Enter a valid GitHub pull request URL.");
  }
  const match = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (
    parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "github.com" ||
    parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash ||
    !match || `${match[1]}/${match[2]}` !== repository
  ) {
    throw new Error(`Enter a pull request URL for the configured repository ${repository}.`);
  }

  const cleanSummary = summary.trim().replace(
    /^\*\*Repository:\*\* `[^`]*`/m,
    `**Repository:** \`${repository}\``,
  );
  if (!cleanSummary || cleanSummary.length > 30_000) {
    throw new Error("The analysis summary must contain between 1 and 30,000 characters.");
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/issues/${match[3]}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: `<!-- redzone-agent-summary -->\n${cleanSummary}` }),
      redirect: "error",
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub could not post the summary (HTTP ${response.status}).`);
  }

  const result = await response.json() as { html_url?: string };
  if (!result.html_url) {
    throw new Error("GitHub accepted the comment but did not return its URL.");
  }
  return { commentUrl: result.html_url };
}

export function collectReviewEvidence(snapshot: RepositorySnapshot): ReviewCollection {
  const repository = configuredRepository();
  if (!repository || snapshot.changedFiles.length === 0) {
    return {
      evidence: [],
      coverage: {
        githubConfigured: Boolean(repository),
        repository: repository ?? null,
        pullRequestLimit: null,
        pullRequestsFetched: 0,
        overlappingPullRequests: 0,
        mayHaveMorePullRequests: false,
        evidenceCounts: {
          formalReviews: 0,
          inlineComments: 0,
          conversationComments: 0,
          automatedConversationCommentsSkipped: 0,
        },
      },
    };
  }

  const limit = pullRequestLimit();
  const pullRequests = ghJson<PullRequestRecord[]>(
    `repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`,
  );
  const changedPathSet = new Set(snapshot.changedFiles);
  const evidence: ReviewEvidence[] = [];
  let overlappingPullRequests = 0;
  let automatedConversationCommentsSkipped = 0;

  for (const pullRequest of pullRequests) {
    if (pullRequest.head.sha === snapshot.headSha) continue;

    const files = ghPaginated<PullRequestFile>(
      `repos/${repository}/pulls/${pullRequest.number}/files?per_page=100`,
    );
    const overlappingFiles = files
      .map((file) => file.filename)
      .filter((file) => changedPathSet.has(file));
    if (overlappingFiles.length === 0) continue;
    overlappingPullRequests++;

    const formalReviews = ghPaginated<GitHubReview>(
      `repos/${repository}/pulls/${pullRequest.number}/reviews?per_page=100`,
    );
    for (const review of formalReviews) {
      if (!review.state || !review.submitted_at) continue;
      evidence.push({
        id: `formal-${review.id}`,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestUrl: pullRequest.html_url,
        source: "formal-review",
        author: review.user?.login ?? "unknown",
        body: review.body ?? "",
        decision: review.state,
        commitId: review.commit_id,
        commentUrl: review.html_url,
        createdAt: review.submitted_at,
      });
    }

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
      const author = comment.user?.login ?? "unknown";
      if (author.endsWith("[bot]")) {
        automatedConversationCommentsSkipped++;
        continue;
      }
      evidence.push({
        id: `conversation-${comment.id}`,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestUrl: pullRequest.html_url,
        source: "pr-conversation",
        author,
        body: comment.body,
        commentUrl: comment.html_url,
        createdAt: comment.created_at,
      });
    }
  }

  return {
    evidence,
    coverage: {
      githubConfigured: true,
      repository,
      pullRequestLimit: limit,
      pullRequestsFetched: pullRequests.length,
      overlappingPullRequests,
      mayHaveMorePullRequests: pullRequests.length >= limit,
      evidenceCounts: {
        formalReviews: evidence.filter((item) => item.source === "formal-review").length,
        inlineComments: evidence.filter((item) => item.source === "inline-review").length,
        conversationComments: evidence.filter((item) => item.source === "pr-conversation").length,
        automatedConversationCommentsSkipped,
      },
    },
  };
}
