import type { AnalysisProgressEvent } from "../../analysis-progress.ts";
import type { SpecialistAgentId } from "../../analysis-plan.ts";
import type { ReviewCoverage, ReviewEvidence } from "../../github.ts";
import type { RepositorySnapshot } from "../../history.ts";
import { type RedZoneAnalysis } from "./contracts.ts";
import {
  prepareAnalysisContext,
  selectAnalysisAgents,
  specialistAgents,
  validateApprovedAgentPlan,
} from "./planning.ts";
import { runSpecialists } from "./specialists.ts";
import { synthesizeAnalysis } from "./synthesis.ts";
import type { AppliedMemory } from "../../memory-store.ts";

export async function analyzeSnapshot(
  snapshot: RepositorySnapshot,
  reviewEvidence: ReviewEvidence[],
  sourceCoverage?: ReviewCoverage,
  repositoryPath = process.cwd(),
  onProgress?: (event: AnalysisProgressEvent) => void | Promise<void>,
  approvedAgentIds?: SpecialistAgentId[],
  githubRepository?: string,
  activeMemories: AppliedMemory[] = [],
): Promise<RedZoneAnalysis> {
  const reportProgress = async (event: AnalysisProgressEvent) => await onProgress?.(event);
  const context = await prepareAnalysisContext(snapshot, reviewEvidence, repositoryPath, reportProgress, githubRepository, activeMemories);
  await reportProgress({
    stage: "planning",
    status: "running",
    label: approvedAgentIds ? "Validating approved specialist plan" : "Planner selecting specialist checks",
  });
  const selection = approvedAgentIds
    ? validateApprovedAgentPlan(approvedAgentIds, context.availableAgentIds)
    : await selectAnalysisAgents(
        context,
        `There are ${context.rollbackEvidence.length} explicit rollback/mitigation history signals and ${reviewEvidence.length} prior review records. Source coverage: ${JSON.stringify(sourceCoverage ?? null)}.`,
      );
  const selectedAgentIds = new Set(selection.selectedAgentIds);
  const selectedAgentNames = specialistAgents
    .filter((agent) => selectedAgentIds.has(agent.id))
    .map((agent) => agent.name);
  await reportProgress({
    stage: "planning",
    status: "completed",
    label: approvedAgentIds ? "Executing approved specialist plan" : "Planner selected specialist checks",
    detail: `${selectedAgentNames.join(", ")}. ${selection.rationale}`.slice(0, 320),
  });

  const specialists = await runSpecialists(
    snapshot,
    context,
    selectedAgentIds,
    onProgress,
    reviewEvidence,
    sourceCoverage,
  );
  return synthesizeAnalysis({
    context,
    snapshot,
    reviewEvidence,
    sourceCoverage,
    specialists,
    onProgress,
  });
}
