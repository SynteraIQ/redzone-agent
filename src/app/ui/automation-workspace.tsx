"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type {
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
  requestId?: string;
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

const stalePullRequestSteps: Array<{
  id: StalePullRequestProgressEvent["stepId"];
  label: string;
}> = [
  { id: "fetch-open-pull-requests", label: "Fetch open pull requests" },
  { id: "apply-staleness-rule", label: "Apply inactivity threshold" },
  { id: "prepare-report", label: "Prepare report" },
];

function waitForNextPoll(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 1200));
}

async function streamWorkflowProgress(
  runRef: string,
  onProgress: (event: StalePullRequestProgressEvent) => void,
): Promise<void> {
  const response = await fetch(
    `/api/automations/stale-pr?runRef=${encodeURIComponent(runRef)}&events=true`,
    { cache: "no-store" },
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

export function AutomationWorkspace({ repository, connected, configured }: AutomationWorkspaceProps) {
  const [inactivityThreshold, setInactivityThreshold] = useState("");
  const [inactivityUnit, setInactivityUnit] = useState<"hours" | "days">("days");
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Partial<Record<StalePullRequestProgressEvent["stepId"], StalePullRequestProgressEvent>>>({});
  const [result, setResult] = useState<StalePullRequestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runStalePullRequestWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const threshold = Number(inactivityThreshold);
    const maximum = inactivityUnit === "hours" ? 365 * 24 : 365;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > maximum) {
      setError(`Choose an inactivity threshold from 1 to ${maximum} ${inactivityUnit}.`);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress({});
    try {
      const response = await fetch("/api/automations/stale-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [inactivityUnit === "hours" ? "staleAfterHours" : "staleAfterDays"]: threshold,
          includeDrafts,
        }),
      });
      const payload = await response.json().catch(() => null) as StalePullRequestRunResponse | null;
      if (!payload) throw new Error("Could not run this automation.");
      if (!response.ok) {
        const requestReference = payload.requestId ? ` (request ${payload.requestId})` : "";
        throw new Error(`${payload.error ?? "Could not run this automation."}${requestReference}`);
      }
      if (!payload.runRef) throw new Error("The automation started without a run reference.");
      try {
        await streamWorkflowProgress(payload.runRef, (event) => {
          setProgress((current) => ({ ...current, [event.stepId]: event }));
        });
      } catch {
        // Durable status polling below still returns the final report if streaming disconnects.
      }
      while (true) {
        await waitForNextPoll();
        const statusResponse = await fetch(
          `/api/automations/stale-pr?runRef=${encodeURIComponent(payload.runRef)}`,
          { cache: "no-store" },
        );
        const status = await statusResponse.json().catch(() => null) as StalePullRequestRunResponse | null;
        if (!status) throw new Error("Could not read the automation run status.");
        if (!statusResponse.ok || status.status === "failed" || status.status === "cancelled") {
          const requestReference = status.requestId ? ` (request ${status.requestId})` : "";
          throw new Error(`${status.error ?? "The stale pull request workflow did not complete."}${requestReference}`);
        }
        if (status.status === "completed" && status.result && status.repository) {
          setResult({ ...status.result, repository: status.repository, requestId: status.requestId });
          break;
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not run this automation.");
    } finally {
      setLoading(false);
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
        <button className="plan-button" type="submit" disabled={loading || inactivityThreshold === ""}>
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
      {result && (
        <section className="automation-run" aria-label="Stale PR workflow result">
          <div className="automation-run-header"><div><span className="section-kicker">LATEST RUN · {result.repository}</span><h3>{result.candidates.length} stale {result.candidates.length === 1 ? "pull request" : "pull requests"}</h3></div><span>{result.scannedPullRequestCount} scanned</span></div>
          <ol className="automation-steps">
            {result.steps.map((step) => <li key={step.id}><span className="automation-step-check">✓</span><div><strong>{step.id.replaceAll("-", " ")}</strong><span>{step.detail}</span></div></li>)}
          </ol>
          {result.candidates.length > 0 ? (
            <div className="stale-pr-list">
              {result.candidates.map((candidate) => (
                <article className="stale-pr-card" key={candidate.number}>
                  <div><a href={`https://github.com/${result.repository}/pull/${candidate.number}`} target="_blank" rel="noreferrer">#{candidate.number} {candidate.title}</a><span>by @{candidate.author}{candidate.draft ? " · draft" : ""}</span></div>
                  <div className="stale-pr-age"><strong>{candidate.hoursSinceUpdate < 24 ? candidate.hoursSinceUpdate : candidate.daysSinceUpdate}</strong><span>{candidate.hoursSinceUpdate < 24 ? "hours since update" : "days since update"}</span><small>Updated {updatedDate(candidate.updatedAt)}</small></div>
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
