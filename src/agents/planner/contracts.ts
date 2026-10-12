import { z } from "zod";
import type { EvidenceReference } from "../../analysis-evidence.ts";
import type { SpecialistAgentId } from "../../analysis-plan.ts";
import type { TypeScriptImpact } from "../../tools/impact-graph.ts";

export const AnalysisSchema = z.object({
  summary: z.string(),
  riskLevel: z.enum(["high", "medium", "low", "insufficient-evidence"]),
  rationale: z.string(),
  commitEvidenceHashes: z.array(z.string()),
  reviewEvidenceIds: z.array(z.string()),
  followUpQuestions: z.array(z.string()),
});

export const SpecialistIdSchema = z.enum([
  "change-scope-agent",
  "rollback-history-agent",
  "review-context-agent",
]);

export const AnalysisPlanSchema = z.object({
  agentIds: z.array(SpecialistIdSchema).max(3),
  rationale: z.string(),
});

export const PlannerChatRouteSchema = z.object({
  targetAgentId: z.enum([
    "red-zone-agent",
    "change-scope-agent",
    "rollback-history-agent",
    "review-context-agent",
  ]),
  rationale: z.string(),
});

export type PlannerChatRoute = z.infer<typeof PlannerChatRouteSchema>;

export type AgentTraceEntry = {
  name: string;
  focus: string;
  status: "completed" | "failed" | "skipped";
  findings: string;
  evidence: EvidenceReference[];
  limitations: string[];
};

export type SpecialistRun = {
  status: "completed" | "failed" | "skipped";
  findings: string;
  evidence: EvidenceReference[];
  limitations: string[];
};

export type RedZoneAnalysis = z.infer<typeof AnalysisSchema> & {
  agentTrace?: AgentTraceEntry[];
  synthesisEvidence: EvidenceReference[];
  impactGraph: TypeScriptImpact;
};

export type AnalysisPlanDecision = {
  availableAgentIds: SpecialistAgentId[];
  selectedAgentIds: SpecialistAgentId[];
  rationale: string;
  impactGraph: TypeScriptImpact;
  rollbackEvidenceCount: number;
  reviewEvidenceCount: number;
};
