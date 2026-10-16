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

export type LearnedPatternEvidence = {
  id: string;
  sourceUrl: string;
  source: string;
  author: string;
  body: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestOutcome: string;
  path?: string;
  decision?: string;
  createdAt: string;
};

export async function recordLearningReviewEvidence(input: {
  tenantId: string;
  repository: string;
  evidence: LearnedPatternEvidence[];
}): Promise<number> {
  const database = getMemoryDatabase();
  return await database.transaction(async (transaction) => {
    let recorded = 0;
    for (const evidence of input.evidence) {
      const values = {
        tenantId: input.tenantId,
        repository: input.repository,
        sourceType: "github-review" as const,
        sourceId: evidence.id,
        sourceUrl: evidence.sourceUrl,
        eventType: "github-review-feedback",
        actorId: evidence.author,
        occurredAt: new Date(evidence.createdAt),
        details: {
          body: evidence.body.slice(0, 4000),
          source: evidence.source,
          pullRequestNumber: evidence.pullRequestNumber,
          pullRequestTitle: evidence.pullRequestTitle,
          pullRequestOutcome: evidence.pullRequestOutcome,
          path: evidence.path,
          decision: evidence.decision,
        },
      };
      const [event] = await transaction.insert(memoryEvents).values(values)
        .onConflictDoUpdate({
          target: [memoryEvents.tenantId, memoryEvents.repository, memoryEvents.sourceType, memoryEvents.sourceId],
          set: {
            sourceUrl: values.sourceUrl,
            eventType: values.eventType,
            actorId: values.actorId,
            occurredAt: values.occurredAt,
            details: values.details,
          },
        })
        .returning({ id: memoryEvents.id });
      if (event) recorded++;
    }
    return recorded;
  });
}

export async function saveLearnedPatternCandidates(input: {
  tenantId: string;
  repository: string;
  candidates: Array<{
    title: string;
    summary: string;
    evidence: LearnedPatternEvidence[];
  }>;
}): Promise<{ created: number; linked: number }> {
  const database = getMemoryDatabase();
  return await database.transaction(async (transaction) => {
    const existingMemories = await transaction.select({
      id: memories.id,
      title: memories.title,
    })
      .from(memories)
      .where(and(
        eq(memories.tenantId, input.tenantId),
        eq(memories.repository, input.repository),
        eq(memories.kind, "semantic"),
      ));
    let created = 0;
    let linked = 0;

    for (const candidate of input.candidates) {
      const prior = existingMemories.find((memory) => memory.title.trim().toLocaleLowerCase() === candidate.title.trim().toLocaleLowerCase());
      let memoryId = prior?.id;
      if (!memoryId) {
        const [memory] = await transaction.insert(memories).values({
          tenantId: input.tenantId,
          domain: "redzone",
          repository: input.repository,
          kind: "semantic",
          title: candidate.title,
          summary: candidate.summary,
          scope: { repository: input.repository },
          content: {
            evidence: candidate.evidence.map((evidence) => ({
              id: evidence.id,
              sourceUrl: evidence.sourceUrl,
              source: evidence.source,
              author: evidence.author,
              pullRequestNumber: evidence.pullRequestNumber,
              pullRequestTitle: evidence.pullRequestTitle,
              pullRequestOutcome: evidence.pullRequestOutcome,
              path: evidence.path,
              decision: evidence.decision,
              excerpt: evidence.body.slice(0, 500),
            })),
          },
          status: "candidate",
          confidence: "unreviewed",
          authority: "Generated from repeated GitHub review feedback",
          createdBy: "redzone:knowledge-learning-agent",
        }).returning({ id: memories.id });
        if (!memory) throw new Error("Could not save a learned-pattern candidate.");
        memoryId = memory.id;
        created++;
        existingMemories.push({ id: memory.id, title: candidate.title });
      }

      for (const evidence of candidate.evidence) {
        const [insertedEvent] = await transaction.insert(memoryEvents).values({
          tenantId: input.tenantId,
          repository: input.repository,
          sourceType: "github-review",
          sourceId: evidence.id,
          sourceUrl: evidence.sourceUrl,
          eventType: "github-review-feedback",
          actorId: evidence.author,
          occurredAt: new Date(evidence.createdAt),
          details: {
            body: evidence.body.slice(0, 4000),
            source: evidence.source,
            pullRequestNumber: evidence.pullRequestNumber,
            pullRequestTitle: evidence.pullRequestTitle,
            pullRequestOutcome: evidence.pullRequestOutcome,
            path: evidence.path,
            decision: evidence.decision,
          },
        }).onConflictDoNothing().returning({ id: memoryEvents.id });
        const event = insertedEvent ?? (await transaction.select({ id: memoryEvents.id })
          .from(memoryEvents)
          .where(and(
            eq(memoryEvents.tenantId, input.tenantId),
            eq(memoryEvents.repository, input.repository),
            eq(memoryEvents.sourceType, "github-review"),
            eq(memoryEvents.sourceId, evidence.id),
          )))[0];
        if (!event) continue;
        const [edge] = await transaction.insert(memoryEvidence).values({
          memoryId,
          eventId: event.id,
          relation: "supports",
        }).onConflictDoNothing().returning({ memoryId: memoryEvidence.memoryId });
        if (edge) linked++;
      }
    }
    return { created, linked };
  });
}
