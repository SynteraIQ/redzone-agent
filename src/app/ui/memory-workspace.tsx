"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { MemoryRecord, MemoryWorkspaceData } from "../../memory.ts";

type MemoryWorkspaceProps = {
  repository: string;
  databaseConfigured: boolean;
};

type MemoryTab = "all" | "patterns" | "instructions" | "evidence" | "applied";

const tabs: Array<{ id: MemoryTab; label: string; description: string }> = [
  { id: "all", label: "All knowledge", description: "Repository-specific knowledge, with its sources and status." },
  { id: "patterns", label: "Learned patterns", description: "Patterns inferred from review history and outcomes." },
  { id: "instructions", label: "Instructions", description: "Explicit review guidance with an identified source." },
  { id: "evidence", label: "Evidence history", description: "Source events that may support or revise a knowledge item." },
  { id: "applied", label: "Used in analysis", description: "Knowledge retrieved for prior analyses." },
];

function MemoryCard({ memory }: { memory: MemoryRecord }) {
  const scope = Object.entries(memory.scope);
  const sourceUrl = typeof memory.content.sourceUrl === "string" ? memory.content.sourceUrl : null;
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
    </article>
  );
}

export function MemoryWorkspace({ repository, databaseConfigured }: MemoryWorkspaceProps) {
  const [tab, setTab] = useState<MemoryTab>("all");
  const [data, setData] = useState<MemoryWorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
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
          kind: formData.get("kind"),
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

  const visibleMemories = useMemo(() => {
    if (!data) return [];
    if (tab === "patterns") return data.memories.filter((memory) => memory.kind === "semantic");
    if (tab === "instructions") return data.memories.filter((memory) => memory.kind === "procedural");
    return data.memories;
  }, [data, tab]);

  return (
    <section className="memory-workspace">
      <div className="memory-tabs" role="tablist" aria-label="Knowledge type">
        {tabs.map((item) => <button key={item.id} className={tab === item.id ? "memory-tab active" : "memory-tab"} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      <p className="memory-description">{tabs.find((item) => item.id === tab)?.description}</p>

      {databaseConfigured && repository !== "Select a repository" && <form className="memory-capture-form" onSubmit={submitCandidate}>
        <div><span className="section-kicker">CAPTURE REPOSITORY KNOWLEDGE</span><h2>Propose knowledge</h2><p>Record a reusable pattern or instruction with a GitHub source. It stays a candidate until a human approves it.</p></div>
        <label>Knowledge type<select name="kind" defaultValue="semantic"><option value="semantic">Learned pattern</option><option value="procedural">Review instruction</option></select></label>
        <label>Title<input name="title" required minLength={3} maxLength={240} placeholder="e.g. Keep workflow retries idempotent" /></label>
        <label>Knowledge<textarea name="summary" required minLength={10} maxLength={2000} rows={3} placeholder="What should future analyses learn, and when does it apply?" /></label>
        <label>GitHub evidence URL<input name="sourceUrl" required type="url" placeholder={`https://github.com/${repository}/pull/123`} /></label>
        <button className="plan-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save candidate"}</button>
      </form>}
      {actionError && <div className="memory-error" role="alert">{actionError}</div>}
      {notice && <div className="memory-notice" role="status">{notice}</div>}

      {!databaseConfigured ? <div className="memory-empty"><h2>PostgreSQL is not configured</h2><p>Add <code>DATABASE_URL</code> to the server environment, then apply the reviewed Drizzle migration to enable persistent knowledge.</p></div>
        : repository === "Select a repository" ? <div className="memory-empty"><h2>Choose a repository</h2><p>Knowledge is scoped to the connected GitHub App installation and selected repository.</p><a href="/repositories">Open Repositories <span>→</span></a></div>
          : loading ? <div className="memory-empty memory-empty-compact"><span className="spinner" /> Loading repository knowledge…</div>
            : error ? <div className="memory-error" role="alert">{error}</div>
              : tab === "evidence" ? <div className="memory-event-list">{data?.events.length ? data.events.map((event) => <article className="memory-event" key={event.id}><div><strong>{event.eventType.replaceAll("memory", "knowledge").replaceAll("-", " ")}</strong><span>{event.sourceType} · {event.sourceId}</span></div><time>{new Date(event.occurredAt).toLocaleDateString()}</time>{event.sourceUrl && <a href={event.sourceUrl} target="_blank" rel="noreferrer">Open evidence ↗</a>}</article>) : <div className="memory-empty"><h2>No knowledge events yet</h2><p>Source events will appear here as RedZone begins capturing review decisions and outcomes.</p></div>}</div>
                : tab === "applied" ? <div className="memory-event-list">{data?.applications.length ? data.applications.map((application) => <article className="memory-event memory-application" key={application.id}><div><strong>Analysis {application.analysisId}</strong><span>{application.memories.length} knowledge items used · {application.resultSummary ?? "No result summary recorded"}</span>{application.memories.map((memory) => <small key={memory.memoryId}>{memory.title}: {memory.reason}</small>)}</div><time>{new Date(application.appliedAt).toLocaleDateString()}</time></article>) : <div className="memory-empty"><h2>No knowledge used in analyses yet</h2><p>When an analysis retrieves durable knowledge, its references and rationale will appear here.</p></div>}</div>
                    : visibleMemories.length ? <div className="memory-list">{visibleMemories.map((memory) => <div key={memory.id}><MemoryCard memory={memory} />{memory.status === "candidate" && <div className="memory-candidate-actions"><span>Human review required</span><button type="button" disabled={saving} onClick={() => decideCandidate(memory.id, "approve")}>Approve</button><button type="button" disabled={saving} onClick={() => decideCandidate(memory.id, "archive")}>Archive</button></div>}</div>)}</div>
                    : <div className="memory-empty"><h2>{tab === "patterns" ? "No learned patterns yet" : tab === "instructions" ? "No instructions yet" : "No saved knowledge yet"}</h2><p>RedZone currently builds review context on demand. Persistent knowledge will appear here once knowledge events are captured and reviewed.</p></div>}
    </section>
  );
}
