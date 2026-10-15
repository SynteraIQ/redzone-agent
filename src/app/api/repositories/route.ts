import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createSelectedRepositoryCookie,
  getInstalledRepositoriesForRequest,
  GITHUB_REPOSITORY_COOKIE,
  isGitHubAppConfigured,
  readSelectedRepositoryCookie,
} from "../../../github-app.ts";

export const runtime = "nodejs";

const SelectRepositorySchema = z.object({
  repository: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
});

export async function GET(request: NextRequest): Promise<Response> {
  if (!isGitHubAppConfigured()) {
    return Response.json({ error: "Configure the GitHub App before loading repositories." }, { status: 503 });
  }
  try {
    const { repositories, installationId, subject } = await getInstalledRepositoriesForRequest(request);
    const configuredSelection = readSelectedRepositoryCookie(
      request.cookies.get(GITHUB_REPOSITORY_COOKIE)?.value,
      subject,
      installationId,
    );
    const selectedRepository = repositories.find(
      (repository) => repository.full_name.toLowerCase() === configuredSelection?.toLowerCase(),
    )?.full_name ?? null;
    const response = NextResponse.json({
      repositories,
      selectedRepository,
    });
    response.headers.set("Cache-Control", "private, no-store");
    if (!selectedRepository && configuredSelection) {
      response.cookies.delete(GITHUB_REPOSITORY_COOKIE);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load GitHub repositories.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isGitHubAppConfigured()) {
    return Response.json({ error: "Configure the GitHub App before selecting a repository." }, { status: 503 });
  }
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = SelectRepositorySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Choose a valid owner/repository value." }, { status: 400 });
  }
  try {
    const { repositories, installationId, subject } = await getInstalledRepositoriesForRequest(request);
    const selected = repositories.find((repository) => repository.full_name === parsed.data.repository);
    if (!selected) {
      return Response.json({ error: "That repository is not available to the connected GitHub App." }, { status: 403 });
    }
    const response = NextResponse.json({ selectedRepository: selected.full_name });
    response.cookies.set(
      GITHUB_REPOSITORY_COOKIE,
      createSelectedRepositoryCookie(selected.full_name, subject, installationId),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      },
    );
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not select the GitHub repository.";
    return Response.json({ error: message }, { status: 400 });
  }
}
