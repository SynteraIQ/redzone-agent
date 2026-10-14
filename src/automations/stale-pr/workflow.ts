import type { OpenPullRequest } from "../../github.ts";
import { collectOpenPullRequests } from "../../github.ts";
import { createInstallationTokenForWorkflow } from "../../github-app.ts";
import { createHook, getWritable } from "workflow";
import { createStalePullRequestApprovalToken } from "./approval-token.ts";

export type StalePullRequestApprovalDecision = {
  decision: "approved" | "rejected";
  actor: string;
  decidedAt: string;
  rationale?: string;
};

export type StalePullRequestApprovalWorkflowInput = {
  reportRunId: string;
  reportRequestId: string;
  repository: string;
  approvalRequestId: string;
  requestedBy: string;
  requestedAt: string;
};

export type StalePullRequestApprovalWorkflowResult = (StalePullRequestApprovalDecision & {
  reportRequestId: string;
  repository: string;
  requestedBy: string;
  requestedAt: string;
}) | { approvalRunId: string };

export async function waitForStalePullRequestApproval(
  input: StalePullRequestApprovalWorkflowInput,
): Promise<StalePullRequestApprovalWorkflowResult> {
  "use workflow";

  const hook = createHook<StalePullRequestApprovalDecision>({
    token: createStalePullRequestApprovalToken(input.approvalRequestId),
  });
  const conflict = await hook.getConflict();
  if (conflict) return { approvalRunId: conflict.runId };
  const decision = await hook;
  return {
    reportRequestId: input.reportRequestId,
    repository: input.repository,
    requestedBy: input.requestedBy,
    requestedAt: input.requestedAt,
    ...decision,
  };
}

export type StalePullRequestConfig = { includeDrafts: boolean } & (
  | { staleAfterHours: number; staleAfterDays?: never }
  | { staleAfterDays: number; staleAfterHours?: never }
);

export type StalePullRequestCandidate = OpenPullRequest & {
  hoursSinceUpdate: number;
  daysSinceUpdate: number;
};

export type StalePullRequestWorkflowResult = {
  trustRecord?: {
    actor: string;
    authentication: "GitHub OAuth" | "Local development mode";
    repository: string;
    requestedAt: string;
    inactivityThreshold: string;
    includeDrafts: boolean;
    permissions: string[];
    writesPerformed: false;
    decisionRule: string;
    coverage: string;
    limitations: string[];
  };
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
  actor: string;
  authentication: "GitHub OAuth" | "Local development mode";
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

  let scan: StalePullRequestScanResult;
  try {
    scan = await scanStalePullRequests(input);
  } catch (error) {
    await markProgressStepFailed("fetch-open-pull-requests", "The scan could not complete. Check the run error for details.");
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
    trustRecord: {
      actor: input.actor,
      authentication: input.authentication,
      repository: input.repository,
      requestedAt: input.startedAt,
      inactivityThreshold: threshold.label,
      includeDrafts: input.config.includeDrafts,
      permissions: ["Pull requests: read", "Issues: read", "Repository metadata: read"],
      writesPerformed: false,
      decisionRule: "A pull request qualifies when GitHub's updated_at timestamp is at least the selected threshold old.",
      coverage: `Evaluated ${scan.scannedPullRequestCount} open pull requests returned by GitHub for the selected repository.`,
      limitations: [
        "An old updated_at timestamp is an inactivity signal, not proof that a pull request is abandoned.",
        "Draft pull requests were " + (input.config.includeDrafts ? "included." : "excluded."),
        "GitHub pagination is capped at 10,000 open pull requests; scans above that limit stop with an error.",
      ],
    },
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
    await writer.write({
      stepId: activeStep,
      status: "failed",
      detail: "This step did not complete. Check the run error for details.",
    });
    throw error;
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
