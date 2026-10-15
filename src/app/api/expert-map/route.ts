import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { authOptions, githubOAuthConfigured } from "../../../auth.ts";
import { collectExpertMap, collectRemoteCodeowners } from "../../../github.ts";
import { getInstallationTokenForRequest, getSelectedRepositoryForRequest } from "../../../github-app.ts";
import { buildExpertMap } from "../../../expert-map.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<Response> {
  if (githubOAuthConfigured && !(await getServerSession(authOptions))) {
    return Response.json({ error: "Sign in with GitHub to build the expert map." }, { status: 401 });
  }
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) {
    return Response.json({ error: "GitHub App sign-in is not configured." }, { status: 503 });
  }
  try {
    const repositoryPath = process.cwd();
    const repository = await getSelectedRepositoryForRequest(request);
    const token = await getInstallationTokenForRequest(request);
    const scan = await collectExpertMap(repository, token);
    const codeowners = await collectRemoteCodeowners(repository, token);
    const expertMap = buildExpertMap(scan, repositoryPath, codeowners);
    const response = Response.json(expertMap);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not build the expert map.";
    return Response.json({ error: message }, { status: 400 });
  }
}
