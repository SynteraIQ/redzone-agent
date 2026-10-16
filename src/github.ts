import { execFileSync } from "node:child_process";
import type { CommitEvidence, RepositorySnapshot } from "./history.ts";

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
  pullRequestOutcome?: "open" | "merged" | "closed";
  overlappingFiles?: string[];
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

export type LearningReviewEvidence = ReviewEvidence & {
  pullRequestOutcome: "open" | "merged" | "closed";
};

export type LearningReviewScan = {
  repository: string;
  pullRequestLimit: number;
  pullRequestsFetched: number;
  mayHaveMorePullRequests: boolean;
  evidence: LearningReviewEvidence[];
};

export type PostedPullRequestSummary = {
  commentUrl: string;
};

type PullRequestRecord = {
  number: number;
  title: string;
  html_url: string;
  user?: { login?: string };
  created_at: string;
  updated_at?: string;
  draft?: boolean;
  labels?: Array<{ name?: string }>;
  head: { sha: string };
  state: "open" | "closed";
  merged_at: string | null;
};

export type OpenPullRequest = {
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  labels: string[];
};

export type RecentPullRequest = Pick<OpenPullRequest, "number" | "title" | "url" | "author" | "createdAt" | "updatedAt" | "draft" | "labels">;

type RemotePullRequest = {
  number: number;
  title: string;
  html_url: string;
  user?: { login?: string };
  created_at: string;
  updated_at?: string;
  draft?: boolean;
  labels?: Array<{ name?: string }>;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
};

type RemotePullRequestFile = { filename: string; status: string; patch?: string };
type RemoteCommit = {
  sha: string;
  commit: { message: string; author?: { date?: string } };
};
type RemoteFileContents = { content?: string; encoding?: string };

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

export type ExpertMapActivity = {
  reviewId: string;
  author: string;
  filePath: string;
  source: "submission" | "formal-review" | "inline-review";
  decision?: ReviewEvidence["decision"];
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  pullRequestOutcome: "open" | "merged" | "closed";
  reviewUrl: string;
  createdAt: string;
  hasWrittenFeedback: boolean;
};

export type ExpertMapScan = {
  repository: string;
  pullRequestLimit: number;
  pullRequestsFetched: number;
  pullRequestsWithReviewEvidence: number;
  mayHaveMorePullRequests: boolean;
  records: ExpertMapActivity[];
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

async function githubJson<T>(endpoint: string, token?: string): Promise<T> {
  if (!token) return ghJson<T>(endpoint);
  const response = await fetch(`https://api.github.com/${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub review request failed (HTTP ${response.status}).`);
  return await response.json() as T;
}

async function githubPaginated<T>(endpoint: string, token?: string): Promise<T[]> {
  if (!token) return ghPaginated<T>(endpoint);
  const results: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const items = await githubJson<T[]>(`${endpoint}${separator}page=${page}`, token);
    results.push(...items);
    if (items.length < 100) return results;
  }
  throw new Error("GitHub returned more than 10,000 review records for one request.");
}

function configuredRepository(selectedRepository?: string): string | undefined {
  let repository = selectedRepository?.trim();
  if (!repository) {
    try {
      const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const match = remote.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i);
      repository = match?.[1];
    } catch {
      return undefined;
    }
  }
  if (!repository) return undefined;
  repository = repository.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must use the owner/repository format.");
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
  selectedRepository: string,
): Promise<PostedPullRequestSummary> {
  const repository = configuredRepository(selectedRepository);
  if (!repository) throw new Error("Choose a repository before posting a summary.");

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
    throw new Error(`Enter a pull request URL for the selected repository ${repository}.`);
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

export async function collectReviewEvidence(
  snapshot: RepositorySnapshot,
  token?: string,
  selectedRepository?: string,
): Promise<ReviewCollection> {
  const repository = configuredRepository(selectedRepository);
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
  const pullRequests = await githubJson<PullRequestRecord[]>(
    `repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`,
    token,
  );
  const changedPathSet = new Set(snapshot.changedFiles);
  const evidence: ReviewEvidence[] = [];
  let overlappingPullRequests = 0;
  let automatedConversationCommentsSkipped = 0;

  for (const pullRequest of pullRequests) {
    if (pullRequest.head.sha === snapshot.headSha) continue;

    const files = await githubPaginated<PullRequestFile>(
      `repos/${repository}/pulls/${pullRequest.number}/files?per_page=100`,
      token,
    );
    const overlappingFiles = files
      .map((file) => file.filename)
      .filter((file) => changedPathSet.has(file));
    if (overlappingFiles.length === 0) continue;
    overlappingPullRequests++;
    const pullRequestOutcome = pullRequest.merged_at ? "merged" : pullRequest.state;

    const formalReviews = await githubPaginated<GitHubReview>(
      `repos/${repository}/pulls/${pullRequest.number}/reviews?per_page=100`,
      token,
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
        pullRequestOutcome,
        overlappingFiles,
      });
    }

    const inlineComments = await githubPaginated<GitHubComment>(
      `repos/${repository}/pulls/${pullRequest.number}/comments?per_page=100`,
      token,
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
        pullRequestOutcome,
        overlappingFiles,
      });
    }

    const conversationComments = await githubPaginated<GitHubComment>(
      `repos/${repository}/issues/${pullRequest.number}/comments?per_page=100`,
      token,
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
        pullRequestOutcome,
        overlappingFiles,
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

function expertMapPullRequestLimit(): number {
  const configuredLimit = Number(process.env.REDZONE_EXPERT_MAP_PR_LIMIT ?? "30");
  if (!Number.isInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 100) {
    throw new Error("REDZONE_EXPERT_MAP_PR_LIMIT must be an integer from 1 to 100.");
  }
  return configuredLimit;
}

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  mapItem: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapItem(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function collectExpertMap(
  repository: string,
  token: string,
): Promise<ExpertMapScan> {
  const normalizedRepository = configuredRepository(repository);
  if (!normalizedRepository) throw new Error("Choose a repository before building the expert map.");
  const limit = expertMapPullRequestLimit();
  const pullRequests = await githubJson<PullRequestRecord[]>(
    `repos/${normalizedRepository}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`,
    token,
  );
  const scans = await mapWithConcurrency(pullRequests, 4, async (pullRequest) => {
    const [files, reviews, inlineComments] = await Promise.all([
      githubPaginated<PullRequestFile>(`repos/${normalizedRepository}/pulls/${pullRequest.number}/files?per_page=100`, token),
      githubPaginated<GitHubReview>(`repos/${normalizedRepository}/pulls/${pullRequest.number}/reviews?per_page=100`, token),
      githubPaginated<GitHubComment>(`repos/${normalizedRepository}/pulls/${pullRequest.number}/comments?per_page=100`, token),
    ]);
    const paths = [...new Set(files.map((file) => file.filename))];
    const outcome: ExpertMapActivity["pullRequestOutcome"] = pullRequest.merged_at ? "merged" : pullRequest.state;
    const submissionRecords = pullRequest.user?.login
      ? paths.map((filePath) => ({
          reviewId: `submission-${pullRequest.number}`,
          author: pullRequest.user?.login ?? "unknown",
          filePath,
          source: "submission" as const,
          pullRequestNumber: pullRequest.number,
          pullRequestTitle: pullRequest.title,
          pullRequestUrl: pullRequest.html_url,
          pullRequestOutcome: outcome,
          reviewUrl: pullRequest.html_url,
          createdAt: pullRequest.created_at,
          hasWrittenFeedback: false,
        }))
      : [];
    const formalRecords = reviews
      .filter((review) => Boolean(review.state && review.submitted_at && review.user?.login))
      .flatMap((review) => paths.map((filePath) => ({
        reviewId: `formal-${review.id}`,
        author: review.user?.login ?? "unknown",
        filePath,
        source: "formal-review" as const,
        decision: review.state,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestUrl: pullRequest.html_url,
        pullRequestOutcome: outcome,
        reviewUrl: review.html_url,
        createdAt: review.submitted_at ?? "",
        hasWrittenFeedback: Boolean(review.body?.trim()),
      })));
    const inlineRecords = inlineComments
      .filter((comment) => Boolean(comment.body?.trim() && comment.path && comment.user?.login))
      .map((comment) => ({
        reviewId: `inline-${comment.id}`,
        author: comment.user?.login ?? "unknown",
        filePath: comment.path ?? "",
        source: "inline-review" as const,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestUrl: pullRequest.html_url,
        pullRequestOutcome: outcome,
        reviewUrl: comment.html_url,
        createdAt: comment.created_at,
        hasWrittenFeedback: true,
      }));
    return {
      records: [...submissionRecords, ...formalRecords, ...inlineRecords],
      hasReviewEvidence: formalRecords.length > 0 || inlineRecords.length > 0,
    };
  });
  return {
    repository: normalizedRepository,
    pullRequestLimit: limit,
    pullRequestsFetched: pullRequests.length,
    pullRequestsWithReviewEvidence: scans.filter((scan) => scan.hasReviewEvidence).length,
    mayHaveMorePullRequests: pullRequests.length >= limit,
    records: scans.flatMap((scan) => scan.records),
  };
}

export async function collectLearningReviewHistory(
  repository: string,
  token?: string,
): Promise<LearningReviewScan> {
  const normalizedRepository = configuredRepository(repository);
  if (!normalizedRepository) throw new Error("Choose a repository before learning from review history.");
  const limit = expertMapPullRequestLimit();
  const pullRequests = await githubJson<PullRequestRecord[]>(
    `repos/${normalizedRepository}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`,
    token,
  );
  const scans = await mapWithConcurrency(pullRequests, 4, async (pullRequest) => {
    const [reviews, inlineComments] = await Promise.all([
      githubPaginated<GitHubReview>(`repos/${normalizedRepository}/pulls/${pullRequest.number}/reviews?per_page=100`, token),
      githubPaginated<GitHubComment>(`repos/${normalizedRepository}/pulls/${pullRequest.number}/comments?per_page=100`, token),
    ]);
    const pullRequestOutcome: LearningReviewEvidence["pullRequestOutcome"] = pullRequest.merged_at
      ? "merged"
      : pullRequest.state;
    const formalEvidence: LearningReviewEvidence[] = reviews
      .filter((review) => Boolean(review.body?.trim() && review.submitted_at && review.user?.login && !review.user.login.endsWith("[bot]")))
      .map((review) => ({
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
        createdAt: review.submitted_at ?? "",
        pullRequestOutcome,
      }));
    const inlineEvidence: LearningReviewEvidence[] = inlineComments
      .filter((comment) => Boolean(comment.body?.trim() && comment.user?.login && !comment.user.login.endsWith("[bot]")))
      .map((comment) => ({
        id: `inline-${comment.id}`,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestUrl: pullRequest.html_url,
        source: "inline-review",
        author: comment.user?.login ?? "unknown",
        body: comment.body ?? "",
        path: comment.path,
        commitId: comment.commit_id,
        commentUrl: comment.html_url,
        createdAt: comment.created_at,
        pullRequestOutcome,
      }));
    return [...formalEvidence, ...inlineEvidence];
  });
  return {
    repository: normalizedRepository,
    pullRequestLimit: limit,
    pullRequestsFetched: pullRequests.length,
    mayHaveMorePullRequests: pullRequests.length >= limit,
    evidence: scans.flat(),
  };
}

export async function collectRemoteCodeowners(
  repository: string,
  token: string,
): Promise<{ file: string; contents: string } | null> {
  const normalizedRepository = configuredRepository(repository);
  if (!normalizedRepository) throw new Error("Choose a repository before loading CODEOWNERS.");
  const locations = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
  for (const location of locations) {
    try {
      const response = await githubJson<RemoteFileContents>(
        `repos/${normalizedRepository}/contents/${location}`,
        token,
      );
      if (response.encoding !== "base64" || !response.content) continue;
      return { file: location, contents: Buffer.from(response.content.replace(/\s/g, ""), "base64").toString("utf8") };
    } catch {
      // Try the next standard CODEOWNERS location; a repository may not define one.
    }
  }
  return null;
}

export async function collectOpenPullRequests(
  repository: string,
  token: string,
  requestId: string,
): Promise<OpenPullRequest[]> {
  const normalizedRepository = configuredRepository(repository);
  if (!normalizedRepository) throw new Error("Choose a repository before scanning pull requests.");
  const records: PullRequestRecord[] = [];
  const scanStartedAt = Date.now();
  for (let page = 1; page <= 100; page++) {
    const pageStartedAt = Date.now();
    let pageRecords: PullRequestRecord[];
    try {
      pageRecords = await githubJson<PullRequestRecord[]>(
        `repos/${normalizedRepository}/pulls?state=open&sort=created&direction=asc&per_page=100&page=${page}`,
        token,
      );
    } catch (error) {
      console.error("[redzone:stale-pr] GitHub pull request page failed", {
        requestId,
        repository: normalizedRepository,
        page,
        durationMs: Date.now() - pageStartedAt,
        error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown GitHub API error",
      });
      throw error;
    }
    records.push(...pageRecords);
    console.info("[redzone:stale-pr] GitHub pull request page fetched", {
      requestId,
      repository: normalizedRepository,
      page,
      count: pageRecords.length,
      durationMs: Date.now() - pageStartedAt,
    });
    if (pageRecords.length < 100) break;
    if (page === 100) throw new Error("The repository has more than 10,000 open pull requests; the stale scan stopped at the GitHub API pagination limit.");
  }
  const pullRequests = records.map((record) => ({
    number: record.number,
    title: record.title,
    url: record.html_url,
    author: record.user?.login ?? "unknown",
    createdAt: record.created_at,
    updatedAt: record.updated_at ?? record.created_at,
    draft: record.draft ?? false,
    labels: (record.labels ?? []).flatMap((label) => label.name ? [label.name] : []),
  }));
  console.info("[redzone:stale-pr] GitHub pull request scan completed", {
    requestId,
    repository: normalizedRepository,
    pullRequestCount: pullRequests.length,
    durationMs: Date.now() - scanStartedAt,
  });
  return pullRequests;
}

export async function listRecentPullRequests(
  repository: string,
  token: string,
  limit = 50,
): Promise<RecentPullRequest[]> {
  const normalizedRepository = configuredRepository(repository);
  if (!normalizedRepository) throw new Error("Choose a repository before loading pull requests.");
  const records = await githubJson<PullRequestRecord[]>(
    `repos/${normalizedRepository}/pulls?state=open&sort=updated&direction=desc&per_page=${Math.min(Math.max(limit, 1), 100)}`,
    token,
  );
  return records.map((record) => ({
    number: record.number,
    title: record.title,
    url: record.html_url,
    author: record.user?.login ?? "unknown",
    createdAt: record.created_at,
    updatedAt: record.updated_at ?? record.created_at,
    draft: record.draft ?? false,
    labels: (record.labels ?? []).flatMap((label) => label.name ? [label.name] : []),
  }));
}

export async function collectPullRequestSnapshot(
  repository: string,
  pullRequestNumber: number,
  token: string,
): Promise<RepositorySnapshot> {
  const normalizedRepository = configuredRepository(repository);
  if (!normalizedRepository) throw new Error("Choose a repository before analyzing a pull request.");
  const pullRequest = await githubJson<RemotePullRequest>(
    `repos/${normalizedRepository}/pulls/${pullRequestNumber}`,
    token,
  );
  if (pullRequest.number !== pullRequestNumber) throw new Error("GitHub returned a different pull request than requested.");

  const files = await githubPaginated<RemotePullRequestFile>(
    `repos/${normalizedRepository}/pulls/${pullRequestNumber}/files?per_page=100`,
    token,
  );
  const changedFiles = [...new Set(files.map((file) => file.filename))];
  const historyFiles = changedFiles.slice(0, 15);
  const historyResults = await Promise.all(historyFiles.map(async (filePath) => {
    const endpoint = `repos/${normalizedRepository}/commits?path=${encodeURIComponent(filePath)}&sha=${pullRequest.base.sha}&per_page=10`;
    try {
      const commits = await githubJson<RemoteCommit[]>(endpoint, token);
      return {
        successful: true,
        commits: commits.map((commit): CommitEvidence => ({
          hash: commit.sha,
          date: commit.commit.author?.date?.slice(0, 10) ?? "unknown date",
          subject: commit.commit.message.split("\n", 1)[0] ?? "(no commit message)",
          files: [filePath],
        })),
      };
    } catch (error) {
      console.warn("[redzone:analysis] Could not collect path history for PR snapshot", {
        repository: normalizedRepository,
        filePath,
        message: error instanceof Error ? error.message : "Unknown GitHub API error",
      });
      return { successful: false, commits: [] as CommitEvidence[] };
    }
  }));
  const uniqueHistory = new Map<string, CommitEvidence>();
  for (const commit of historyResults.flatMap((result) => result.commits)) {
    const existing = uniqueHistory.get(commit.hash);
    if (existing) existing.files = [...new Set([...existing.files, ...commit.files])];
    else uniqueHistory.set(commit.hash, commit);
  }
  const history = [...uniqueHistory.values()]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 100);
  const historyCoverage = {
    pathsSearched: historyResults.filter((result) => result.successful).length,
    pathsTotal: changedFiles.length,
    pathsFailed: historyResults.filter((result) => !result.successful).length,
    commitsPerPath: 10,
    mayHaveMore: changedFiles.length > historyFiles.length || historyResults.some((result) => result.commits.length >= 10) || historyResults.some((result) => !result.successful),
  };
  const maxDiffCharacters = 150_000;
  const patches = files.flatMap((file) => file.patch
    ? [`diff --git a/${file.filename} b/${file.filename}\n${file.patch}`]
    : []);
  const fullDiff = patches.join("\n");
  const limitations = files.some((file) => !file.patch)
    ? [`GitHub omitted patches for ${files.filter((file) => !file.patch).length} changed file(s), often because of file size or binary content.`]
    : [];
  if (fullDiff.length > maxDiffCharacters) limitations.push(`The pull request diff was truncated at ${maxDiffCharacters} characters.`);
  const diff = fullDiff.length > maxDiffCharacters
    ? `${fullDiff.slice(0, maxDiffCharacters)}\n\n[Diff truncated at ${maxDiffCharacters} characters.]`
    : fullDiff;

  return {
    source: "github-pull-request",
    pullRequestNumber,
    limitations,
    baseRef: pullRequest.base.ref,
    headRef: `refs/pull/${pullRequestNumber}/head`,
    headSha: pullRequest.head.sha,
    baseSha: pullRequest.base.sha,
    mergeBaseSha: pullRequest.base.sha,
    changedFiles,
    workingTreeFiles: [],
    diff,
    history,
    historyCoverage,
  };
}
