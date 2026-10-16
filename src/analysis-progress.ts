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

export type AnalysisRunContext = {
  changedFiles: string[];
  reviewEvidenceCount: number;
  episodeCount: number;
  episodes: Array<{
    id: number;
    pullRequestNumber: number;
    pullRequestTitle: string;
    pullRequestUrl: string;
    outcome: "open" | "merged" | "closed" | "unknown";
    overlappingFiles: string[];
    feedback: Array<{
      id: string;
      author: string;
      source: string;
      decision?: string;
      commentUrl: string;
      excerpt: string;
    }>;
  }>;
  knowledge: Array<{
    id: string;
    kind: "semantic" | "procedural";
    title: string;
    summary: string;
    version: number;
    sourceUrl?: string;
    evidence: Array<{ id: string; sourceUrl: string; label: string; excerpt?: string }>;
  }>;
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
  analysisContext: AnalysisRunContext;
}>;
