import type { OpenPullRequest } from "../../github.ts";
import { collectOpenPullRequests } from "../../github.ts";
import { createInstallationTokenForWorkflow } from "../../github-app.ts";

export type StalePullRequestConfig = { includeDrafts: boolean } & (
  | { staleAfterHours: number; staleAfterDays?: never }
  | { staleAfterDays: number; staleAfterHours?: never }
);

export type StalePullRequestCandidate = OpenPullRequest & {
  hoursSinceUpdate: number;
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

function inactivityThreshold(config: StalePullRequestConfig): { hours: number; label: string } {
  if (config.staleAfterHours !== undefined) {
    return { hours: config.staleAfterHours, label: `${config.staleAfterHours} ${config.staleAfterHours === 1 ? "hour" : "hours"}` };
  }
  return {
    hours: config.staleAfterDays * 24,
    label: `${config.staleAfterDays} ${config.staleAfterDays === 1 ? "day" : "days"}`,
  };
}

type StalePullRequestScanResult = {
  scannedPullRequestCount: number;
  candidates: StalePullRequestCandidate[];
};

export async function runStalePullRequestWorkflow(
  input: StalePullRequestWorkflowInput,
): Promise<StalePullRequestWorkflowResult> {
  "use workflow";

  const scan = await scanStalePullRequests(input);
  const threshold = inactivityThreshold(input.config);
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
        detail: `Found ${scan.candidates.length} pull requests with no update for at least ${threshold.label}.`,
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
  const candidates = identifyStalePullRequests(pullRequests, input.config);
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
  const thresholdHours = inactivityThreshold(config).hours;
  return pullRequests.flatMap((pullRequest) => {
    if (!config.includeDrafts && pullRequest.draft) return [];
    const updatedAt = Date.parse(pullRequest.updatedAt);
    if (!Number.isFinite(updatedAt)) return [];
    const hoursSinceUpdate = Math.max(0, Math.floor((now.getTime() - updatedAt) / 3_600_000));
    const daysSinceUpdate = Math.floor(hoursSinceUpdate / 24);
    return hoursSinceUpdate >= thresholdHours ? [{ ...pullRequest, hoursSinceUpdate, daysSinceUpdate }] : [];
  }).sort((left, right) => right.hoursSinceUpdate - left.hoursSinceUpdate);
}

export function buildStalePullRequestWorkflowResult(
  pullRequests: OpenPullRequest[],
  config: StalePullRequestConfig,
  now = new Date(),
): StalePullRequestWorkflowResult {
  const candidates = identifyStalePullRequests(pullRequests, config, now);
  const threshold = inactivityThreshold(config);
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
        detail: `Found ${candidates.length} pull requests with no update for at least ${threshold.label}.`,
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
