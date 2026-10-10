import { Mastra } from "@mastra/core";
import { redZoneAgent } from "../agent.ts";
import { changeScopeAgent } from "../agents/change-scope-agent.ts";
import { rollbackHistoryAgent } from "../agents/rollback-history-agent.ts";
import { reviewContextAgent } from "../agents/review-context-agent.ts";

export const mastra = new Mastra({
  agents: {
    redZoneAgent,
    changeScopeAgent,
    rollbackHistoryAgent,
    reviewContextAgent,
  },
});
