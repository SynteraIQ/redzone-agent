import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { authOptions, githubOAuthConfigured } from "../../../../auth.ts";
import { collectOpenPullRequests } from "../../../../github.ts";
import { getInstallationTokenForRequest, getSelectedRepositoryForRequest, RepositorySelectionError } from "../../../../github-app.ts";
import { getGitHubOriginRepository } from "../../../../history.ts";
import { StalePullRequestRunSchema } from "../../../../automations/stale-pr/schema.ts";
import { buildStalePullRequestWorkflowResult } from "../../../../automations/stale-pr/workflow.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<Response> {
  if (githubOAuthConfigured && !(await getServerSession(authOptions))) {
    return Response.json({ error: "Sign in with GitHub to scan stale pull requests." }, { status: 401 });
  }
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) {
    return Response.json({ error: "GitHub App sign-in is not configured." }, { status: 503 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = StalePullRequestRunSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Choose an inactivity threshold from 1 to 365 days." }, { status: 400 });
  }

  const requestId = randomUUID();
  let stage = "resolve-repository";
  let repository: string | null = null;
  try {
    const repositoryPath = process.cwd();
    const localRepository = getGitHubOriginRepository(repositoryPath);
    if (!localRepository) throw new Error("Could not identify the current checkout's GitHub origin.");
    const selectedRepository = await getSelectedRepositoryForRequest(request);
    repository = selectedRepository;
    if (selectedRepository.toLowerCase() !== localRepository.toLowerCase()) {
      throw new RepositorySelectionError(`Selected repository ${selectedRepository} does not match the current checkout origin ${localRepository}.`);
    }
    stage = "create-installation-token";
    const token = await getInstallationTokenForRequest(request);
    stage = "fetch-open-pull-requests";
    console.info("[redzone:stale-pr] Run started", {
      requestId,
      repository,
      staleAfterDays: parsed.data.staleAfterDays,
      includeDrafts: parsed.data.includeDrafts,
    });
    const pullRequests = await collectOpenPullRequests(selectedRepository, token, requestId);
    stage = "evaluate-staleness-rule";
    const result = buildStalePullRequestWorkflowResult(pullRequests, parsed.data);
    console.info("[redzone:stale-pr] Run completed", {
      requestId,
      repository,
      scannedPullRequestCount: result.scannedPullRequestCount,
      candidateCount: result.candidates.length,
    });
    const response = Response.json({ repository, requestId, config: parsed.data, ...result });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const expectedError = error instanceof RepositorySelectionError;
    const message = expectedError ? error.message : "Could not scan stale pull requests.";
    console.error("[redzone:stale-pr] Run failed", {
      requestId,
      repository,
      stage,
      error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown automation error",
    });
    return Response.json({ error: message, requestId }, { status: expectedError ? 400 : 500 });
  }
}
