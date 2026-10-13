import { randomUUID } from "node:crypto";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import type { AnalysisProgressEvent, AnalysisUIMessage } from "../../../analysis-progress.ts";
import { analyzeSnapshot } from "../../../agent.ts";
import { AnalysisRunRequestSchema, createSnapshotFingerprint, isValidBaseRef } from "../../../analysis-plan.ts";
import { authOptions, githubOAuthConfigured } from "../../../auth.ts";
import { collectReviewEvidence } from "../../../github.ts";
import { getInstallationTokenForRequest, getSelectedRepositoryForRequest } from "../../../github-app.ts";
import { collectRepositorySnapshot, getGitHubOriginRepository } from "../../../history.ts";
import { formatAnalysisReport } from "../../../report.ts";

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
  if (!isValidBaseRef(parsedRequest.data.baseRef)) {
    return Response.json({ error: "Enter a valid base branch or commit reference." }, { status: 400 });
  }
  const { baseRef } = parsedRequest.data;
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
        const localRepository = getGitHubOriginRepository(repositoryPath);
        if (!localRepository) {
          throw new Error("Could not identify the current checkout's GitHub origin. Run RedZone from a GitHub checkout.");
        }
        await publishProgress({ stage: "snapshot", status: "running", label: "Capturing repository changes" });
        const snapshot = collectRepositorySnapshot(repositoryPath, baseRef);
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
        const selectedRepository = await getSelectedRepositoryForRequest(request);
        if (localRepository.toLowerCase() !== selectedRepository.toLowerCase()) {
          throw new Error(`Selected repository ${selectedRepository} does not match the local checkout origin ${localRepository}.`);
        }
        const githubToken = await getInstallationTokenForRequest(request);
        const reviewCollection = await collectReviewEvidence(snapshot, githubToken, selectedRepository);
        await publishProgress({
          stage: "reviews",
          status: "completed",
          label: "Prior review evidence",
          detail: `Collected ${reviewCollection.evidence.length} review records.`,
        });
        const analysis = await analyzeSnapshot(
          snapshot,
          reviewCollection.evidence,
          reviewCollection.coverage,
          repositoryPath,
          publishProgress,
          approvedAgentIds,
          selectedRepository,
        );
        const report = formatAnalysisReport({
          repositoryPath,
          repository: selectedRepository,
          snapshot,
          analysis,
          reviewEvidence: reviewCollection.evidence,
          sourceCoverage: reviewCollection.coverage,
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
