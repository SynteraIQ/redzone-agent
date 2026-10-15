import { randomUUID } from "node:crypto";
import { getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { authOptions, githubOAuthConfigured } from "../../../../auth.ts";
import { getSelectedRepositoryContextForRequest, RepositorySelectionError } from "../../../../github-app.ts";
import {
  createStalePullRequestRunReference,
  createStalePullRequestSubjectKey,
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

function toIsoTimestamp(value: unknown): string {
  const timestamp = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";
}

type StalePullRequestRunMetadata = {
  runId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  attributes: Record<string, string>;
  startedAt?: unknown;
  createdAt: unknown;
};

async function listStalePullRequestRuns(
  subject: string,
  repository: string,
) {
  const world = await getWorld();
  const attributes = { automation: "stale-pr", subject, repository };
  if (world.analytics) {
    const page = await world.analytics.runs.list({
      attributes,
      pagination: { limit: 20, sortOrder: "desc" },
    });
    return page.data;
  }

  const matchingRuns: StalePullRequestRunMetadata[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await world.runs.list({
      pagination: { cursor, limit: 100, sortOrder: "desc" },
      resolveData: "none",
    });
    matchingRuns.push(...page.data.filter((run) =>
      run.attributes.automation === attributes.automation &&
      run.attributes.subject === attributes.subject &&
      run.attributes.repository === attributes.repository,
    ));
    if (matchingRuns.length >= 20 || !page.cursor) break;
    cursor = page.cursor;
  }
  return matchingRuns.slice(0, 20);
}

async function requireSignedInUser(): Promise<{ id: string; actor: string } | null> {
  const session = await getServerSession(authOptions);
  if (githubOAuthConfigured && !session?.user?.id) return null;
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) return null;
  return session?.user?.id ? {
    id: session.user.id,
    actor: session.user.name?.trim().slice(0, 100) || "GitHub user",
  } : null;
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
    const selected = await getSelectedRepositoryContextForRequest(request);
    repository = selected.repository;

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
      actor: user?.actor ?? "Local development user",
      authentication: user ? "GitHub OAuth" : "Local development mode",
      startedAt: new Date().toISOString(),
      requestId,
    }], {
      attributes: {
        automation: "stale-pr",
        subject: createStalePullRequestSubjectKey(selected.subject),
        repository,
        requestId,
        threshold: String("staleAfterHours" in parsed.data ? parsed.data.staleAfterHours : parsed.data.staleAfterDays),
        unit: "staleAfterHours" in parsed.data ? "hours" : "days",
        includeDrafts: String(parsed.data.includeDrafts),
        actor: user?.actor ?? "Local development user",
        authentication: user ? "GitHub OAuth" : "Local development mode",
      },
    });
    const runRef = createStalePullRequestRunReference(run.runId, repository, selected.subject, requestId);
    const response = Response.json({ requestId, runRef, status: "running" });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const expectedError = error instanceof RepositorySelectionError;
    const errorMessage = error instanceof Error ? error.message : "Could not start the stale pull request workflow.";
    console.error("[redzone:stale-pr] Durable run start failed", {
      requestId,
      repository,
      error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown automation error",
    });
    return Response.json({
      error: expectedError ? errorMessage : "Could not start the stale pull request workflow.",
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

  if (request.nextUrl.searchParams.get("history") === "1") {
    try {
      const selected = await getSelectedRepositoryContextForRequest(request);
      if (user && selected.subject !== user.id) {
        return Response.json({ error: "Select the repository connected to your GitHub account." }, { status: 403 });
      }
      const recentRuns = await listStalePullRequestRuns(
        createStalePullRequestSubjectKey(selected.subject),
        selected.repository,
      );
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const runs = recentRuns.flatMap((run) => {
        const attributes = run.attributes;
        const threshold = Number(attributes.threshold);
        const unit = attributes.unit;
        const requestId = attributes.requestId;
        if (
          !Number.isInteger(threshold) || threshold < 1 ||
          (unit !== "hours" && unit !== "days") ||
          typeof requestId !== "string" || !requestId
        ) return [];
        const startedAt = toIsoTimestamp(run.startedAt ?? run.createdAt);
        if (Date.parse(startedAt) < oneDayAgo) return [];
        return [{
          runRef: createStalePullRequestRunReference(run.runId, selected.repository, selected.subject, requestId),
          requestId,
          repository: selected.repository,
          status: run.status,
          startedAt,
          threshold,
          unit,
          includeDrafts: attributes.includeDrafts === "true",
          actor: attributes.actor || "Not recorded",
          authentication: attributes.authentication === "GitHub OAuth"
            ? "GitHub OAuth"
            : attributes.authentication === "Local development mode"
              ? "Local development mode"
              : "Not recorded",
        }];
      });
      const response = Response.json({ runs });
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    } catch (error) {
      console.error("[redzone:stale-pr] Run history lookup failed", {
        error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown automation error",
      });
      return Response.json({ error: "Could not load stale pull request run history." }, { status: 500 });
    }
  }

  const runReference = readStalePullRequestRunReference(request.nextUrl.searchParams.get("runRef"));
  if (!runReference || runReference.kind !== "report") {
    return Response.json({ error: "This automation run link is invalid or expired." }, { status: 400 });
  }

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
