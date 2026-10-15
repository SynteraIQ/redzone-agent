import { randomUUID } from "node:crypto";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import type { AnalysisProgressEvent, AnalysisUIMessage } from "../../../analysis-progress.ts";
import { analyzeSnapshot } from "../../../agent.ts";
import { AnalysisRunRequestSchema, createSnapshotFingerprint, isValidBaseRef } from "../../../analysis-plan.ts";
import { authOptions, githubOAuthConfigured } from "../../../auth.ts";
import { collectPullRequestSnapshot, collectReviewEvidence } from "../../../github.ts";
import { getInstallationTokenForRequest, getSelectedRepositoryContextForRequest } from "../../../github-app.ts";
import { collectRepositorySnapshot, getGitHubOriginRepository } from "../../../history.ts";
import { formatAnalysisReport } from "../../../report.ts";
import { isMemoryDatabaseConfigured } from "../../../db/index.ts";
import { loadActiveMemories, recordMemoryApplication } from "../../../memory-store.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<Response> {
  if (githubOAuthConfigured && !(await getServerSession(authOptions))) {
    return Response.json({ error: "Sign in with GitHub to run an analysis." }, { status: 401 });
  }
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) {
    return Response.json({ error: "GitHub App sign-in is not configured." }, { status: 503 });
  }

  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsedRequest = AnalysisRunRequestSchema.safeParse(requestBody);
  if (!parsedRequest.success) {
    return Response.json({ error: "Enter a valid base branch or commit reference." }, { status: 400 });
  }
  if ("baseRef" in parsedRequest.data && !isValidBaseRef(parsedRequest.data.baseRef)) {
    return Response.json({ error: "Enter a valid base branch or commit reference." }, { status: 400 });
  }
  const baseRef = "baseRef" in parsedRequest.data ? parsedRequest.data.baseRef : undefined;
  const pullRequestNumber = "pullRequestNumber" in parsedRequest.data ? parsedRequest.data.pullRequestNumber : undefined;
  const snapshotFingerprint = "snapshotFingerprint" in parsedRequest.data
    ? parsedRequest.data.snapshotFingerprint
    : undefined;
  const approvedAgentIds = "approvedAgentIds" in parsedRequest.data
    ? parsedRequest.data.approvedAgentIds
    : undefined;
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "Set OPENAI_API_KEY before running an analysis." }, { status: 503 });
  }

  const stream = createUIMessageStream<AnalysisUIMessage>({
    execute: async ({ writer }) => {
      const messageId = randomUUID();
      writer.write({ type: "start", messageId });
      const publishProgress = async (event: AnalysisProgressEvent) => {
        writer.write({ type: "data-analysisProgress", id: event.stage, data: event });
        // Give the SSE response a chance to flush before synchronous Git and AST work.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      };
      const repositoryPath = process.cwd();
      try {
        await publishProgress({ stage: "snapshot", status: "running", label: "Capturing repository changes" });
        const selectedContext = await getSelectedRepositoryContextForRequest(request);
        const selectedRepository = selectedContext.repository;
        const githubToken = await getInstallationTokenForRequest(request);
        const localRepository = pullRequestNumber ? undefined : getGitHubOriginRepository(repositoryPath);
        if (!pullRequestNumber && !localRepository) {
          throw new Error("Choose a pull request to analyze. Local branch analysis is available only in a Git checkout.");
        }
        if (localRepository && localRepository.toLowerCase() !== selectedRepository.toLowerCase()) {
          throw new Error(`Selected repository ${selectedRepository} does not match the local checkout origin ${localRepository}.`);
        }
        const snapshot = pullRequestNumber
          ? await collectPullRequestSnapshot(selectedRepository, pullRequestNumber, githubToken)
          : collectRepositorySnapshot(repositoryPath, baseRef ?? "main");
        if (snapshotFingerprint && createSnapshotFingerprint(snapshot) !== snapshotFingerprint) {
          throw new Error("Repository changes since the plan was created. Create a new plan before running analysis.");
        }
        await publishProgress({
          stage: "snapshot",
          status: "completed",
          label: "Repository snapshot",
          detail: `Found ${snapshot.changedFiles.length} changed files against ${baseRef}.`,
        });
        if (snapshot.changedFiles.length === 0) {
          throw new Error("No changed files were found. Make a change before running analysis.");
        }

        await publishProgress({ stage: "reviews", status: "running", label: "Collecting prior review evidence" });
        const reviewCollection = await collectReviewEvidence(snapshot, githubToken, selectedRepository);
        await publishProgress({
          stage: "reviews",
          status: "completed",
          label: "Prior review evidence",
          detail: `Collected ${reviewCollection.evidence.length} review records.`,
        });
        let activeMemories = [] as Awaited<ReturnType<typeof loadActiveMemories>>;
        if (isMemoryDatabaseConfigured()) {
          try {
            activeMemories = await loadActiveMemories(String(selectedContext.installationId), selectedRepository);
          } catch (error) {
            console.error("[redzone:memory] Memory retrieval failed; continuing without memory", {
              repository: selectedRepository,
              message: error instanceof Error ? error.message : "Unknown memory retrieval error",
            });
          }
        }
        const analysis = await analyzeSnapshot(
          snapshot,
          reviewCollection.evidence,
          reviewCollection.coverage,
          repositoryPath,
          publishProgress,
          approvedAgentIds,
          selectedRepository,
          activeMemories,
        );
        if (activeMemories.length > 0) {
          try {
            await recordMemoryApplication({
              tenantId: String(selectedContext.installationId),
              repository: selectedRepository,
              analysisId: messageId,
              resultSummary: analysis.summary,
              memories: activeMemories,
            });
          } catch (error) {
            console.error("[redzone:memory] Could not record memory application", {
              repository: selectedRepository,
              analysisId: messageId,
              message: error instanceof Error ? error.message : "Unknown memory application error",
            });
          }
        }
        const report = formatAnalysisReport({
          repositoryPath,
          repository: selectedRepository,
          snapshot,
          analysis,
          reviewEvidence: reviewCollection.evidence,
          sourceCoverage: reviewCollection.coverage,
          appliedMemories: activeMemories,
        });
        await publishProgress({ stage: "analysis", status: "completed", label: "Analysis complete" });
        writer.write({ type: "text-start", id: `${messageId}-report` });
        writer.write({ type: "text-delta", id: `${messageId}-report`, delta: report });
        writer.write({ type: "text-end", id: `${messageId}-report` });
      } catch (error) {
        await publishProgress({
          stage: "analysis",
          status: "failed",
          label: "Analysis failed",
          detail: error instanceof Error ? error.message : "An unexpected analysis error occurred.",
        });
        throw error;
      }
    },
    onError: (error) => error instanceof Error ? error.message : "Analysis failed.",
  });

  return createUIMessageStreamResponse({ stream });
}
