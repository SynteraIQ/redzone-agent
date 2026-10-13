import { createHash } from "node:crypto";
import { z } from "zod";
import type { TypeScriptImpact } from "./tools/impact-graph.ts";
import type { RepositorySnapshot } from "./history.ts";

export const SpecialistAgentIdSchema = z.enum([
  "change-scope-agent",
  "rollback-history-agent",
  "review-context-agent",
]);

export type SpecialistAgentId = z.infer<typeof SpecialistAgentIdSchema>;

export const AnalysisPlanRunRequestSchema = z.object({
  baseRef: z.string().trim().min(1).max(100),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  approvedAgentIds: z.array(SpecialistAgentIdSchema).min(1).max(3)
    .refine((agentIds) => new Set(agentIds).size === agentIds.length),
});

export const AnalysisRunRequestSchema = z.union([
  AnalysisPlanRunRequestSchema,
  z.object({ baseRef: z.string().trim().min(1).max(100) }),
]);

export type AnalysisPlanPreview = {
  hasChanges: boolean;
  snapshotFingerprint: string;
  baseRef: string;
  headSha: string;
  changedFiles: string[];
  availableAgentIds: SpecialistAgentId[];
  selectedAgentIds: SpecialistAgentId[];
  rationale: string;
  rollbackEvidenceCount: number;
  reviewEvidenceCount: number;
  impact: {
    status: TypeScriptImpact["status"];
    note: string;
    directDependents: number;
    transitiveDependents: number;
  };
};

export function createSnapshotFingerprint(snapshot: RepositorySnapshot): string {
  return createHash("sha256").update(JSON.stringify({
    baseRef: snapshot.baseRef,
    baseSha: snapshot.baseSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    headSha: snapshot.headSha,
    changedFiles: snapshot.changedFiles,
    workingTreeFiles: snapshot.workingTreeFiles,
    diff: snapshot.diff,
    history: snapshot.history,
  })).digest("hex");
}

export function isValidBaseRef(baseRef: string): boolean {
  return baseRef.length > 0 && baseRef.length <= 100 && !baseRef.startsWith("-") &&
    /^[A-Za-z0-9_./~^-]+$/.test(baseRef);
}
