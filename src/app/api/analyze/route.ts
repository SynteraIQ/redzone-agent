import { randomUUID } from "node:crypto";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { getServerSession } from "next-auth";
import type { AnalysisProgressEvent, AnalysisUIMessage } from "../../../analysis-progress.ts";
import { analyzeSnapshot } from "../../../agent.ts";
import { AnalysisPlanRunRequestSchema, createSnapshotFingerprint, isValidBaseRef } from "../../../analysis-plan.ts";
import { authOptions, googleCredentialsConfigured } from "../../../auth.ts";
import { collectReviewEvidence } from "../../../github.ts";
import { collectRepositorySnapshot } from "../../../history.ts";
import { formatAnalysisReport } from "../../../report.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (googleCredentialsConfigured && !(await getServerSession(authOptions))) {
    return Response.json({ error: "Sign in with Google to run an analysis." }, { status: 401 });
  }
  if (process.env.NODE_ENV === "production" && !googleCredentialsConfigured) {
    return Response.json({ error: "Google OAuth is not configured." }, { status: 503 });
  }

  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsedRequest = AnalysisPlanRunRequestSchema.safeParse(requestBody);
  if (!parsedRequest.success) {
    return Response.json({ error: "Enter a valid base branch or commit reference." }, { status: 400 });
  }
  if (!isValidBaseRef(parsedRequest.data.baseRef)) {
    return Response.json({ error: "Enter a valid base branch or commit reference." }, { status: 400 });
  }
  const { baseRef, snapshotFingerprint, approvedAgentIds } = parsedRequest.data;
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
      const repositoryPath = process.env.REDZONE_REPOSITORY_PATH?.trim() || process.cwd();
      try {
        await publishProgress({ stage: "snapshot", status: "running", label: "Capturing repository changes" });
        const snapshot = collectRepositorySnapshot(repositoryPath, baseRef);
        if (createSnapshotFingerprint(snapshot) !== snapshotFingerprint) {
          throw new Error("Repository changes since the plan was created. Create a new plan before running analysis.");
        }
        await publishProgress({
          stage: "snapshot",
          status: "completed",
          label: "Repository snapshot",
          detail: `Found ${snapshot.changedFiles.length} changed files against ${baseRef}.`,
        });
        if (snapshot.changedFiles.length === 0) {
          throw new Error("No changed files were found. Create a new plan after making a change.");
        }

        await publishProgress({ stage: "reviews", status: "running", label: "Collecting prior review evidence" });
        const reviewCollection = collectReviewEvidence(snapshot);
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
        );
        const report = formatAnalysisReport({
          repositoryPath,
          snapshot,
          analysis,
          reviewEvidence: reviewCollection.evidence.filter((item) =>
            analysis.reviewEvidenceIds.includes(item.id),
          ),
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
