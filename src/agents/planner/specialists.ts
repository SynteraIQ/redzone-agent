import type { AnalysisProgressEvent } from "../../analysis-progress.ts";
import type { SpecialistAgentId } from "../../analysis-plan.ts";
import type { RepositorySnapshot } from "../../history.ts";
import type { ReviewCoverage, ReviewEvidence } from "../../github.ts";
import { changeScopeAgent } from "../change-scope/index.ts";
import { rollbackHistoryAgent } from "../rollback-history/index.ts";
import { reviewContextAgent } from "../review-context/index.ts";
import type { SpecialistRun } from "./contracts.ts";
import type { AnalysisPlanningContext } from "./planning.ts";
import { runSpecialist } from "./evidence.ts";

export type SpecialistResults = {
  changeScope: SpecialistRun;
  rollbackHistory: SpecialistRun;
  reviewContext: SpecialistRun;
};

export async function runSpecialists(
  snapshot: RepositorySnapshot,
  context: AnalysisPlanningContext,
  selectedAgentIds: Set<SpecialistAgentId>,
  onProgress?: (event: AnalysisProgressEvent) => void | Promise<void>,
  reviewEvidence: ReviewEvidence[] = [],
  sourceCoverage?: ReviewCoverage,
): Promise<SpecialistResults> {
  const reportProgress = async (event: AnalysisProgressEvent) => await onProgress?.(event);
  await reportProgress({ stage: "change-scope", status: "running", label: "Change Scope Agent" });
  const changeScope = await runSpecialist(
    changeScopeAgent,
    context.candidatePrompt,
    context.candidateEvidence,
    ["change", "impact"],
  );
  await reportProgress({
    stage: "change-scope",
    status: changeScope.status,
    label: "Change Scope Agent",
    detail: changeScope.findings.slice(0, 320),
    evidence: changeScope.evidence,
    limitations: changeScope.limitations,
  });

  const scopeContext = changeScope.findings;
  const rollbackTask = (async (): Promise<SpecialistRun> => {
    if (!selectedAgentIds.has("rollback-history-agent")) {
      const reason = context.rollbackEvidence.length === 0
        ? "Not invoked: no overlapping historical commit subject explicitly signals a revert, rollback, feature flag, or kill switch."
        : "Not invoked: this check was left out of the approved plan.";
      const skipped: SpecialistRun = {
        status: "skipped",
        findings: reason,
        evidence: [],
        limitations: context.rollbackEvidence.length === 0
          ? ["History search is limited to overlapping commit subjects and paths."]
          : [],
      };
      await reportProgress({
        stage: "rollback-history",
        status: skipped.status,
        label: "Rollback History Agent",
        detail: skipped.findings,
        evidence: skipped.evidence,
        limitations: skipped.limitations,
      });
      return skipped;
    }

    await reportProgress({
      stage: "rollback-history",
      status: "running",
      label: "Rollback History Agent",
      detail: `Reviewing ${context.rollbackEvidence.length} rollback or mitigation signal commits.`,
    });
    const run = await runSpecialist(rollbackHistoryAgent, JSON.stringify({
      candidateFiles: snapshot.changedFiles,
      candidateScope: scopeContext,
      signalCommits: context.rollbackEvidence,
    }), [...context.candidateEvidence, ...context.rollbackEvidenceReferences], ["commit"]);
    await reportProgress({
      stage: "rollback-history",
      status: run.status,
      label: "Rollback History Agent",
      detail: run.findings.slice(0, 320),
      evidence: run.evidence,
      limitations: run.limitations,
    });
    return run;
  })();

  const reviewTask = (async (): Promise<SpecialistRun> => {
    if (!selectedAgentIds.has("review-context-agent")) {
      const skipped: SpecialistRun = {
        status: "skipped",
        findings: context.reviewEvidenceReferences.length === 0
          ? "Not invoked: no prior review records were available."
          : "Not invoked: this check was left out of the approved plan.",
        evidence: [],
        limitations: [],
      };
      await reportProgress({
        stage: "review-context",
        status: skipped.status,
        label: "Review Context Agent",
        detail: skipped.findings,
        evidence: skipped.evidence,
        limitations: skipped.limitations,
      });
      return skipped;
    }

    await reportProgress({
      stage: "review-context",
      status: "running",
      label: "Review Context Agent",
      detail: `Checking ${context.reviewEvidenceReferences.length} prior review records.`,
    });
    const run = await runSpecialist(reviewContextAgent, JSON.stringify({
      candidateFiles: snapshot.changedFiles,
      candidateScope: scopeContext,
      historicalReviews: reviewEvidence,
      ...(sourceCoverage ? { sourceCoverage } : {}),
    }), [...context.candidateEvidence, ...context.reviewEvidenceReferences], ["review"]);
    await reportProgress({
      stage: "review-context",
      status: run.status,
      label: "Review Context Agent",
      detail: run.findings.slice(0, 320),
      evidence: run.evidence,
      limitations: run.limitations,
    });
    return run;
  })();

  const [rollbackHistory, reviewContext] = await Promise.all([rollbackTask, reviewTask]);
  return { changeScope, rollbackHistory, reviewContext };
}
