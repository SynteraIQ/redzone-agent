import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { z } from "zod";
import { authOptions, githubOAuthConfigured } from "../../../auth.ts";
import { postPullRequestSummary } from "../../../github.ts";
import { getSelectedRepositoryForRequest } from "../../../github-app.ts";

export const runtime = "nodejs";
export const maxDuration = 15;

const RequestSchema = z.object({
  pullRequestUrl: z.string().trim().min(1).max(512),
  summary: z.string().trim().min(1).max(30_000),
});

export async function POST(request: NextRequest): Promise<Response> {
  if (githubOAuthConfigured && !(await getServerSession(authOptions))) {
    return Response.json({ error: "Sign in with GitHub to post a summary." }, { status: 401 });
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

  const parsed = RequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return Response.json({ error: "Provide a pull request URL and an analysis summary." }, { status: 400 });
  }

  try {
    const repository = await getSelectedRepositoryForRequest(request);
    const result = await postPullRequestSummary(parsed.data.pullRequestUrl, parsed.data.summary, repository);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not post the GitHub summary." },
      { status: 400 },
    );
  }
}
