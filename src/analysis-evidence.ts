import { z } from "zod";

export const EvidenceReferenceSchema = z.object({
  id: z.string().min(1).max(300),
  kind: z.enum(["change", "impact", "commit", "review"]),
  label: z.string().min(1).max(500),
  url: z.string().url().optional(),
});

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const GroundedAgentFindingSchema = z.object({
  summary: z.string().min(1).max(1200),
  evidenceIds: z.array(z.string().min(1).max(300)).max(12),
  limitations: z.array(z.string().min(1).max(240)).max(4),
});

export type GroundedAgentFinding = z.infer<typeof GroundedAgentFindingSchema>;
