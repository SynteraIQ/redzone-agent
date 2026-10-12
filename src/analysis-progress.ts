import type { UIMessage } from "ai";
import type { EvidenceReference } from "./analysis-evidence.ts";

export type AnalysisProgressStage =
  | "snapshot"
  | "reviews"
  | "impact"
  | "planning"
  | "change-scope"
  | "rollback-history"
  | "review-context"
  | "synthesis"
  | "analysis";

export type AnalysisProgressEvent = {
  stage: AnalysisProgressStage;
  status: "running" | "completed" | "skipped" | "failed";
  label: string;
  detail?: string;
  evidence?: EvidenceReference[];
  limitations?: string[];
};

export type AgentChatRouteEvent = {
  targetAgentId: string;
  targetAgentName: string;
  delegated: boolean;
  rationale: string;
};

export type AgentChatUIMessage = UIMessage<unknown, {
  agentRouting: AgentChatRouteEvent;
}>;

export type AnalysisUIMessage = UIMessage<unknown, {
  analysisProgress: AnalysisProgressEvent;
}>;
