import { z } from "zod";

export const EvidenceReferenceSchema = z.object({
  id: z.string().min(1).max(300),
  kind: z.enum(["change", "impact", "commit", "review"]),
  label: z.string().min(1).max(500),
  url: z.string().url().optional(),
  provenance: z.object({
    source: z.enum(["git-diff", "git-history", "github-review", "static-analysis"]),
    revision: z.string().min(1).optional(),
    baseRef: z.string().min(1).optional(),
    baseRevision: z.string().min(1).optional(),
    date: z.string().min(1).optional(),
    paths: z.array(z.string().min(1)).max(100).optional(),
    includesWorkingTree: z.boolean().optional(),
  }),
});

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const GroundedAgentFindingSchema = z.object({
  summary: z.string().min(1).max(1200),
  evidenceIds: z.array(z.string().min(1).max(300)),
  limitations: z.array(z.string().min(1).max(240)).max(4),
});

export type GroundedAgentFinding = z.infer<typeof GroundedAgentFindingSchema>;
