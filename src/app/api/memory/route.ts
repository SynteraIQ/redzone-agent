import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { and, count, desc, eq } from "drizzle-orm";
import { authOptions, githubOAuthConfigured } from "../../../auth.ts";
import { getMemoryDatabase, isMemoryDatabaseConfigured } from "../../../db/index.ts";
import { memoryApplications, memoryApplicationItems, memoryEvents, memoryEvidence, memories } from "../../../db/schema.ts";
import { getSelectedRepositoryContextForRequest } from "../../../github-app.ts";

export const runtime = "nodejs";

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
    const { repository, installationId } = await getSelectedRepositoryContextForRequest(request);
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
