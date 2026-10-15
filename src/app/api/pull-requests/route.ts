import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { authOptions, githubOAuthConfigured } from "../../../auth.ts";
import { getInstallationTokenForRequest, getSelectedRepositoryForRequest } from "../../../github-app.ts";
import { listRecentPullRequests } from "../../../github.ts";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  if (githubOAuthConfigured && !(await getServerSession(authOptions))) {
    return Response.json({ error: "Sign in with GitHub to load pull requests." }, { status: 401 });
  }
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) {
    return Response.json({ error: "GitHub App sign-in is not configured." }, { status: 503 });
  }
  try {
    const repository = await getSelectedRepositoryForRequest(request);
    const token = await getInstallationTokenForRequest(request);
    const pullRequests = await listRecentPullRequests(repository, token);
    const response = Response.json({ pullRequests });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load pull requests.";
    return Response.json({ error: message }, { status: 400 });
  }
}
