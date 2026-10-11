export const AGENT_CATALOG = [
  {
    id: "red-zone-agent",
    name: "Red Zone Planner",
    shortName: "Planner",
    description: "Routes relevant requests to specialists and synthesizes their evidence-backed responses.",
    progressStage: "synthesis",
  },
  {
    id: "change-scope-agent",
    name: "Change Scope Agent",
    shortName: "Change Scope",
    description: "Maps a change to affected behavior, files, and functions.",
    progressStage: "change-scope",
  },
  {
    id: "rollback-history-agent",
    name: "Rollback History Agent",
    shortName: "Rollback History",
    description: "Looks for overlapping reverts and mitigation signals in Git history.",
    progressStage: "rollback-history",
  },
  {
    id: "review-context-agent",
    name: "Review Context Agent",
    shortName: "Review Context",
    description: "Connects current changes with relevant prior review feedback.",
    progressStage: "review-context",
  },
] as const;

export type AgentId = (typeof AGENT_CATALOG)[number]["id"];

export function isAgentId(value: string): value is AgentId {
  return AGENT_CATALOG.some((agent) => agent.id === value);
}
