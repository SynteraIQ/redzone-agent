"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { StalePullRequestWorkflowResult } from "../../automations/stale-pr/workflow.ts";

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

function waitForNextPoll(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 1200));
}

function updatedDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString() : "Unknown";
}

export function AutomationWorkspace({ repository, connected, configured }: AutomationWorkspaceProps) {
  const [staleAfterDays, setStaleAfterDays] = useState("");
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<StalePullRequestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runStalePullRequestWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const threshold = Number(staleAfterDays);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 365) {
      setError("Choose an inactivity threshold from 1 to 365 days.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/automations/stale-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staleAfterDays: threshold, includeDrafts }),
      });
      const payload = await response.json().catch(() => null) as StalePullRequestRunResponse | null;
      if (!payload) throw new Error("Could not run this automation.");
      if (!response.ok) {
        const requestReference = payload.requestId ? ` (request ${payload.requestId})` : "";
        throw new Error(`${payload.error ?? "Could not run this automation."}${requestReference}`);
      }
      if (!payload.runRef) throw new Error("The automation started without a run reference.");
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
        <label className="automation-field"><span>NO ACTIVITY FOR</span><span className="automation-number"><input type="number" min={1} max={365} required value={staleAfterDays} placeholder="Set days" onChange={(event) => setStaleAfterDays(event.target.value)} /><span>days</span></span></label>
        <label className="automation-checkbox"><input type="checkbox" checked={includeDrafts} onChange={(event) => setIncludeDrafts(event.target.checked)} /><span>Include draft pull requests</span></label>
        <button className="plan-button" type="submit" disabled={loading || staleAfterDays === ""}>
          {loading ? <><span className="spinner" /> Running workflow</> : <>Run report <span>↗</span></>}
        </button>
      </form>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {loading && <div className="automation-running" role="status"><span className="spinner" /> Fetching open pull requests and applying the staleness rule…</div>}
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
                  <div className="stale-pr-age"><strong>{candidate.daysSinceUpdate}</strong><span>days since update</span><small>Updated {updatedDate(candidate.updatedAt)}</small></div>
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
