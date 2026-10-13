import type { OpenPullRequest } from "../../github.ts";

export type StalePullRequestConfig = {
  staleAfterDays: number;
  includeDrafts: boolean;
};

export type StalePullRequestCandidate = OpenPullRequest & {
  daysSinceUpdate: number;
};

export type StalePullRequestWorkflowResult = {
  steps: Array<{
    id: "fetch-open-pull-requests" | "apply-staleness-rule" | "prepare-report";
    status: "completed";
    detail: string;
  }>;
  scannedPullRequestCount: number;
  candidates: StalePullRequestCandidate[];
};

export function identifyStalePullRequests(
  pullRequests: OpenPullRequest[],
  config: StalePullRequestConfig,
  now = new Date(),
): StalePullRequestCandidate[] {
  return pullRequests.flatMap((pullRequest) => {
    if (!config.includeDrafts && pullRequest.draft) return [];
    const updatedAt = Date.parse(pullRequest.updatedAt);
    if (!Number.isFinite(updatedAt)) return [];
    const daysSinceUpdate = Math.max(0, Math.floor((now.getTime() - updatedAt) / 86_400_000));
    return daysSinceUpdate >= config.staleAfterDays ? [{ ...pullRequest, daysSinceUpdate }] : [];
  }).sort((left, right) => right.daysSinceUpdate - left.daysSinceUpdate);
}

export function buildStalePullRequestWorkflowResult(
  pullRequests: OpenPullRequest[],
  config: StalePullRequestConfig,
  now = new Date(),
): StalePullRequestWorkflowResult {
  const candidates = identifyStalePullRequests(pullRequests, config, now);
  return {
    steps: [
      {
        id: "fetch-open-pull-requests",
        status: "completed",
        detail: `Fetched ${pullRequests.length} open pull requests from GitHub.`,
      },
      {
        id: "apply-staleness-rule",
        status: "completed",
        detail: `Found ${candidates.length} pull requests with no update for at least ${config.staleAfterDays} days.`,
      },
      {
        id: "prepare-report",
        status: "completed",
        detail: "Prepared an evidence-linked report. No GitHub changes were made.",
      },
    ],
    scannedPullRequestCount: pullRequests.length,
    candidates,
  };
}
