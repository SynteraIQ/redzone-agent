import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { authOptions, githubOAuthConfigured } from "../../../auth.ts";
import { getMemoryDatabase, isMemoryDatabaseConfigured } from "../../../db/index.ts";
import { memoryApplications, memoryApplicationItems, memoryEvents, memoryEvidence, memories } from "../../../db/schema.ts";
import { getSelectedRepositoryContextForRequest } from "../../../github-app.ts";
import { createMemoryCandidate } from "../../../memory-store.ts";

export const runtime = "nodejs";

const MemoryCandidateSchema = z.object({
  kind: z.enum(["semantic", "procedural"]),
  title: z.string().trim().min(3).max(240),
  summary: z.string().trim().min(10).max(2000),
  sourceUrl: z.string().url().max(2000),
});

const MemoryDecisionSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approve", "archive"]),
});

async function authorizeMemoryWrite(): Promise<Response | null> {
  const session = githubOAuthConfigured ? await getServerSession(authOptions) : null;
  const localDeveloperMode = process.env.NODE_ENV !== "production" && process.env.REDZONE_DEV_MODE === "true";
  if (githubOAuthConfigured && !session) {
    return Response.json({ error: "Sign in with GitHub to update repository memory." }, { status: 401 });
  }
  if (!session && !localDeveloperMode) {
    return Response.json({ error: "Memory requires an authenticated GitHub session." }, { status: 401 });
  }
  if (!isMemoryDatabaseConfigured()) {
    return Response.json({ error: "Set DATABASE_URL to enable persistent memory." }, { status: 503 });
  }
  return null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const session = githubOAuthConfigured ? await getServerSession(authOptions) : null;
  const localDeveloperMode = process.env.NODE_ENV !== "production" && process.env.REDZONE_DEV_MODE === "true";
  if (githubOAuthConfigured && !session) {
    return Response.json({ error: "Sign in with GitHub to view repository memory." }, { status: 401 });
  }
  if (!session && !localDeveloperMode) {
    return Response.json({ error: "Memory requires an authenticated GitHub session." }, { status: 401 });
  }
  if (!isMemoryDatabaseConfigured()) {
    return Response.json({ configured: false, memories: [], events: [], applications: [] });
  }

  try {
    const { repository, installationId, subject } = await getSelectedRepositoryContextForRequest(request);
    const tenantId = String(installationId);
    const database = getMemoryDatabase();
    const [memoryRows, eventRows, applicationRows] = await Promise.all([
      database.select({
        id: memories.id,
        kind: memories.kind,
        title: memories.title,
        summary: memories.summary,
        scope: memories.scope,
        content: memories.content,
        status: memories.status,
        confidence: memories.confidence,
        authority: memories.authority,
        version: memories.version,
        effectiveFrom: memories.effectiveFrom,
        effectiveUntil: memories.effectiveUntil,
        updatedAt: memories.updatedAt,
        evidenceCount: count(memoryEvidence.eventId),
      })
        .from(memories)
        .leftJoin(memoryEvidence, eq(memoryEvidence.memoryId, memories.id))
        .where(and(eq(memories.tenantId, tenantId), eq(memories.repository, repository)))
        .groupBy(memories.id)
        .orderBy(desc(memories.updatedAt))
        .limit(100),
      database.select({
        id: memoryEvents.id,
        eventType: memoryEvents.eventType,
        sourceType: memoryEvents.sourceType,
        sourceId: memoryEvents.sourceId,
        sourceUrl: memoryEvents.sourceUrl,
        actorId: memoryEvents.actorId,
        occurredAt: memoryEvents.occurredAt,
      })
        .from(memoryEvents)
        .where(and(eq(memoryEvents.tenantId, tenantId), eq(memoryEvents.repository, repository)))
        .orderBy(desc(memoryEvents.occurredAt))
        .limit(50),
      database.select({
        id: memoryApplications.id,
        analysisId: memoryApplications.analysisId,
        resultSummary: memoryApplications.resultSummary,
        appliedAt: memoryApplications.appliedAt,
        memoryId: memoryApplicationItems.memoryId,
        title: memories.title,
        reason: memoryApplicationItems.reason,
      })
        .from(memoryApplications)
        .leftJoin(memoryApplicationItems, eq(memoryApplicationItems.applicationId, memoryApplications.id))
        .leftJoin(memories, eq(memories.id, memoryApplicationItems.memoryId))
        .where(and(eq(memoryApplications.tenantId, tenantId), eq(memoryApplications.repository, repository)))
        .orderBy(desc(memoryApplications.appliedAt))
        .limit(100),
    ]);

    const applications = new Map<string, {
      id: string;
      analysisId: string;
      resultSummary: string | null;
      appliedAt: Date;
      memories: Array<{ memoryId: string; title: string; reason: string }>;
    }>();
    for (const row of applicationRows) {
      const application = applications.get(row.id) ?? {
        id: row.id,
        analysisId: row.analysisId,
        resultSummary: row.resultSummary,
        appliedAt: row.appliedAt,
        memories: [],
      };
      if (row.memoryId && row.title) {
        application.memories.push({ memoryId: row.memoryId, title: row.title, reason: row.reason ?? "" });
      }
      applications.set(row.id, application);
    }

    const response = Response.json({
      configured: true,
      repository,
      memories: memoryRows,
      events: eventRows,
      applications: [...applications.values()],
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    console.error("[redzone:memory] Could not load repository memory", {
      message: error instanceof Error ? error.message : "Unknown memory read error",
    });
    return Response.json({ error: "Could not load memory for the selected repository." }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await authorizeMemoryWrite();
  if (authError) return authError;
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = MemoryCandidateSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Add a valid memory and source URL." }, { status: 400 });

  try {
    const { repository, installationId, subject } = await getSelectedRepositoryContextForRequest(request);
    const source = new URL(parsed.data.sourceUrl);
    const expectedPath = `/${repository}/`;
    if (source.protocol !== "https:" || source.hostname !== "github.com" ||
      !source.pathname.startsWith(expectedPath)) {
      return Response.json({ error: `The evidence URL must point to ${repository} on github.com.` }, { status: 400 });
    }
    const id = await createMemoryCandidate({
      tenantId: String(installationId),
      repository,
      actorId: subject,
      ...parsed.data,
    });
    return Response.json({ id, status: "candidate" }, { status: 201 });
  } catch (error) {
    console.error("[redzone:memory] Could not save memory candidate", {
      message: error instanceof Error ? error.message : "Unknown memory write error",
    });
    return Response.json({ error: "Could not save the memory candidate." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const authError = await authorizeMemoryWrite();
  if (authError) return authError;
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = MemoryDecisionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Choose a valid memory decision." }, { status: 400 });

  try {
    const { repository, installationId, subject } = await getSelectedRepositoryContextForRequest(request);
    const database = getMemoryDatabase();
    const updated = await database.transaction(async (transaction) => {
      const [memory] = await transaction.update(memories).set({
        status: parsed.data.decision === "approve" ? "active" : "archived",
        confidence: parsed.data.decision === "approve" ? "reviewed" : "unreviewed",
        updatedAt: new Date(),
      }).where(and(
        eq(memories.id, parsed.data.id),
        eq(memories.tenantId, String(installationId)),
        eq(memories.repository, repository),
        eq(memories.status, "candidate"),
      )).returning({ id: memories.id, status: memories.status });
      if (!memory) return null;
      const [event] = await transaction.insert(memoryEvents).values({
        tenantId: String(installationId),
        repository,
        sourceType: "human-review",
        sourceId: `${memory.id}:${parsed.data.decision}:${Date.now()}`,
        eventType: parsed.data.decision === "approve" ? "memory-approved" : "memory-archived",
        actorId: subject,
        occurredAt: new Date(),
        details: { memoryId: memory.id },
      }).returning({ id: memoryEvents.id });
      if (event) await transaction.insert(memoryEvidence).values({
        memoryId: memory.id,
        eventId: event.id,
        relation: "updates",
      });
      return memory;
    });
    if (!updated) return Response.json({ error: "Only a candidate in the selected repository can be reviewed." }, { status: 404 });
    return Response.json(updated);
  } catch (error) {
    console.error("[redzone:memory] Could not record memory decision", {
      message: error instanceof Error ? error.message : "Unknown memory update error",
    });
    return Response.json({ error: "Could not update the memory candidate." }, { status: 500 });
  }
}
