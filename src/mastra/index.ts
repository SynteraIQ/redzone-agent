import { Mastra } from "@mastra/core";
import { redZoneAgent } from "../agent.ts";

export const mastra = new Mastra({
  agents: { redZoneAgent },
});
