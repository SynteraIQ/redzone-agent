"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { MemoryRecord, MemoryWorkspaceData } from "../../memory.ts";

type MemoryWorkspaceProps = {
  repository: string;
  databaseConfigured: boolean;
};

type MemoryTab = "patterns" | "instructions" | "evidence" | "applied";
type LearnedEvidenceLink = {
  id: string;
  sourceUrl: string;
  source: string;
  author: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  excerpt: string;
};

const tabs: Array<{ id: MemoryTab; label: string; description: string }> = [
  { id: "instructions", label: "Instructions", description: "Explicit review guidance with an identified source." },
  { id: "patterns", label: "Learned patterns", description: "Automatically inferred from review history and outcomes." },
  { id: "evidence", label: "Evidence", description: "Source events that may support or revise a knowledge item." },
  { id: "applied", label: "Usage", description: "Knowledge retrieved for prior analyses." },
];

function isLearnedEvidenceLink(value: unknown): value is LearnedEvidenceLink {
  if (typeof value !== "object" || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return typeof evidence.id === "string" && typeof evidence.sourceUrl === "string" &&
    typeof evidence.source === "string" && typeof evidence.author === "string" &&
    typeof evidence.pullRequestNumber === "number" && typeof evidence.pullRequestTitle === "string" &&
    typeof evidence.excerpt === "string";
}

function MemoryCard({ memory }: { memory: MemoryRecord }) {
  const scope = Object.entries(memory.scope);
  const sourceUrl = typeof memory.content.sourceUrl === "string" ? memory.content.sourceUrl : null;
  const supportingEvidence = Array.isArray(memory.content.evidence)
    ? memory.content.evidence.filter(isLearnedEvidenceLink)
    : [];
  return (
    <article className="memory-card">
      <div className="memory-card-heading">
        <div><span className={`memory-kind memory-kind-${memory.kind}`}>{memory.kind === "semantic" ? "LEARNED PATTERN" : "INSTRUCTION"}</span><h3>{memory.title}</h3></div>
        <span className={`memory-status memory-status-${memory.status}`}>{memory.status}</span>
      </div>
      <p>{memory.summary}</p>
      <div className="memory-meta">
        <span>{memory.evidenceCount} evidence {memory.evidenceCount === 1 ? "record" : "records"}</span>
        {memory.confidence && <span>Confidence {memory.confidence}</span>}
        {memory.authority && <span>Source: {memory.authority}</span>}
        <span>Version {memory.version}</span>
        <span>Updated {new Date(memory.updatedAt).toLocaleDateString()}</span>
      </div>
      {scope.length > 0 && <div className="memory-scope">{scope.map(([key, value]) => <span key={key}><strong>{key}</strong> {String(value)}</span>)}</div>}
      {sourceUrl && <a className="memory-source-link" href={sourceUrl} target="_blank" rel="noreferrer">Open source evidence ↗</a>}
      {supportingEvidence.length > 0 && <div className="memory-evidence-links"><strong>Supporting review feedback</strong>{supportingEvidence.map((evidence) => <article key={evidence.id}><p>“{evidence.excerpt}”</p><span>{evidence.author} · PR #{evidence.pullRequestNumber} · {evidence.source.replaceAll("-", " ")}</span><a href={evidence.sourceUrl} target="_blank" rel="noreferrer">{evidence.pullRequestTitle} ↗</a></article>)}</div>}
    </article>
  );
}

export function MemoryWorkspace({ repository, databaseConfigured }: MemoryWorkspaceProps) {
  const [tab, setTab] = useState<MemoryTab>("instructions");
  const [data, setData] = useState<MemoryWorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [learning, setLearning] = useState(false);
  const [minimumSupportingPullRequests, setMinimumSupportingPullRequests] = useState(2);
  const [learningCoverage, setLearningCoverage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function reloadMemory() {
    const response = await fetch("/api/memory", { cache: "no-store" });
    const payload = await response.json() as MemoryWorkspaceData & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Could not load repository knowledge.");
    setData(payload);
    setError(null);
  }

  useEffect(() => {
    if (!databaseConfigured || repository === "Select a repository") return;
    let cancelled = false;
    setLoading(true);
    reloadMemory()
      .then(() => { if (!cancelled) setError(null); })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load repository knowledge.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [databaseConfigured, repository]);

  async function submitCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setSaving(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: formData.get("title"),
          summary: formData.get("summary"),
          sourceUrl: formData.get("sourceUrl"),
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not save this knowledge candidate.");
      form.reset();
      await reloadMemory();
      setNotice("Candidate saved with its source evidence. Review it before activating.");
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not save this knowledge candidate.");
    } finally {
      setSaving(false);
    }
  }

  async function decideCandidate(id: string, decision: "approve" | "archive") {
    setSaving(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not update this knowledge item.");
      await reloadMemory();
      setNotice(decision === "approve" ? "Knowledge item approved and available to future analyses." : "Candidate archived.");
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not update this knowledge item.");
    } finally {
      setSaving(false);
    }
  }

  async function generateLearnedPatterns() {
    setLearning(true);
    setActionError(null);
    setNotice(null);
    setLearningCoverage(null);
    try {
      const response = await fetch("/api/memory/learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minimumSupportingPullRequests }),
      });
      const result = await response.json() as {
        error?: string;
        message?: string;
        coverage?: {
          pullRequestLimit: number;
          pullRequestsFetched: number;
          mayHaveMorePullRequests: boolean;
          reviewItemsFound: number;
          reviewItemsAnalyzed: number;
          minimumSupportingPullRequests: number;
        };
        evidenceEventsRecorded?: number;
      };
      if (!response.ok) throw new Error(result.error ?? "Could not generate learned patterns.");
      setNotice(result.message ?? "Review-history scan completed.");
      if (result.coverage) {
        setLearningCoverage(
          `Scanned ${result.coverage.pullRequestsFetched} of ${result.coverage.pullRequestLimit} recent PRs; analyzed ${result.coverage.reviewItemsAnalyzed} of ${result.coverage.reviewItemsFound} review items with a ${result.coverage.minimumSupportingPullRequests}-PR evidence threshold.${result.coverage.mayHaveMorePullRequests ? " Older PRs may contain additional evidence." : ""}`,
        );
      }
      await reloadMemory();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not generate learned patterns.");
    } finally {
      setLearning(false);
    }
  }

  const visibleInstructions = useMemo(
    () => data?.memories.filter((item) => item.kind === "procedural") ?? [],
    [data],
  );
  const visiblePatterns = useMemo(
    () => data?.memories.filter((item) => item.kind === "semantic") ?? [],
    [data],
  );

  return (
    <section className="memory-workspace">
      <div className="memory-tabs" role="tablist" aria-label="Knowledge views">
        {tabs.map((item) => <button key={item.id} className={tab === item.id ? "memory-tab active" : "memory-tab"} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      <p className="memory-description">{tabs.find((item) => item.id === tab)?.description}</p>

      {tab === "instructions" && databaseConfigured && repository !== "Select a repository" && <form className="memory-capture-form" onSubmit={submitCandidate}>
        <div><span className="section-kicker">REVIEW GUIDANCE</span><h2>Add a review instruction</h2><p>Write explicit guidance for future analyses and cite its GitHub source. It stays a candidate until a human approves it.</p></div>
        <label>Title<input name="title" required minLength={3} maxLength={240} placeholder="e.g. Keep workflow retries idempotent" /></label>
        <label>Instruction<textarea name="summary" required minLength={10} maxLength={2000} rows={3} placeholder="What should reviewers check, and when does this instruction apply?" /></label>
        <label>GitHub evidence URL<input name="sourceUrl" required type="url" placeholder={`https://github.com/${repository}/pull/123`} /></label>
        <button className="plan-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save candidate"}</button>
      </form>}
      {actionError && <div className="memory-error" role="alert">{actionError}</div>}
      {notice && <div className="memory-notice" role="status">{notice}</div>}

      {!databaseConfigured ? <div className="memory-empty"><h2>PostgreSQL is not configured</h2><p>Add <code>DATABASE_URL</code> to the server environment, then apply the reviewed Drizzle migration to enable persistent knowledge.</p></div>
        : repository === "Select a repository" ? <div className="memory-empty"><h2>Choose a repository</h2><p>Knowledge is scoped to the connected GitHub App installation and selected repository.</p><a href="/repositories">Open Repositories <span>→</span></a></div>
          : loading ? <div className="memory-empty memory-empty-compact"><span className="spinner" /> Loading repository knowledge…</div>
            : error ? <div className="memory-error" role="alert">{error}</div>
              : tab === "patterns" ? <div className="memory-patterns">
                  <div className="memory-pattern-action"><div><h2>Learn from review history</h2><p>Scan recent pull requests for repeated human review guidance. Suggestions stay inactive until approved.</p><label>Minimum supporting PRs<select value={minimumSupportingPullRequests} onChange={(event) => setMinimumSupportingPullRequests(Number(event.target.value))} disabled={learning || saving}><option value={2}>2 PRs</option><option value={3}>3 PRs</option><option value={4}>4 PRs</option><option value={5}>5 PRs</option></select></label></div><button className="plan-button" type="button" disabled={learning || saving} onClick={generateLearnedPatterns}>{learning ? <><span className="spinner" /> Scanning review history…</> : "Generate candidates"}</button></div>
                  {learningCoverage && <p className="memory-description">{learningCoverage}</p>}
                  {visiblePatterns.length ? <div className="memory-list">{visiblePatterns.map((memory) => <div key={memory.id}><MemoryCard memory={memory} />{memory.status === "candidate" && <div className="memory-candidate-actions"><span>Human review required</span><button type="button" disabled={saving || learning} onClick={() => decideCandidate(memory.id, "approve")}>Approve</button><button type="button" disabled={saving || learning} onClick={() => decideCandidate(memory.id, "archive")}>Archive</button></div>}</div>)}</div>
                    : <div className="memory-empty"><h2>No learned patterns yet</h2><p>Run a scan to find recurring guidance in this repository’s recent review history.</p></div>}
                </div>
                : tab === "evidence" ? <div className="memory-event-list">{data?.events.length ? data.events.map((event) => {
                    const body = typeof event.details.body === "string" ? event.details.body : null;
                    const pullRequestNumber = typeof event.details.pullRequestNumber === "number" ? event.details.pullRequestNumber : null;
                    const pullRequestTitle = typeof event.details.pullRequestTitle === "string" ? event.details.pullRequestTitle : null;
                    const decision = typeof event.details.decision === "string" ? event.details.decision : null;
                    return <article className="memory-event" key={event.id}><div><strong>{event.eventType.replaceAll("memory", "knowledge").replaceAll("-", " ")}</strong><span>{event.actorId ?? event.sourceType}{pullRequestNumber ? ` · PR #${pullRequestNumber}` : ` · ${event.sourceId}`}{decision ? ` · ${decision}` : ""}</span>{pullRequestTitle && <small>{pullRequestTitle}</small>}{body && <p className="memory-evidence-quote">“{body}”</p>}</div><time>{new Date(event.occurredAt).toLocaleDateString()}</time>{event.sourceUrl && <a href={event.sourceUrl} target="_blank" rel="noreferrer">Open source ↗</a>}</article>;
                  }) : <div className="memory-empty"><h2>No knowledge events yet</h2><p>Source events will appear here as RedZone begins capturing review decisions and outcomes.</p></div>}</div>
                : tab === "applied" ? <div className="memory-event-list">{data?.applications.length ? data.applications.map((application) => <article className="memory-event memory-application" key={application.id}><div><strong>Analysis {application.analysisId}</strong><span>{application.memories.length} knowledge items used · {application.resultSummary ?? "No result summary recorded"}</span>{application.memories.map((memory) => <small key={memory.memoryId}>{memory.title}: {memory.reason}</small>)}</div><time>{new Date(application.appliedAt).toLocaleDateString()}</time></article>) : <div className="memory-empty"><h2>No knowledge used in analyses yet</h2><p>When an analysis retrieves durable knowledge, its references and rationale will appear here.</p></div>}</div>
                    : visibleInstructions.length ? <div className="memory-list">{visibleInstructions.map((memory) => <div key={memory.id}><MemoryCard memory={memory} />{memory.status === "candidate" && <div className="memory-candidate-actions"><span>Human review required</span><button type="button" disabled={saving} onClick={() => decideCandidate(memory.id, "approve")}>Approve</button><button type="button" disabled={saving} onClick={() => decideCandidate(memory.id, "archive")}>Archive</button></div>}</div>)}</div>
                    : <div className="memory-empty"><h2>No instructions yet</h2><p>Explicit review guidance will appear here after it is submitted and reviewed.</p></div>}
    </section>
  );
}
