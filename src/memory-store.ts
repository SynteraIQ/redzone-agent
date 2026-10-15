import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { getMemoryDatabase } from "./db/index.ts";
import { memoryApplicationItems, memoryApplications, memoryEvents, memoryEvidence, memories } from "./db/schema.ts";

export type AppliedMemory = {
  id: string;
  kind: "semantic" | "procedural";
  title: string;
  summary: string;
  scope: Record<string, string | number | boolean | null>;
  content: Record<string, unknown>;
  version: number;
};

export async function loadActiveMemories(tenantId: string, repository: string): Promise<AppliedMemory[]> {
  const database = getMemoryDatabase();
  const now = new Date();
  return await database.select({
    id: memories.id,
    kind: memories.kind,
    title: memories.title,
    summary: memories.summary,
    scope: memories.scope,
    content: memories.content,
    version: memories.version,
  })
    .from(memories)
    .where(and(
      eq(memories.tenantId, tenantId),
      eq(memories.repository, repository),
      eq(memories.status, "active"),
      lte(memories.effectiveFrom, now),
      or(isNull(memories.effectiveUntil), gt(memories.effectiveUntil, now)),
    ))
    .orderBy(desc(memories.updatedAt))
    .limit(30);
}

export async function recordMemoryApplication(input: {
  tenantId: string;
  repository: string;
  analysisId: string;
  resultSummary: string;
  memories: AppliedMemory[];
}): Promise<void> {
  if (input.memories.length === 0) return;
  const database = getMemoryDatabase();
  await database.transaction(async (transaction) => {
    const [application] = await transaction.insert(memoryApplications).values({
      tenantId: input.tenantId,
      domain: "redzone",
      repository: input.repository,
      analysisId: input.analysisId,
      resultSummary: input.resultSummary.slice(0, 1000),
    }).returning({ id: memoryApplications.id });
    if (!application) return;
    await transaction.insert(memoryApplicationItems).values(input.memories.map((memory) => ({
      applicationId: application.id,
      memoryId: memory.id,
      reason: `Included as active ${memory.kind} repository context (version ${memory.version}).`,
    })));
  });
}

export async function createMemoryCandidate(input: {
  tenantId: string;
  repository: string;
  actorId: string;
  kind: "semantic" | "procedural";
  title: string;
  summary: string;
  sourceUrl: string;
}): Promise<string> {
  const database = getMemoryDatabase();
  return await database.transaction(async (transaction) => {
    const [event] = await transaction.insert(memoryEvents).values({
      tenantId: input.tenantId,
      repository: input.repository,
      sourceType: "github-reference",
      sourceId: randomUUID(),
      sourceUrl: input.sourceUrl,
      eventType: "memory-candidate-submitted",
      actorId: input.actorId,
      occurredAt: new Date(),
      details: { title: input.title, kind: input.kind },
    }).returning({ id: memoryEvents.id });
    if (!event) throw new Error("Could not save the memory source event.");

    const [memory] = await transaction.insert(memories).values({
      tenantId: input.tenantId,
      domain: "redzone",
      repository: input.repository,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      scope: { repository: input.repository },
      content: { sourceUrl: input.sourceUrl },
      status: "candidate",
      confidence: "unreviewed",
      authority: `Submitted by ${input.actorId}`,
      createdBy: input.actorId,
    }).returning({ id: memories.id });
    if (!memory) throw new Error("Could not save the memory candidate.");

    await transaction.insert(memoryEvidence).values({
      memoryId: memory.id,
      eventId: event.id,
      relation: "supports",
    });
    return memory.id;
  });
}
