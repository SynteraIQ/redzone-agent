import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, googleCredentialsConfigured } from "../../../../auth.ts";
import { createAnalysisPlan } from "../../../../agents/planner/index.ts";
import { createSnapshotFingerprint, isValidBaseRef } from "../../../../analysis-plan.ts";
import { collectReviewEvidence } from "../../../../github.ts";
import { collectRepositorySnapshot } from "../../../../history.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

const PlanRequestSchema = z.object({ baseRef: z.string().trim().min(1).max(100) });

export async function POST(request: Request): Promise<Response> {
  if (googleCredentialsConfigured && !(await getServerSession(authOptions))) {
    return Response.json({ error: "Sign in with Google to create an analysis plan." }, { status: 401 });
  }
  if (process.env.NODE_ENV === "production" && !googleCredentialsConfigured) {
    return Response.json({ error: "Google OAuth is not configured." }, { status: 503 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "Set OPENAI_API_KEY before creating an analysis plan." }, { status: 503 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = PlanRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Enter a valid base branch or commit reference." }, { status: 400 });
  }
  if (!isValidBaseRef(parsed.data.baseRef)) {
    return Response.json({ error: "Enter a valid base branch or commit reference." }, { status: 400 });
  }

  try {
    const repositoryPath = process.env.REDZONE_REPOSITORY_PATH?.trim() || process.cwd();
    const snapshot = collectRepositorySnapshot(repositoryPath, parsed.data.baseRef);
    const snapshotFingerprint = createSnapshotFingerprint(snapshot);
    const reviewCollection = collectReviewEvidence(snapshot);
    const plan = snapshot.changedFiles.length > 0
      ? await createAnalysisPlan(snapshot, reviewCollection.evidence, reviewCollection.coverage, repositoryPath)
      : {
          availableAgentIds: [],
          selectedAgentIds: [],
          rationale: "No changed files were found for this base reference.",
          impactGraph: {
            status: "skipped" as const,
            note: "No changed files to map.",
            directDependents: [],
            transitiveDependents: [],
            changedFiles: [],
            filesScanned: 0,
            importEdges: 0,
          },
          rollbackEvidenceCount: 0,
          reviewEvidenceCount: 0,
        };

    return Response.json({
      hasChanges: snapshot.changedFiles.length > 0,
      snapshotFingerprint,
      baseRef: snapshot.baseRef,
      headSha: snapshot.headSha,
      changedFiles: snapshot.changedFiles,
      availableAgentIds: plan.availableAgentIds,
      selectedAgentIds: plan.selectedAgentIds,
      rationale: plan.rationale,
      rollbackEvidenceCount: plan.rollbackEvidenceCount,
      reviewEvidenceCount: plan.reviewEvidenceCount,
      impact: {
        status: plan.impactGraph.status,
        note: plan.impactGraph.note,
        directDependents: plan.impactGraph.directDependents.length,
        transitiveDependents: plan.impactGraph.transitiveDependents.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create an analysis plan.";
    return Response.json({ error: message }, { status: 500 });
  }
}
