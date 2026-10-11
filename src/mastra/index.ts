import { Mastra } from "@mastra/core";
import { redZoneAgent } from "../agents/planner/index.ts";
import { changeScopeAgent } from "../agents/change-scope/index.ts";
import { rollbackHistoryAgent } from "../agents/rollback-history/index.ts";
import { reviewContextAgent } from "../agents/review-context/index.ts";

export const mastra = new Mastra({
  agents: {
    redZoneAgent,
    changeScopeAgent,
    rollbackHistoryAgent,
    reviewContextAgent,
  },
});
