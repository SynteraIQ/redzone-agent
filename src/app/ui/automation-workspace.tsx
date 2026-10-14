"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  StalePullRequestApprovalDecision,
  StalePullRequestProgressEvent,
  StalePullRequestWorkflowResult,
} from "../../automations/stale-pr/workflow.ts";

type AutomationWorkspaceProps = {
  repository: string;
  connected: boolean;
  configured: boolean;
};

type StalePullRequestResponse = StalePullRequestWorkflowResult & {
  repository: string;
  runRef?: string;
  requestId?: string;
  threshold?: number;
  unit?: "hours" | "days";
  includeDrafts?: boolean;
  error?: string;
};

type StalePullRequestRunResponse = {
  requestId?: string;
  runRef?: string;
  status?: "running" | "completed" | "failed" | "cancelled";
  repository?: string;
  result?: StalePullRequestWorkflowResult;
  error?: string;
};

type StalePullRequestApprovalStatus = {
  status: "not-requested" | "pending" | "running" | "completed" | "failed" | "cancelled";
  ready?: boolean;
  approvalRef?: string;
  decision?: StalePullRequestApprovalDecision;
  error?: string;
};

type StalePullRequestApprovalResponse = StalePullRequestApprovalStatus & {
  decision?: StalePullRequestApprovalDecision;
};

type StalePullRequestHistoryRun = {
  runRef: string;
  requestId: string;
  repository: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  threshold: number;
  unit: "hours" | "days";
  includeDrafts: boolean;
  actor: string;
  authentication: "GitHub OAuth" | "Local development mode" | "Not recorded";
};

const stalePullRequestSteps: Array<{
  id: StalePullRequestProgressEvent["stepId"];
  label: string;
}> = [
  { id: "fetch-open-pull-requests", label: "Fetch open pull requests" },
  { id: "apply-staleness-rule", label: "Apply inactivity threshold" },
  { id: "prepare-report", label: "Prepare report" },
];

const POLLING_TIMEOUT_MS = 2 * 60 * 1000;

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 1200);
    function onAbort() {
      window.clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function streamWorkflowProgress(
  runRef: string,
  onProgress: (event: StalePullRequestProgressEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/api/automations/stale-pr?runRef=${encodeURIComponent(runRef)}&events=true`,
    { cache: "no-store", signal },
  );
  if (!response.ok || !response.body) throw new Error("Workflow progress stream unavailable.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      onProgress(JSON.parse(dataLine.slice(5).trim()) as StalePullRequestProgressEvent);
    }
    if (done) return;
  }
}

function updatedDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString() : "Unknown";
}

function runDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Unknown";
}

async function waitForStalePullRequestRun(
  runRef: string,
  signal: AbortSignal,
): Promise<{ requestId?: string; runRef: string; repository: string; result: StalePullRequestWorkflowResult }> {
  while (!signal.aborted) {
    await waitForNextPoll(signal);
    const response = await fetch(
      `/api/automations/stale-pr?runRef=${encodeURIComponent(runRef)}`,
      { cache: "no-store", signal },
    );
    const payload = await response.json().catch(() => null) as StalePullRequestRunResponse | null;
    signal.throwIfAborted();
    if (!payload) throw new Error("Could not read the automation run status.");
    if (!response.ok || payload.status === "failed" || payload.status === "cancelled") {
      const requestReference = payload.requestId ? ` (request ${payload.requestId})` : "";
      throw new Error(`${payload.error ?? "The stale pull request workflow did not complete."}${requestReference}`);
    }
    if (payload.status === "completed") {
      if (payload.result && payload.repository) {
        return { requestId: payload.requestId, runRef, repository: payload.repository, result: payload.result };
      }
      const requestReference = payload.requestId ? ` (request ${payload.requestId})` : "";
      throw new Error(`The workflow completed, but its report data is unavailable. Run it again.${requestReference}`);
    }
  }
  throw new Error("Stopped waiting for the workflow result.");
}

export function AutomationWorkspace({ repository, connected, configured }: AutomationWorkspaceProps) {
  const [inactivityThreshold, setInactivityThreshold] = useState("");
  const [inactivityUnit, setInactivityUnit] = useState<"hours" | "days">("days");
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Partial<Record<StalePullRequestProgressEvent["stepId"], StalePullRequestProgressEvent>>>({});
  const [result, setResult] = useState<StalePullRequestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<StalePullRequestHistoryRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [openingHistoryRunId, setOpeningHistoryRunId] = useState<string | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<StalePullRequestApprovalStatus | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalRationale, setApprovalRationale] = useState("");
  const activeRun = useRef<AbortController | null>(null);
  const reportRef = useRef<HTMLElement | null>(null);

  useEffect(() => () => {
    activeRun.current?.abort();
    activeRun.current = null;
  }, []);

  useEffect(() => {
    if (result) reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  useEffect(() => {
    if (!result?.runRef) {
      setApprovalStatus(null);
      return;
    }
    const reportRunRef = result.runRef;
    const controller = new AbortController();
    async function loadApprovalStatus() {
      setApprovalStatus(null);
      setApprovalError(null);
      setApprovalRationale("");
      try {
        const response = await fetch(`/api/automations/stale-pr/approval?reportRef=${encodeURIComponent(reportRunRef)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as StalePullRequestApprovalStatus | null;
        if (!response.ok || !payload) throw new Error(payload?.error ?? "Could not load the review decision.");
        setApprovalStatus(payload);
      } catch (caught) {
        if (!controller.signal.aborted) setApprovalError(caught instanceof Error ? caught.message : "Could not load the review decision.");
      }
    }
    void loadApprovalStatus();
    return () => controller.abort();
  }, [result?.runRef]);

  useEffect(() => {
    if (
      !result?.runRef || !approvalStatus?.approvalRef ||
      (approvalStatus.status !== "pending" && approvalStatus.status !== "running") || approvalStatus.ready
    ) return;
    const approvalRef = approvalStatus.approvalRef;
    const controller = new AbortController();
    async function waitForApprovalHook() {
      try {
        while (!controller.signal.aborted) {
          await waitForNextPoll(controller.signal);
          const response = await fetch(`/api/automations/stale-pr/approval?approvalRef=${encodeURIComponent(approvalRef)}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const payload = await response.json().catch(() => null) as StalePullRequestApprovalStatus | null;
          if (!response.ok || !payload) throw new Error(payload?.error ?? "Could not check the review step.");
          setApprovalStatus(payload);
          if ((payload.status !== "pending" && payload.status !== "running") || payload.ready) return;
        }
      } catch (caught) {
        if (!controller.signal.aborted) setApprovalError(caught instanceof Error ? caught.message : "Could not check the review step.");
      }
    }
    void waitForApprovalHook();
    return () => controller.abort();
  }, [approvalStatus?.approvalRef, approvalStatus?.ready, approvalStatus?.status, result?.runRef]);

  const refreshHistory = useCallback(async (signal?: AbortSignal) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetch("/api/automations/stale-pr?history=1", {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      const payload = await response.json().catch(() => null) as { runs?: StalePullRequestHistoryRun[]; error?: string } | null;
      if (!response.ok || !payload) throw new Error(payload?.error ?? "Could not load run history.");
      setHistory(payload.runs ?? []);
    } catch (caught) {
      if (!signal?.aborted) setHistoryError(caught instanceof Error ? caught.message : "Could not load run history.");
    } finally {
      if (!signal?.aborted) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!configured || !connected || repository === "Select a repository") {
      setHistory([]);
      setHistoryLoading(false);
      return;
    }
    const controller = new AbortController();
    void refreshHistory(controller.signal);
    return () => controller.abort();
  }, [connected, configured, refreshHistory, repository]);

  async function runStalePullRequestWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const threshold = Number(inactivityThreshold);
    const maximum = inactivityUnit === "hours" ? 365 * 24 : 365;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > maximum) {
      setError(`Choose an inactivity threshold from 1 to ${maximum} ${inactivityUnit}.`);
      return;
    }
    activeRun.current?.abort();
    const controller = new AbortController();
    activeRun.current = controller;
    setOpeningHistoryRunId(null);
    let deadlineTimer: number | undefined;
    let timedOut = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress({});
    try {
      const response = await fetch("/api/automations/stale-pr", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [inactivityUnit === "hours" ? "staleAfterHours" : "staleAfterDays"]: threshold,
          includeDrafts,
        }),
      });
      const payload = await response.json().catch(() => null) as StalePullRequestRunResponse | null;
      controller.signal.throwIfAborted();
      if (!payload) throw new Error("Could not run this automation.");
      if (!response.ok) {
        const requestReference = payload.requestId ? ` (request ${payload.requestId})` : "";
        throw new Error(`${payload.error ?? "Could not run this automation."}${requestReference}`);
      }
      if (!payload.runRef) throw new Error("The automation started without a run reference.");
      deadlineTimer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, POLLING_TIMEOUT_MS);
      try {
        await streamWorkflowProgress(payload.runRef, (event) => {
          setProgress((current) => ({ ...current, [event.stepId]: event }));
        }, controller.signal);
      } catch {
        // Durable status polling below still returns the final report if streaming disconnects.
      }
      controller.signal.throwIfAborted();
      const completed = await waitForStalePullRequestRun(payload.runRef, controller.signal);
      setResult({
        ...completed.result,
        repository: completed.repository,
        runRef: completed.runRef,
        requestId: completed.requestId,
        threshold,
        unit: inactivityUnit,
        includeDrafts,
      });
      void refreshHistory();
    } catch (caught) {
      if (activeRun.current === controller) {
        if (timedOut) {
          setError("The workflow is still running after two minutes. Stopped waiting for its result.");
        } else if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Could not run this automation.");
        }
      }
    } finally {
      window.clearTimeout(deadlineTimer);
      if (activeRun.current === controller) {
        activeRun.current = null;
        setLoading(false);
      }
    }
  }

  async function openHistoryRun(run: StalePullRequestHistoryRun) {
    activeRun.current?.abort();
    const controller = new AbortController();
    activeRun.current = controller;
    let timedOut = false;
    setOpeningHistoryRunId(run.requestId);
    setError(null);
    setInactivityThreshold(String(run.threshold));
    setInactivityUnit(run.unit);
    setIncludeDrafts(run.includeDrafts);
    const deadlineTimer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, POLLING_TIMEOUT_MS);
    try {
      const completed = await waitForStalePullRequestRun(run.runRef, controller.signal);
      setResult({
        ...completed.result,
        repository: completed.repository,
        runRef: completed.runRef,
        requestId: completed.requestId,
        threshold: run.threshold,
        unit: run.unit,
        includeDrafts: run.includeDrafts,
      });
    } catch (caught) {
      if (activeRun.current === controller) {
        if (timedOut) setError("The workflow is still running after two minutes. Stopped waiting for its result.");
        else if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Could not open this run.");
      }
    } finally {
      window.clearTimeout(deadlineTimer);
      if (activeRun.current === controller) {
        activeRun.current = null;
        setOpeningHistoryRunId(null);
      }
    }
  }

  async function requestHumanReview() {
    if (!result?.runRef) return;
    setApprovalLoading(true);
    setApprovalError(null);
    try {
      const response = await fetch("/api/automations/stale-pr/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", reportRef: result.runRef }),
      });
      const payload = await response.json().catch(() => null) as StalePullRequestApprovalResponse | null;
      if (!response.ok || !payload) throw new Error(payload?.error ?? "Could not start the human review step.");
      setApprovalStatus(payload);
    } catch (caught) {
      setApprovalError(caught instanceof Error ? caught.message : "Could not start the human review step.");
    } finally {
      setApprovalLoading(false);
    }
  }

  async function submitHumanDecision(decision: StalePullRequestApprovalDecision["decision"]) {
    if (!approvalStatus?.approvalRef) return;
    if (decision === "rejected" && !approvalRationale.trim()) {
      setApprovalError("Add a short reason when rejecting the report.");
      return;
    }
    setApprovalLoading(true);
    setApprovalError(null);
    try {
      const response = await fetch("/api/automations/stale-pr/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "decision",
          approvalRef: approvalStatus.approvalRef,
          decision,
          ...(approvalRationale.trim() ? { rationale: approvalRationale.trim() } : {}),
        }),
      });
      const payload = await response.json().catch(() => null) as StalePullRequestApprovalResponse | null;
      if (!response.ok || !payload) throw new Error(payload?.error ?? "Could not record the review decision.");
      setApprovalStatus((current) => current ? { ...current, status: "running", ready: true, decision: payload.decision } : current);
    } catch (caught) {
      setApprovalError(caught instanceof Error ? caught.message : "Could not record the review decision.");
    } finally {
      setApprovalLoading(false);
    }
  }

  if (!configured) {
    return <div className="automation-empty"><h2>GitHub App setup needed</h2><p>Configure the GitHub App before running repository automations.</p></div>;
  }
  if (!connected) {
    return <div className="automation-empty"><h2>Connect GitHub to continue</h2><p>Install the RedZone GitHub App on a repository to run automations.</p><a className="plan-button" href="/api/github/install">Connect GitHub App <span>↗</span></a></div>;
  }
  if (repository === "Select a repository") {
    return <div className="automation-empty"><h2>Select a repository</h2><p>Choose the repository where you want to run this automation.</p><a className="plan-button" href="/repositories">Open Repositories <span>↗</span></a></div>;
  }

  return (
    <div className="automation-workspace">
      <div className="automation-template-heading">
        <div><span className="section-kicker">PULL REQUESTS</span><h2>Stale PR report</h2></div>
        <span className="automation-mode">REPORT ONLY</span>
      </div>
      <p className="automation-description">Find open pull requests that have not been updated within your chosen window. This run will not comment, label, assign, or close PRs.</p>
      <form className="automation-config" onSubmit={runStalePullRequestWorkflow}>
        <label className="automation-field"><span>NO UPDATES FOR</span><span className="automation-number"><input type="number" min={1} max={inactivityUnit === "hours" ? 365 * 24 : 365} required value={inactivityThreshold} placeholder="Set amount" onChange={(event) => setInactivityThreshold(event.target.value)} /><select aria-label="Inactivity unit" value={inactivityUnit} onChange={(event) => setInactivityUnit(event.target.value as "hours" | "days")}><option value="hours">hours</option><option value="days">days</option></select></span></label>
        <label className="automation-checkbox"><input type="checkbox" checked={includeDrafts} onChange={(event) => setIncludeDrafts(event.target.checked)} /><span>Include draft pull requests</span></label>
        <button className="plan-button" type="submit" disabled={loading || openingHistoryRunId !== null || inactivityThreshold === ""}>
          {loading ? <><span className="spinner" /> Running workflow</> : <>Run report <span>↗</span></>}
        </button>
      </form>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {loading && <section className="automation-progress" aria-label="Stale PR workflow progress">
        <div className="automation-running" role="status"><span className="spinner" /> Workflow is running</div>
        <ol className="automation-steps">
          {stalePullRequestSteps.map((step) => {
            const update = progress[step.id];
            const status = update?.status ?? "pending";
            const icon = status === "completed" ? "✓" : status === "failed" ? "!" : status === "running" ? "…" : "·";
            return <li key={step.id}><span className={`automation-step-check automation-step-${status}`} aria-label={status}>{icon}</span><div><strong>{step.label}</strong><span>{update?.detail ?? "Waiting for the previous step."}</span></div></li>;
          })}
        </ol>
      </section>}
      <section className="automation-history" aria-label="Recent stale PR runs">
        <div className="automation-history-header"><div><span className="section-kicker">LAST 24 HOURS</span><h3>Recent runs</h3></div><button type="button" onClick={() => void refreshHistory()} disabled={historyLoading}>{historyLoading ? "Refreshing…" : "Refresh"}</button></div>
        {historyError && <div className="error-banner" role="alert">{historyError}</div>}
        {openingHistoryRunId && <p className="automation-history-empty" role="status">Loading report or waiting for this run to finish…</p>}
        {historyLoading && history.length === 0 ? <p className="automation-history-empty">Loading recent runs…</p> : history.length === 0 ? <p className="automation-history-empty">No runs recorded in the available history yet.</p> : (
          <div className="automation-history-list">
            {history.map((run) => (
              <article className="automation-history-row" key={run.requestId}>
                <div className="automation-history-main"><strong>{run.repository}</strong><span>{runDate(run.startedAt)}</span></div>
                <div className="automation-history-meta"><span>{run.threshold} {run.unit} inactive</span><span>{run.includeDrafts ? "Drafts included" : "Drafts excluded"} · by {run.actor} ({run.authentication})</span></div>
                <span className={`automation-history-status status-${run.status}`}>{run.status}</span>
                <button type="button" onClick={() => void openHistoryRun(run)} disabled={loading || openingHistoryRunId !== null || run.status === "failed" || run.status === "cancelled"}>{openingHistoryRunId === run.requestId ? "Loading…" : run.status === "completed" ? "View report" : run.status === "failed" || run.status === "cancelled" ? "Unavailable" : "Resume run"}</button>
              </article>
            ))}
          </div>
        )}
      </section>
      {result && (
        <section ref={reportRef} className="automation-run" aria-label="Stale PR workflow result" tabIndex={-1}>
          <div className="automation-run-header"><div><span className="section-kicker">RUN REPORT · {result.repository}</span><h3>{result.candidates.length} stale {result.candidates.length === 1 ? "pull request" : "pull requests"}</h3></div><span>{result.scannedPullRequestCount} scanned</span></div>
          <ol className="automation-steps">
            {result.steps.map((step) => <li key={step.id}><span className="automation-step-check">✓</span><div><strong>{step.id.replaceAll("-", " ")}</strong><span>{step.detail}</span></div></li>)}
          </ol>
          {result.trustRecord && <details className="automation-trust-record">
            <summary><span>Run trust record</span><span>Scope documented · evidence linked</span></summary>
            <div className="automation-trust-grid">
              <div><span>REQUESTED BY</span><strong>{result.trustRecord.actor}</strong><small>{result.trustRecord.authentication}</small></div>
              <div><span>RUN TIME</span><strong>{runDate(result.trustRecord.requestedAt)}</strong><small>{result.trustRecord.repository}</small></div>
              <div><span>CONFIGURATION</span><strong>{result.trustRecord.inactivityThreshold} without updates</strong><small>{result.trustRecord.includeDrafts ? "Drafts included" : "Drafts excluded"}</small></div>
              <div><span>ACCESS BOUNDARY</span><strong>Installation token scoped to this repository</strong><small>{result.trustRecord.permissions.join(" · ") || "No GitHub API access used"}</small></div>
            </div>
            <div className="automation-trust-section"><strong>Decision rule</strong><p>{result.trustRecord.decisionRule}</p></div>
            <div className="automation-trust-section"><strong>Evidence</strong><p>{result.trustRecord.coverage} {result.candidates.length} matched pull requests are listed below with links to their GitHub records and update dates.</p></div>
            <div className="automation-trust-section"><strong>Actions</strong><p>{result.trustRecord.writesPerformed ? "GitHub changes were made during this run." : "No GitHub changes were made during this run."}</p></div>
            <div className="automation-trust-section"><strong>Limits</strong><ul>{result.trustRecord.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div>
          </details>}
          <section className="automation-human-review" aria-label="Human review decision">
            <div><span className="section-kicker">HUMAN REVIEW</span><h4>Review decision</h4></div>
            <p>This decision is saved in a durable workflow for this report. It records review feedback only; no GitHub changes are made.</p>
            {approvalError && <div className="error-banner" role="alert">{approvalError}</div>}
            {!approvalStatus || approvalStatus.status === "not-requested" ? (
              <button className="plan-button" type="button" onClick={() => void requestHumanReview()} disabled={approvalLoading || !result.runRef}>
                {approvalLoading ? "Starting review…" : "Start human review"}
              </button>
            ) : approvalStatus.decision ? (
              <div className={`automation-review-decision decision-${approvalStatus.decision.decision}`} role="status">
                <strong>{approvalStatus.decision.decision === "approved" ? "Report confirmed" : "Report flagged"}</strong>
                <span>by {approvalStatus.decision.actor} · {runDate(approvalStatus.decision.decidedAt)}</span>
                {approvalStatus.decision.rationale && <p>{approvalStatus.decision.rationale}</p>}
              </div>
            ) : approvalStatus.status === "pending" || approvalStatus.status === "running" ? (
              <div className="automation-review-pending">
                <span>{approvalStatus.ready ? "This workflow is waiting for your decision." : "Preparing the durable review step…"}</span>
                {approvalStatus.ready && <>
                  <label className="automation-review-rationale"><span>REASON · REQUIRED TO FLAG</span><textarea value={approvalRationale} maxLength={500} onChange={(event) => setApprovalRationale(event.target.value)} placeholder="Add context for the next reviewer" /></label>
                  <div className="automation-review-actions">
                    <button type="button" onClick={() => void submitHumanDecision("approved")} disabled={approvalLoading}>{approvalLoading ? "Saving…" : "Confirm report"}</button>
                    <button type="button" onClick={() => void submitHumanDecision("rejected")} disabled={approvalLoading || !approvalRationale.trim()}>{approvalLoading ? "Saving…" : "Flag report"}</button>
                  </div>
                </>}
              </div>
            ) : <div className="error-banner" role="alert">This review workflow {approvalStatus.status}.</div>}
          </section>
          {result.candidates.length > 0 ? (
            <div className="stale-pr-list">
              {result.candidates.map((candidate) => (
                <article className="stale-pr-card" key={candidate.number}>
                  <div><a href={`https://github.com/${result.repository}/pull/${candidate.number}`} target="_blank" rel="noreferrer">#{candidate.number} {candidate.title}</a><span>by @{candidate.author}{candidate.draft ? " · draft" : ""}</span></div>
                  <div className="stale-pr-age"><strong>{(result.unit ?? inactivityUnit) === "hours" || candidate.hoursSinceUpdate < 24 ? candidate.hoursSinceUpdate : candidate.daysSinceUpdate}</strong><span>{(result.unit ?? inactivityUnit) === "hours" || candidate.hoursSinceUpdate < 24 ? "hours since update" : "days since update"}</span><small>Updated {updatedDate(candidate.updatedAt)}</small></div>
                </article>
              ))}
            </div>
          ) : <div className="automation-empty automation-empty-compact">No open pull requests meet this inactivity threshold.</div>}
          <p className="automation-note">“Stale” means the pull request’s GitHub <code>updated_at</code> is older than the selected threshold. It does not mean the PR is abandoned.</p>
        </section>
      )}
    </div>
  );
}
