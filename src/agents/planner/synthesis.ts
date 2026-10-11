import type { AnalysisProgressEvent } from "../../analysis-progress.ts";
import type { EvidenceReference } from "../../analysis-evidence.ts";
import type { ReviewCoverage, ReviewEvidence } from "../../github.ts";
import type { RepositorySnapshot } from "../../history.ts";
import { AnalysisSchema, type RedZoneAnalysis, type SpecialistRun } from "./contracts.ts";
import type { AnalysisPlanningContext } from "./planning.ts";
import { specialistAgents } from "./planning.ts";
import { redZoneAgent } from "./planner-agent.ts";

type SynthesisInput = {
  context: AnalysisPlanningContext;
  snapshot: RepositorySnapshot;
  reviewEvidence: ReviewEvidence[];
  sourceCoverage?: ReviewCoverage;
  specialists: {
    changeScope: SpecialistRun;
    rollbackHistory: SpecialistRun;
    reviewContext: SpecialistRun;
  };
  onProgress?: (event: AnalysisProgressEvent) => void | Promise<void>;
};

function serializeSpecialist(run: SpecialistRun) {
  return {
    status: run.status,
    finding: run.findings,
    evidenceIds: run.evidence.map((reference) => reference.id),
    limitations: run.limitations,
  };
}

export async function synthesizeAnalysis(input: SynthesisInput): Promise<RedZoneAnalysis> {
  const { context, snapshot, reviewEvidence, sourceCoverage, specialists } = input;
  const reportProgress = async (event: AnalysisProgressEvent) => await input.onProgress?.(event);
  const specialistFindings = {
    changeScope: serializeSpecialist(specialists.changeScope),
    rollbackHistory: serializeSpecialist(specialists.rollbackHistory),
    reviewContext: serializeSpecialist(specialists.reviewContext),
  };
  const serializePrompt = (evidence: ReviewEvidence[], compacted = false) => JSON.stringify({
    candidateChange: context.candidateChange,
    impactGraph: context.impactEvidence,
    evidenceReferences: context.allEvidenceReferences,
    historicalEvidence: {
      commits: snapshot.history,
      reviewEvidence: evidence,
      ...(compacted ? { reviewBodiesCompacted: true } : {}),
      ...(sourceCoverage ? { sourceCoverage } : {}),
    },
    specialistFindings,
  });
  let prompt = serializePrompt(reviewEvidence);
  if (Buffer.byteLength(prompt, "utf8") > context.maxPromptBytes) {
    const compactPrompt = (bodyLength: number) => serializePrompt(
      reviewEvidence.map((review) => ({
        ...review,
        body: review.body.slice(0, bodyLength).replace(/[\uD800-\uDBFF]$/, ""),
      })),
      true,
    );
    prompt = compactPrompt(0);
    if (Buffer.byteLength(prompt, "utf8") <= context.maxPromptBytes) {
      let lower = 1;
      let upper = reviewEvidence.reduce((longest, review) => Math.max(longest, review.body.length), 0);
      while (lower <= upper) {
        const length = Math.floor((lower + upper) / 2);
        const candidate = compactPrompt(length);
        if (Buffer.byteLength(candidate, "utf8") <= context.maxPromptBytes) {
          prompt = candidate;
          lower = length + 1;
        } else {
          upper = length - 1;
        }
      }
    }
  }
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > context.maxPromptBytes) {
    throw new Error(
      `Analysis input is too large (${promptBytes} bytes; maximum ${context.maxPromptBytes}). ` +
      "Use a smaller change or reduce the available historical review evidence before retrying.",
    );
  }

  await reportProgress({ stage: "synthesis", status: "running", label: "Red Zone Planner synthesis" });
  const result = await redZoneAgent.generate(prompt, {
    structuredOutput: { schema: AnalysisSchema },
  });
  if (!result.object) {
    throw new Error("Red Zone Agent returned no structured analysis.");
  }
  await reportProgress({
    stage: "synthesis",
    status: "completed",
    label: "Red Zone Planner synthesis",
    detail: `Final assessment: ${result.object.riskLevel}.`,
  });

  const knownHashes = new Set(snapshot.history.map((commit) => commit.hash));
  const commitEvidenceHashes = result.object.commitEvidenceHashes.filter((hash) => knownHashes.has(hash));
  const knownReviewIds = new Set(reviewEvidence.map((item) => item.id));
  const reviewEvidenceIds = result.object.reviewEvidenceIds.filter((id) => knownReviewIds.has(id));
  const synthesisEvidenceIds = new Set([
    ...commitEvidenceHashes.map((hash) => `commit:${hash}`),
    ...reviewEvidenceIds.map((id) => `review:${id}`),
  ]);
  const evidenceById = new Map(context.allEvidenceReferences.map((reference) => [reference.id, reference]));
  const synthesisEvidence = [...synthesisEvidenceIds]
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((reference): reference is EvidenceReference => reference !== undefined);
  const hasHistoricalEvidence = commitEvidenceHashes.length > 0 || reviewEvidenceIds.length > 0;

  return {
    ...result.object,
    impactGraph: context.impactGraph,
    synthesisEvidence,
    riskLevel: hasHistoricalEvidence ? result.object.riskLevel : "insufficient-evidence",
    rationale: hasHistoricalEvidence
      ? result.object.rationale
      : "No supplied commit or review evidence supports a risk claim.",
    commitEvidenceHashes,
    reviewEvidenceIds,
    agentTrace: specialistAgents.map(({ id, name, focus }) => {
      const run = id === "change-scope-agent" ? specialists.changeScope
        : id === "rollback-history-agent" ? specialists.rollbackHistory
          : specialists.reviewContext;
      return {
        name,
        focus,
        status: run.status,
        findings: run.findings,
        evidence: run.evidence,
        limitations: run.limitations,
      };
    }),
  };
}
