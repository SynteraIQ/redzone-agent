import { getRun, getHookByToken, resumeHook, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { z } from "zod";
import { authOptions, githubOAuthConfigured } from "../../../../../auth.ts";
import { getSelectedRepositoryContextForRequest } from "../../../../../github-app.ts";
import { createStalePullRequestApprovalToken } from "../../../../../automations/stale-pr/approval-token.ts";
import {
  createStalePullRequestRunReference,
  createStalePullRequestSubjectKey,
  readStalePullRequestRunReference,
} from "../../../../../automations/stale-pr/run-reference.ts";
import {
  waitForStalePullRequestApproval,
  type StalePullRequestApprovalWorkflowResult,
} from "../../../../../automations/stale-pr/workflow.ts";

export const runtime = "nodejs";

const ApprovalRequestSchema = z.object({ action: z.literal("request"), reportRef: z.string().min(1) }).strict();
const ApprovalDecisionSchema = z.object({
  action: z.literal("decision"),
  approvalRef: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  rationale: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && !value.rationale) {
    context.addIssue({ code: "custom", path: ["rationale"], message: "Add a short reason when rejecting the report." });
  }
});

type StalePullRequestApprovalRunMetadata = {
  runId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  attributes: Record<string, string>;
};

function workflowFailureDetail(value: unknown): { name?: string; message: string } | undefined {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "string") return { message: value };
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const message = typeof record.message === "string" ? record.message : undefined;
  return message ? { ...(name ? { name } : {}), message } : undefined;
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

async function findApprovalRun(
  subject: string,
  repository: string,
  reportRunId: string,
): Promise<StalePullRequestApprovalRunMetadata | null> {
  const world = await getWorld();
  const filters = {
    automation: "stale-pr-approval",
    subject,
    repository,
    reportRunId,
  };
  if (world.analytics) {
    const page = await world.analytics.runs.list({
      attributes: filters,
      pagination: { limit: 1, sortOrder: "desc" },
    });
    return page.data[0] ?? null;
  }

  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await world.runs.list({
      pagination: { cursor, limit: 100, sortOrder: "desc" },
      resolveData: "none",
    });
    const match = page.data.find((run) =>
      run.attributes.automation === filters.automation &&
      run.attributes.subject === filters.subject &&
      run.attributes.repository === filters.repository &&
      run.attributes.reportRunId === filters.reportRunId,
    );
    if (match) return match;
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return null;
}

function runReferenceMatchesUser(
  runReference: NonNullable<ReturnType<typeof readStalePullRequestRunReference>>,
  selected: { repository: string; subject: string },
  user: { id: string } | null,
): boolean {
  return runReference.repository === selected.repository &&
    runReference.subject === selected.subject &&
    (!user || runReference.subject === user.id);
}

async function approvalStatus(
  runId: string,
  runReference: Pick<NonNullable<ReturnType<typeof readStalePullRequestRunReference>>, "repository" | "subject" | "requestId">,
): Promise<Response> {
  const run = getRun<StalePullRequestApprovalWorkflowResult>(runId);
  if (!(await run.exists)) return Response.json({ error: "Approval run not found." }, { status: 404 });
  const status = await run.status;
  if (status === "failed" || status === "cancelled") {
    let failure: { name?: string; message: string } | undefined;
    if (status === "failed") {
      try {
        const workflowRun = await (await getWorld()).runs.get(runId, { resolveData: "all" });
        failure = workflowFailureDetail(workflowRun.error);
      } catch (error) {
        console.error("[redzone:stale-pr] Could not read approval workflow failure details", {
          runId,
          error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown error",
        });
      }
    }
    console.error("[redzone:stale-pr] Approval workflow reached a terminal error state", {
      runId,
      status,
      ...(failure ? { failure } : {}),
    });
    return Response.json({ status, error: "The review decision could not be recorded." }, { status: 500 });
  }
  if (status === "completed") {
    const result = await run.returnValue;
    if ("approvalRunId" in result) return approvalStatus(result.approvalRunId, runReference);
    return Response.json({ status, approvalRef: createStalePullRequestRunReference(
      runId,
      runReference.repository,
      runReference.subject,
      runReference.requestId,
      "approval",
    ), decision: {
      decision: result.decision,
      actor: result.actor,
      decidedAt: result.decidedAt,
      ...(result.rationale ? { rationale: result.rationale } : {}),
    } });
  }

  let ready = false;
  try {
    const hook = await getHookByToken(createStalePullRequestApprovalToken(runReference.requestId));
    if (hook.runId !== runId) return approvalStatus(hook.runId, runReference);
    ready = hook.runId === runId;
  } catch {
    ready = false;
  }
  return Response.json({
    status,
    ready,
    approvalRef: createStalePullRequestRunReference(
      runId,
      runReference.repository,
      runReference.subject,
      runReference.requestId,
      "approval",
    ),
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const user = await requireSignedInUser();
  if (!user && githubOAuthConfigured) return Response.json({ error: "Sign in with GitHub to review this report." }, { status: 401 });
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) return Response.json({ error: "GitHub App sign-in is not configured." }, { status: 503 });

  try {
    const selected = await getSelectedRepositoryContextForRequest(request);
    if (user && selected.subject !== user.id) return Response.json({ error: "Select the repository connected to your GitHub account." }, { status: 403 });
    const approvalRef = readStalePullRequestRunReference(request.nextUrl.searchParams.get("approvalRef"));
    if (approvalRef) {
      if (approvalRef.kind !== "approval" || !runReferenceMatchesUser(approvalRef, selected, user)) {
        return Response.json({ error: "Select the repository used to request this review." }, { status: 403 });
      }
      const response = await approvalStatus(approvalRef.runId, approvalRef);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }

    const reportRef = readStalePullRequestRunReference(request.nextUrl.searchParams.get("reportRef"));
    if (!reportRef || reportRef.kind !== "report" || !runReferenceMatchesUser(reportRef, selected, user)) {
      return Response.json({ error: "This report reference is invalid or unavailable." }, { status: 400 });
    }
    const reportRun = getRun(reportRef.runId);
    if (!(await reportRun.exists) || (await reportRun.status) !== "completed") {
      return Response.json({ error: "The report must finish before it can be reviewed." }, { status: 409 });
    }
    const approvalRun = await findApprovalRun(
      createStalePullRequestSubjectKey(reportRef.subject),
      reportRef.repository,
      reportRef.runId,
    );
    if (!approvalRun) {
      const response = Response.json({ status: "not-requested" });
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
    const approvalReference = {
      repository: reportRef.repository,
      subject: reportRef.subject,
      requestId: approvalRun.attributes.approvalRequestId ?? reportRef.requestId,
    };
    const response = await approvalStatus(approvalRun.runId, approvalReference);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    console.error("[redzone:stale-pr] Approval status lookup failed", {
      error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown approval error",
    });
    return Response.json({ error: "Could not read the report review status." }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const user = await requireSignedInUser();
  if (!user && githubOAuthConfigured) return Response.json({ error: "Sign in with GitHub to review this report." }, { status: 401 });
  if (process.env.NODE_ENV === "production" && !githubOAuthConfigured) return Response.json({ error: "GitHub App sign-in is not configured." }, { status: 503 });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const requestSchema = z.union([ApprovalRequestSchema, ApprovalDecisionSchema]);
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid review request." }, { status: 400 });

  try {
    const selected = await getSelectedRepositoryContextForRequest(request);
    if (user && selected.subject !== user.id) return Response.json({ error: "Select the repository connected to your GitHub account." }, { status: 403 });
    const subjectKey = createStalePullRequestSubjectKey(selected.subject);

    if (parsed.data.action === "request") {
      const reportReference = readStalePullRequestRunReference(parsed.data.reportRef);
      if (!reportReference || reportReference.kind !== "report" || !runReferenceMatchesUser(reportReference, selected, user)) {
        return Response.json({ error: "This report reference is invalid or unavailable." }, { status: 400 });
      }
      const reportRun = getRun(reportReference.runId);
      if (!(await reportRun.exists) || (await reportRun.status) !== "completed") {
        return Response.json({ error: "The report must finish before it can be reviewed." }, { status: 409 });
      }
      let approvalRun = await findApprovalRun(subjectKey, reportReference.repository, reportReference.runId);
      if (approvalRun?.status === "failed" || approvalRun?.status === "cancelled") {
        console.info("[redzone:stale-pr] Restarting terminal approval workflow", {
          previousRunId: approvalRun.runId,
          previousStatus: approvalRun.status,
          reportRunId: reportReference.runId,
          repository: reportReference.repository,
        });
        approvalRun = null;
      }
      if (!approvalRun) {
        // Hook registration arbitrates concurrent starts for the same report.
        const approvalRequestId = reportReference.runId;
        const requestedAt = new Date().toISOString();
        const started = await start(waitForStalePullRequestApproval, [{
          reportRunId: reportReference.runId,
          reportRequestId: reportReference.requestId,
          repository: reportReference.repository,
          approvalRequestId,
          requestedBy: user?.actor ?? "Local development user",
          requestedAt,
        }], {
          attributes: {
            automation: "stale-pr-approval",
            subject: subjectKey,
            repository: reportReference.repository,
            reportRunId: reportReference.runId,
            reportRequestId: reportReference.requestId,
            approvalRequestId,
            requestedBy: user?.actor ?? "Local development user",
          },
        });
        approvalRun = {
          runId: started.runId,
          status: "pending",
          attributes: {
            automation: "stale-pr-approval",
            subject: subjectKey,
            repository: reportReference.repository,
            reportRunId: reportReference.runId,
            reportRequestId: reportReference.requestId,
            approvalRequestId,
          },
        };
      }
      const approvalReference = {
        repository: reportReference.repository,
        subject: selected.subject,
        requestId: approvalRun.attributes.approvalRequestId ?? reportReference.requestId,
      };
      const response = await approvalStatus(approvalRun.runId, approvalReference);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }

    const approvalReference = readStalePullRequestRunReference(parsed.data.approvalRef);
    if (!approvalReference || approvalReference.kind !== "approval" || !runReferenceMatchesUser(approvalReference, selected, user)) {
      return Response.json({ error: "This review reference is invalid or unavailable." }, { status: 400 });
    }
    const approvalRun = getRun<StalePullRequestApprovalWorkflowResult>(approvalReference.runId);
    if (!(await approvalRun.exists)) return Response.json({ error: "Review request not found." }, { status: 404 });
    const status = await approvalRun.status;
    if (status !== "pending" && status !== "running") {
      return Response.json({ error: "This review request already has a decision." }, { status: 409 });
    }
    const decision = {
      decision: parsed.data.decision,
      actor: user?.actor ?? "Local development user",
      decidedAt: new Date().toISOString(),
      ...(parsed.data.rationale ? { rationale: parsed.data.rationale } : {}),
    } as const;
    const token = createStalePullRequestApprovalToken(approvalReference.requestId);
    try {
      const hook = await getHookByToken(token);
      if (hook.runId !== approvalReference.runId) {
        return Response.json({ error: "Review step not ready." }, { status: 409 });
      }
    } catch {
      return Response.json({ error: "Review step not ready." }, { status: 409 });
    }
    await resumeHook(token, decision);
    const response = Response.json({ status: "running", ready: true, decision });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown approval error";
    console.error("[redzone:stale-pr] Approval request failed", {
      error: error instanceof Error ? { name: error.name, message: detail } : detail,
    });
    const message = process.env.NODE_ENV === "production"
      ? "Could not start or record the review decision."
      : `Could not start or record the review decision: ${detail}`;
    return Response.json({ error: message }, { status: 500 });
  }
}
