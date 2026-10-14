import { randomUUID } from "node:crypto";
import { getRun, start } from "workflow/api";
import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { authOptions, githubOAuthConfigured } from "../../../../auth.ts";
import { getSelectedRepositoryContextForRequest, RepositorySelectionError } from "../../../../github-app.ts";
import { getGitHubOriginRepository } from "../../../../history.ts";
import {
  createStalePullRequestRunReference,
  readStalePullRequestRunReference,
} from "../../../../automations/stale-pr/run-reference.ts";
import { StalePullRequestRunSchema } from "../../../../automations/stale-pr/schema.ts";
import {
  runStalePullRequestWorkflow,
  type StalePullRequestProgressEvent,
  type StalePullRequestWorkflowResult,
} from "../../../../automations/stale-pr/workflow.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

async function requireSignedInUser(): Promise<{ id: string } | null> {
  const session = await getServerSession(authOptions);
  if (githubOAuthConfigured && !session?.user?.id) return null;
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) return null;
  return session?.user?.id ? { id: session.user.id } : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const user = await requireSignedInUser();
  if (!user && githubOAuthConfigured) {
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
    return Response.json({ error: "Choose a threshold from 1 to 365 days or 1 to 8760 hours." }, { status: 400 });
  }

  const requestId = randomUUID();
  let repository: string | null = null;
  try {
    const localRepository = getGitHubOriginRepository(process.cwd());
    if (!localRepository) throw new Error("Could not identify the current checkout's GitHub origin.");
    const selected = await getSelectedRepositoryContextForRequest(request);
    repository = selected.repository;
    if (selected.repository.toLowerCase() !== localRepository.toLowerCase()) {
      throw new RepositorySelectionError(
        `Selected repository ${selected.repository} does not match the current checkout origin ${localRepository}.`,
      );
    }

    console.info("[redzone:stale-pr] Durable run requested", {
      requestId,
      repository,
      inactivityThreshold: "staleAfterHours" in parsed.data
        ? `${parsed.data.staleAfterHours} hours`
        : `${parsed.data.staleAfterDays} days`,
      includeDrafts: parsed.data.includeDrafts,
    });
    const run = await start(runStalePullRequestWorkflow, [{
      repository,
      installationId: selected.installationId,
      config: parsed.data,
      startedAt: new Date().toISOString(),
      requestId,
    }]);
    const runRef = createStalePullRequestRunReference(run.runId, repository, selected.subject, requestId);
    const response = Response.json({ requestId, runRef, status: "running" });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const expectedError = error instanceof RepositorySelectionError;
    console.error("[redzone:stale-pr] Durable run start failed", {
      requestId,
      repository,
      error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown automation error",
    });
    return Response.json({
      error: expectedError ? error.message : "Could not start the stale pull request workflow.",
      requestId,
    }, { status: expectedError ? 400 : 500 });
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const user = await requireSignedInUser();
  if (!user && githubOAuthConfigured) {
    return Response.json({ error: "Sign in with GitHub to view this automation run." }, { status: 401 });
  }
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) {
    return Response.json({ error: "GitHub App sign-in is not configured." }, { status: 503 });
  }

  const runReference = readStalePullRequestRunReference(request.nextUrl.searchParams.get("runRef"));
  if (!runReference) return Response.json({ error: "This automation run link is invalid or expired." }, { status: 400 });

  try {
    const selected = await getSelectedRepositoryContextForRequest(request);
    if (
      (user && runReference.subject !== user.id) ||
      selected.subject !== runReference.subject ||
      selected.repository !== runReference.repository
    ) {
      return Response.json({ error: "Select the repository used to start this run." }, { status: 403 });
    }

    const run = getRun<StalePullRequestWorkflowResult>(runReference.runId);
    if (!(await run.exists)) return Response.json({ error: "Automation run not found." }, { status: 404 });
    if (request.nextUrl.searchParams.get("events") === "true") {
      const eventStream = run.getReadable<StalePullRequestProgressEvent>().pipeThrough(
        new TransformStream<StalePullRequestProgressEvent, Uint8Array>({
          transform(event, controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          },
        }),
      );
      return new Response(eventStream, {
        headers: {
          "Cache-Control": "private, no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
        },
      });
    }
    const status = await run.status;
    const response = status === "completed"
      ? Response.json({ status, requestId: runReference.requestId, repository: runReference.repository, result: await run.returnValue })
      : status === "failed" || status === "cancelled"
        ? Response.json({ status, requestId: runReference.requestId, error: "The stale pull request workflow did not complete." }, { status: 500 })
        : Response.json({ status: "running", requestId: runReference.requestId });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    console.error("[redzone:stale-pr] Durable run status lookup failed", {
      requestId: runReference.requestId,
      repository: runReference.repository,
      error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown automation error",
    });
    return Response.json({ error: "Could not read the automation run status." }, { status: 500 });
  }
}
