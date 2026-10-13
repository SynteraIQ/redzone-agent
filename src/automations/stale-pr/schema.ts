import { z } from "zod";

export const StalePullRequestRunSchema = z.object({
  staleAfterDays: z.number().int().min(1).max(365),
  includeDrafts: z.boolean(),
}).strict();

export type StalePullRequestRunInput = z.infer<typeof StalePullRequestRunSchema>;
