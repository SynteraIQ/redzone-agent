import type { OpenPullRequest } from "../../github.ts";
import { collectOpenPullRequests } from "../../github.ts";
import { createInstallationTokenForWorkflow } from "../../github-app.ts";
import { getWritable } from "workflow";

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

export type StalePullRequestProgressEvent = {
  stepId: "fetch-open-pull-requests" | "apply-staleness-rule" | "prepare-report";
  status: "running" | "completed" | "failed";
  detail: string;
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

function failedScanStep(error: unknown): StalePullRequestProgressEvent["stepId"] {
  const seen = new Set<object>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("stepId" in error && (
      error.stepId === "fetch-open-pull-requests" || error.stepId === "apply-staleness-rule"
    )) return error.stepId;
    error = "cause" in error ? error.cause : undefined;
  }
  return "fetch-open-pull-requests";
}

export async function runStalePullRequestWorkflow(
  input: StalePullRequestWorkflowInput,
): Promise<StalePullRequestWorkflowResult> {
  "use workflow";

  let scan: StalePullRequestScanResult;
  try {
    scan = await scanStalePullRequests(input);
  } catch (error) {
    await markProgressStepFailed(failedScanStep(error), "The scan could not complete. Check the run error for details.");
    throw error;
  }
  const threshold = inactivityThreshold(input.config);
  try {
    await markReportPrepared();
  } catch (error) {
    await markProgressStepFailed("prepare-report", "The report could not be prepared. Check the run error for details.");
    throw error;
  }
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

  const writer = getWritable<StalePullRequestProgressEvent>().getWriter();
  let activeStep: StalePullRequestProgressEvent["stepId"] = "fetch-open-pull-requests";
  try {
    await writer.write({
      stepId: activeStep,
      status: "running",
      detail: "Fetching open pull requests from GitHub.",
    });
    const token = await createInstallationTokenForWorkflow(input.installationId, input.repository);
    const pullRequests = await collectOpenPullRequests(input.repository, token, input.requestId);
    await writer.write({
      stepId: activeStep,
      status: "completed",
      detail: `Fetched ${pullRequests.length} open pull requests from GitHub.`,
    });

    activeStep = "apply-staleness-rule";
    await writer.write({
      stepId: activeStep,
      status: "running",
      detail: "Applying the selected inactivity threshold.",
    });
    const candidates = identifyStalePullRequests(pullRequests, input.config, new Date(input.startedAt));
    await writer.write({
      stepId: activeStep,
      status: "completed",
      detail: `Found ${candidates.length} pull requests that meet the inactivity threshold.`,
    });
    console.info("[redzone:stale-pr] Durable scan step completed", {
      requestId: input.requestId,
      repository: input.repository,
      scannedPullRequestCount: pullRequests.length,
      candidateCount: candidates.length,
    });
    return { scannedPullRequestCount: pullRequests.length, candidates };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("The scan could not complete.", { cause: error });
    // Error causes survive step serialization and the runtime's retry-exhaustion wrapper.
    failure.cause = { stepId: activeStep, cause: failure.cause };
    throw failure;
  } finally {
    writer.releaseLock();
  }
}

async function markReportPrepared(): Promise<void> {
  "use step";

  const writer = getWritable<StalePullRequestProgressEvent>().getWriter();
  await writer.write({
    stepId: "prepare-report",
    status: "completed",
    detail: "Prepared an evidence-linked report. No GitHub changes were made.",
  });
  await writer.close();
  writer.releaseLock();
}

async function markProgressStepFailed(
  stepId: StalePullRequestProgressEvent["stepId"],
  detail: string,
): Promise<void> {
  "use step";

  const writer = getWritable<StalePullRequestProgressEvent>().getWriter();
  await writer.write({ stepId, status: "failed", detail });
  await writer.close();
  writer.releaseLock();
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
