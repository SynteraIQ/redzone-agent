import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { authOptions, githubOAuthConfigured } from "../../../../auth.ts";
import { collectOpenPullRequests } from "../../../../github.ts";
import { getInstallationTokenForRequest, getSelectedRepositoryForRequest } from "../../../../github-app.ts";
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

  try {
    const repositoryPath = process.cwd();
    const localRepository = getGitHubOriginRepository(repositoryPath);
    if (!localRepository) throw new Error("Could not identify the current checkout's GitHub origin.");
    const repository = await getSelectedRepositoryForRequest(request);
    if (repository.toLowerCase() !== localRepository.toLowerCase()) {
      throw new Error(`Selected repository ${repository} does not match the current checkout origin ${localRepository}.`);
    }
    const token = await getInstallationTokenForRequest(request);
    const pullRequests = await collectOpenPullRequests(repository, token);
    const result = buildStalePullRequestWorkflowResult(pullRequests, parsed.data);
    const response = Response.json({ repository, config: parsed.data, ...result });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not scan stale pull requests.";
    return Response.json({ error: message }, { status: 400 });
  }
}
