import type { OpenPullRequest } from "../../github.ts";
import { collectOpenPullRequests } from "../../github.ts";
import { createInstallationTokenForWorkflow } from "../../github-app.ts";

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

export type StalePullRequestWorkflowInput = {
  repository: string;
  installationId: number;
  config: StalePullRequestConfig;
  startedAt: string;
  requestId: string;
};

type StalePullRequestScanResult = {
  scannedPullRequestCount: number;
  candidates: StalePullRequestCandidate[];
};

export async function runStalePullRequestWorkflow(
  input: StalePullRequestWorkflowInput,
): Promise<StalePullRequestWorkflowResult> {
  "use workflow";

  const scan = await scanStalePullRequests(input);
  return {
    steps: [
      {
        id: "fetch-open-pull-requests",
        status: "completed",
        detail: `Fetched ${scan.scannedPullRequestCount} open pull requests from GitHub.`,
      },
      {
        id: "apply-staleness-rule",
        status: "completed",
        detail: `Found ${scan.candidates.length} pull requests with no update for at least ${input.config.staleAfterDays} days.`,
      },
      {
        id: "prepare-report",
        status: "completed",
        detail: "Prepared an evidence-linked report. No GitHub changes were made.",
      },
    ],
    ...scan,
  };
}

async function scanStalePullRequests(
  input: StalePullRequestWorkflowInput,
): Promise<StalePullRequestScanResult> {
  "use step";

  const token = await createInstallationTokenForWorkflow(input.installationId, input.repository);
  const pullRequests = await collectOpenPullRequests(input.repository, token, input.requestId);
  const candidates = identifyStalePullRequests(pullRequests, input.config, new Date(input.startedAt));
  console.info("[redzone:stale-pr] Durable scan step completed", {
    requestId: input.requestId,
    repository: input.repository,
    scannedPullRequestCount: pullRequests.length,
    candidateCount: candidates.length,
  });
  return { scannedPullRequestCount: pullRequests.length, candidates };
}

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
