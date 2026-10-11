"use client";

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { DefaultChatTransport } from "ai";
import { useChat } from "@ai-sdk/react";
import ReactMarkdown from "react-markdown";
import { signIn } from "next-auth/react";
import { AGENT_CATALOG } from "../../agent-catalog.ts";
import { SpecialistAgentIdSchema } from "../../analysis-plan.ts";
import type { AnalysisPlanPreview, SpecialistAgentId } from "../../analysis-plan.ts";
import type { AnalysisProgressEvent, AnalysisUIMessage } from "../../analysis-progress.ts";
import { Sidebar } from "./sidebar";

type DashboardProps = {
  repository: string;
  initialBaseRef: string;
  userName: string | null;
  signedIn: boolean;
  authConfigured: boolean;
};

function getProgressEvents(message: AnalysisUIMessage): AnalysisProgressEvent[] {
  const latestByStage = new Map<string, AnalysisProgressEvent>();
  for (const part of message.parts) {
    if (part.type === "data-analysisProgress") {
      latestByStage.set(part.data.stage, part.data);
    }
  }
  return [...latestByStage.values()];
}

export function Dashboard({ repository, initialBaseRef, userName, signedIn, authConfigured }: DashboardProps) {
  const [baseRef, setBaseRef] = useState(initialBaseRef);
  const [plan, setPlan] = useState<AnalysisPlanPreview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [pullRequestUrl, setPullRequestUrl] = useState("");
  const [posting, setPosting] = useState(false);
  const [postFeedback, setPostFeedback] = useState<{ kind: "success" | "error"; message: string; url?: string } | null>(null);
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/analyze" }), []);
  const { messages, sendMessage, status, error } = useChat<AnalysisUIMessage>({ transport });
  const busy = status === "submitted" || status === "streaming";
  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant");
  const latestReport = latestAssistantMessage?.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("") ?? "";
  const canPost = !posting && !busy && !(authConfigured && !signedIn) && Boolean(latestReport.trim() && pullRequestUrl.trim());

  async function runAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan?.hasChanges) return;
    setPostFeedback(null);
    await sendMessage({ text: `Analyze the current change against ${baseRef.trim()}` }, {
      body: {
        baseRef: plan.baseRef,
        snapshotFingerprint: plan.snapshotFingerprint,
        approvedAgentIds: plan.selectedAgentIds,
      },
    });
  }

  async function postSummary(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPost) return;
    setPostFeedback(null);
    setPosting(true);
    try {
      const response = await fetch("/api/github-comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pullRequestUrl: pullRequestUrl.trim(), summary: latestReport }),
      });
      const result = await response.json() as { commentUrl?: string; error?: string };
      if (!response.ok || !result.commentUrl) {
        throw new Error(result.error ?? "Could not post the summary.");
      }
      setPostFeedback({ kind: "success", message: "Summary posted to the pull request.", url: result.commentUrl });
    } catch (postError) {
      setPostFeedback({
        kind: "error",
        message: postError instanceof Error ? postError.message : "Could not post the summary.",
      });
    } finally {
      setPosting(false);
    }
  }

  async function createPlan() {
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    try {
      const response = await fetch("/api/analyze/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRef: baseRef.trim() }),
      });
      const result = await response.json() as AnalysisPlanPreview & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not create an analysis plan.");
      setPlan(result);
    } catch (caught) {
      setPlanError(caught instanceof Error ? caught.message : "Could not create an analysis plan.");
    } finally {
      setPlanning(false);
    }
  }

  function togglePlannedAgent(agentId: SpecialistAgentId) {
    setPlan((current) => {
      if (!current || agentId === "change-scope-agent") return current;
      const selectedAgentIds = current.selectedAgentIds.includes(agentId)
        ? current.selectedAgentIds.filter((selected) => selected !== agentId)
        : [...current.selectedAgentIds, agentId];
      return { ...current, selectedAgentIds };
    });
  }

  const availableAgentIds = new Set<string>(plan?.availableAgentIds ?? []);

  return (
    <main className="app-shell">
      <Sidebar repository={repository} userName={userName} signedIn={signedIn} authConfigured={authConfigured} activePage="analysis" />

      <section className="main-panel" id="analysis">
        <header className="topbar">
          <div className="breadcrumb"><span>Repositories</span><span className="crumb-slash">/</span><strong>{repository}</strong></div>
          <div className="topbar-right"><span className="live-indicator"><i /> Agent ready</span><span className="topbar-divider" /> <span className="version-label">RED ZONE AGENT</span></div>
        </header>

        <div className="content">
          <div className="page-intro">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> HISTORICAL CODE RISK</div>
              <h1>Catch the change<br />that looks familiar.</h1>
              <p className="intro-copy">Red Zone maps TypeScript dependencies and checks whether earlier reviews or rollbacks touched related code.</p>
            </div>
            <div className="intro-mark" aria-hidden="true"><span>R</span><i /><i /><i /></div>
          </div>

          <form className="analysis-card" onSubmit={runAnalysis}>
            <div className="card-topline"><div><span className="card-icon">⌘</span><strong>Analyze current change</strong></div><span className="local-badge"><i /> {authConfigured && !signedIn ? "SIGN IN REQUIRED" : "READY TO RUN"}</span></div>
            <p>Plan the review first. Red Zone checks the current diff, dependency impact, Git history, and prior GitHub reviews before you approve which agents to run.</p>
            <div className="analysis-controls">
              <label className="branch-field"><span>BASE BRANCH</span><div><span className="branch-glyph">⑂</span><input aria-label="Base branch" value={baseRef} onChange={(event) => { setBaseRef(event.target.value); setPlan(null); setPlanError(null); }} placeholder="main" /></div></label>
              <button className="plan-button" type="button" onClick={createPlan} disabled={busy || planning || (authConfigured && !signedIn) || !baseRef.trim()}>
                {planning ? <><span className="spinner" /> Planning</> : <>Plan review <span>↗</span></>}
              </button>
              <button className="run-button" type="submit" disabled={busy || planning || (authConfigured && !signedIn) || !plan?.hasChanges || plan.selectedAgentIds.length === 0}>
                {busy ? <><span className="spinner" /> Running</> : <>Run approved plan <span>↗</span></>}
              </button>
            </div>
            {authConfigured && !signedIn && <div className="auth-note">Sign in with Google to run an analysis. <button type="button" onClick={() => signIn("google")}>Continue with Google <span>→</span></button></div>}
            {!authConfigured && <div className="helper-note">Local developer mode · Configure Google OAuth before production deployment.</div>}
            {planError && <div className="plan-error" role="alert">{planError}</div>}
          </form>

          {plan && <section className="plan-preview" aria-live="polite">
            <div className="plan-preview-header">
              <div><span className="section-kicker">REVIEW PLAN</span><h2>{plan.hasChanges ? "Approve the checks" : "No changes to analyze"}</h2></div>
              {plan.hasChanges && <span className="plan-file-count">{plan.changedFiles.length} changed {plan.changedFiles.length === 1 ? "file" : "files"}</span>}
            </div>
            {plan.hasChanges ? <>
              <p className="plan-rationale">{plan.rationale}</p>
              <div className="plan-evidence-summary">
                <span><strong>{plan.impact.directDependents}</strong> direct dependents</span>
                <span><strong>{plan.impact.transitiveDependents}</strong> transitive dependents</span>
                <span><strong>{plan.rollbackEvidenceCount}</strong> rollback signals</span>
                <span><strong>{plan.reviewEvidenceCount}</strong> prior review records</span>
              </div>
              {plan.impact.status === "skipped" && <p className="plan-impact-note">{plan.impact.note}</p>}
              <div className="planned-agents">
                {AGENT_CATALOG.filter((agent) => agent.id !== "red-zone-agent").map((agent) => {
                  const agentId = SpecialistAgentIdSchema.parse(agent.id);
                  const available = availableAgentIds.has(agentId);
                  const selected = plan.selectedAgentIds.includes(agentId);
                  const required = agentId === "change-scope-agent";
                  const unavailableReason = agentId === "rollback-history-agent"
                    ? "No overlapping rollback or mitigation signal was found in Git history."
                    : agentId === "review-context-agent"
                      ? "No overlapping prior review records were found."
                      : "";
                  return <label className={`planned-agent ${selected ? "selected" : ""}`} key={agent.id}>
                    <input type="checkbox" checked={selected} disabled={required || !available} onChange={() => togglePlannedAgent(agentId)} />
                    <span className="planned-agent-copy"><strong>{agent.name}</strong><small>{available ? agent.description : unavailableReason}</small></span>
                    <span className="planned-agent-state">{!available ? "SKIPPED · NO EVIDENCE" : required ? "REQUIRED" : selected ? "IN PLAN" : "OPTIONAL"}</span>
                  </label>;
                })}
              </div>
              <details className="planned-files"><summary>Changed files</summary><ul>{plan.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details>
            </> : <p className="plan-rationale">{plan.rationale}</p>}
          </section>}

          <section className="results-section" id="evidence">
            <div className="section-heading"><div><span className="section-kicker">LATEST RUN</span><h2>Analysis results</h2></div><span className="result-count">{messages.filter((message) => message.role === "assistant").length} reports</span></div>
            {error && <div className="error-banner"><strong>Analysis failed</strong><span>{error.message}</span></div>}
            {messages.filter((message) => message.role === "assistant").length === 0 && !busy ? (
              <div className="empty-state"><div className="empty-icon">⌁</div><strong>No analysis yet</strong><span>Run the agent to see its live activity and risk assessment.</span></div>
            ) : (
              <div className="reports-list">
                {messages.filter((message) => message.role === "assistant").map((message) => {
                  const report = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
                  const progress = getProgressEvents(message);
                  const isLatestRun = message.id === latestAssistantMessage?.id;
                  const runFailed = progress.some((event) => event.stage === "analysis" && event.status === "failed");
                  const runActive = busy && isLatestRun;
                  return (
                    <article className="report-card" key={message.id}>
                      <div className={`report-card-header ${runActive ? "in-progress" : runFailed ? "failed" : ""}`}>
                        <span className="report-status"><i /> {runActive ? "ANALYSIS IN PROGRESS" : runFailed ? "ANALYSIS FAILED" : "ANALYSIS COMPLETE"}</span>
                        <span className="report-id">RUN {message.id.slice(0, 8).toUpperCase()}</span>
                      </div>
                      {progress.length > 0 && (
                        <div className="agent-timeline" aria-live={runActive ? "polite" : undefined}>
                          {progress.map((event) => (
                            <div className={`agent-timeline-step ${event.status}`} key={event.stage}>
                              <span className="agent-timeline-icon" aria-hidden="true">
                                {event.status === "running" ? <span className="spinner" /> : event.status === "completed" ? "✓" : event.status === "skipped" ? "–" : "!"}
                              </span>
                              <div className="agent-timeline-content">
                                <strong>{event.label}</strong>
                                {event.detail && <span>{event.detail}</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {report && <div className="report-markdown"><ReactMarkdown>{report}</ReactMarkdown></div>}
                    </article>
                  );
                })}
                {busy && !latestAssistantMessage && <div className="running-card"><span className="spinner" /><div><strong>Starting analysis</strong><span>Waiting for the first progress event.</span></div></div>}
              </div>
            )}
            <form className="github-publish" onSubmit={postSummary}>
              <div className="github-publish-copy">
                <strong>Share this review on GitHub</strong>
                <span>Post the latest Red Zone report as a PR summary comment.</span>
              </div>
              <div className="github-publish-controls">
                <input
                  type="url"
                  aria-label="GitHub pull request URL"
                  value={pullRequestUrl}
                  onChange={(event) => { setPullRequestUrl(event.target.value); setPostFeedback(null); }}
                  placeholder="https://github.com/owner/repo/pull/123"
                  maxLength={512}
                  required
                  disabled={posting}
                />
                <button type="submit" disabled={!canPost}>
                  {posting ? "Posting…" : <>Post summary <span>↗</span></>}
                </button>
              </div>
              {postFeedback && (
                <div className={`github-publish-feedback ${postFeedback.kind}`} role={postFeedback.kind === "error" ? "alert" : "status"}>
                  {postFeedback.url
                    ? <><span>{postFeedback.message}</span> <a href={postFeedback.url} target="_blank" rel="noreferrer">View comment</a></>
                    : postFeedback.message}
                </div>
              )}
            </form>
          </section>
          <footer className="page-footer"><span>RED ZONE AGENT</span><span>Historical review concerns are signals, not proof of production incidents.</span></footer>
        </div>
      </section>
    </main>
  );
}
