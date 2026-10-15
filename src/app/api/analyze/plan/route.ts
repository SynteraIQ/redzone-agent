import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { z } from "zod";
import { authOptions, githubOAuthConfigured } from "../../../../auth.ts";
import { createAnalysisPlan } from "../../../../agents/planner/index.ts";
import { createSnapshotFingerprint, isValidBaseRef } from "../../../../analysis-plan.ts";
import { collectPullRequestSnapshot, collectReviewEvidence } from "../../../../github.ts";
import { getInstallationTokenForRequest, getSelectedRepositoryContextForRequest } from "../../../../github-app.ts";
import { collectRepositorySnapshot, getGitHubOriginRepository } from "../../../../history.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

const PlanRequestSchema = z.union([
  z.object({ baseRef: z.string().trim().min(1).max(100) }),
  z.object({ pullRequestNumber: z.number().int().positive().max(999999) }),
]);

export async function POST(request: NextRequest): Promise<Response> {
  if (githubOAuthConfigured && !(await getServerSession(authOptions))) {
    return Response.json({ error: "Sign in with GitHub to create an analysis plan." }, { status: 401 });
  }
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) {
    return Response.json({ error: "GitHub App sign-in is not configured." }, { status: 503 });
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
  if ("baseRef" in parsed.data && !isValidBaseRef(parsed.data.baseRef)) {
    return Response.json({ error: "Enter a valid base branch or commit reference." }, { status: 400 });
  }

  try {
    const repositoryPath = process.cwd();
    const selectedContext = await getSelectedRepositoryContextForRequest(request);
    const selectedRepository = selectedContext.repository;
    const githubToken = await getInstallationTokenForRequest(request);
    const pullRequestNumber = "pullRequestNumber" in parsed.data ? parsed.data.pullRequestNumber : undefined;
    let snapshot;
    if (pullRequestNumber) {
      snapshot = await collectPullRequestSnapshot(selectedRepository, pullRequestNumber, githubToken);
    } else {
      const localRepository = getGitHubOriginRepository(repositoryPath);
      if (!localRepository) {
        throw new Error("Choose a pull request to analyze. Local branch analysis is available only in a Git checkout.");
      }
      if (localRepository.toLowerCase() !== selectedRepository.toLowerCase()) {
        throw new Error(`Selected repository ${selectedRepository} does not match the local checkout origin ${localRepository}.`);
      }
      snapshot = collectRepositorySnapshot(repositoryPath, "baseRef" in parsed.data ? parsed.data.baseRef : "main");
    }
    const snapshotFingerprint = createSnapshotFingerprint(snapshot);
    const reviewCollection = await collectReviewEvidence(snapshot, githubToken, selectedRepository);
    const plan = snapshot.changedFiles.length > 0
      ? await createAnalysisPlan(snapshot, reviewCollection.evidence, reviewCollection.coverage, repositoryPath, selectedRepository)
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
      ...(pullRequestNumber ? { pullRequestNumber } : {}),
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
