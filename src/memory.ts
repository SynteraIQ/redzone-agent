export type MemoryKind = "semantic" | "procedural";
export type MemoryStatus = "candidate" | "active" | "disputed" | "superseded" | "archived";

export type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  scope: Record<string, string | number | boolean | null>;
  content: Record<string, unknown>;
  status: MemoryStatus;
  confidence: string | null;
  authority: string | null;
  version: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  updatedAt: string;
  evidenceCount: number;
};

export type MemoryEventRecord = {
  id: string;
  eventType: string;
  sourceType: string;
  sourceId: string;
  sourceUrl: string | null;
  actorId: string | null;
  details: Record<string, unknown>;
  occurredAt: string;
};

export type MemoryApplicationRecord = {
  id: string;
  analysisId: string;
  resultSummary: string | null;
  appliedAt: string;
  memories: Array<{ memoryId: string; title: string; reason: string }>;
};

export type MemoryWorkspaceData = {
  configured: boolean;
  repository: string;
  memories: MemoryRecord[];
  events: MemoryEventRecord[];
  applications: MemoryApplicationRecord[];
};
