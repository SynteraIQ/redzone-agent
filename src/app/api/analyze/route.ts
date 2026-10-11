import { randomUUID } from "node:crypto";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { getServerSession } from "next-auth";
import { analyzeSnapshot } from "../../../agent.ts";
import { authOptions, googleCredentialsConfigured } from "../../../auth.ts";
import { collectReviewEvidence } from "../../../github.ts";
import { collectRepositorySnapshot } from "../../../history.ts";
import { formatAnalysisReport } from "../../../report.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

type AnalyzeRequest = {
  baseRef?: unknown;
};

function isValidBaseRef(baseRef: string): boolean {
  return baseRef.length > 0 && baseRef.length <= 100 && !baseRef.startsWith("-") &&
    /^[A-Za-z0-9_./-]+$/.test(baseRef);
}

export async function POST(request: Request): Promise<Response> {
  if (googleCredentialsConfigured && !(await getServerSession(authOptions))) {
    return Response.json({ error: "Sign in with Google to run an analysis." }, { status: 401 });
  }
  if (process.env.NODE_ENV === "production" && !googleCredentialsConfigured) {
    return Response.json({ error: "Google OAuth is not configured." }, { status: 503 });
  }

  let requestBody: AnalyzeRequest;
  try {
    requestBody = await request.json() as AnalyzeRequest;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const baseRef = typeof requestBody.baseRef === "string" ? requestBody.baseRef.trim() : "";
  if (!isValidBaseRef(baseRef)) {
    return Response.json({ error: "Enter a valid base branch or commit reference." }, { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "Set OPENAI_API_KEY before running an analysis." }, { status: 503 });
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const repositoryPath = process.env.REDZONE_REPOSITORY_PATH?.trim() || process.cwd();
      const snapshot = collectRepositorySnapshot(repositoryPath, baseRef);
      if (snapshot.changedFiles.length === 0) {
        writer.write({ type: "text-start", id: "red-zone-report" });
        writer.write({ type: "text-delta", id: "red-zone-report", delta: `No changed files found between ${baseRef} and HEAD.` });
        writer.write({ type: "text-end", id: "red-zone-report" });
        return;
      }

      const reviewCollection = collectReviewEvidence(snapshot);
      const analysis = await analyzeSnapshot(
        snapshot,
        reviewCollection.evidence,
        reviewCollection.coverage,
        repositoryPath,
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

      const messageId = randomUUID();
      writer.write({ type: "text-start", id: messageId });
      for (let offset = 0; offset < report.length; offset += 240) {
        writer.write({ type: "text-delta", id: messageId, delta: report.slice(offset, offset + 240) });
      }
      writer.write({ type: "text-end", id: messageId });
    },
    onError: (error) => error instanceof Error ? error.message : "Analysis failed.",
  });

  return createUIMessageStreamResponse({ stream });
}
