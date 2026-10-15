"use client";

import { useEffect, useMemo, useState } from "react";
import type { MemoryRecord, MemoryWorkspaceData } from "../../memory.ts";

type MemoryWorkspaceProps = {
  repository: string;
  databaseConfigured: boolean;
};

type MemoryTab = "all" | "patterns" | "instructions" | "evidence" | "applied";

const tabs: Array<{ id: MemoryTab; label: string; description: string }> = [
  { id: "all", label: "All memory", description: "Durable learned knowledge for this repository." },
  { id: "patterns", label: "Learned patterns", description: "Patterns inferred from review history and outcomes." },
  { id: "instructions", label: "Instructions", description: "Explicit review guidance with an identified source." },
  { id: "evidence", label: "Evidence history", description: "Source events that may support or revise memory." },
  { id: "applied", label: "Used in analysis", description: "Memory retrieved for prior analyses." },
];

function MemoryCard({ memory }: { memory: MemoryRecord }) {
  const scope = Object.entries(memory.scope);
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
    </article>
  );
}

export function MemoryWorkspace({ repository, databaseConfigured }: MemoryWorkspaceProps) {
  const [tab, setTab] = useState<MemoryTab>("all");
  const [data, setData] = useState<MemoryWorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!databaseConfigured || repository === "Select a repository") return;
    let cancelled = false;
    setLoading(true);
    fetch("/api/memory", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as MemoryWorkspaceData & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Could not load repository memory.");
        return payload;
      })
      .then((payload) => { if (!cancelled) { setData(payload); setError(null); } })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load repository memory.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [databaseConfigured, repository]);

  const visibleMemories = useMemo(() => {
    if (!data) return [];
    if (tab === "patterns") return data.memories.filter((memory) => memory.kind === "semantic");
    if (tab === "instructions") return data.memories.filter((memory) => memory.kind === "procedural");
    return data.memories;
  }, [data, tab]);

  return (
    <section className="memory-workspace">
      <div className="memory-tabs" role="tablist" aria-label="Memory type">
        {tabs.map((item) => <button key={item.id} className={tab === item.id ? "memory-tab active" : "memory-tab"} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      <p className="memory-description">{tabs.find((item) => item.id === tab)?.description}</p>

      {!databaseConfigured ? <div className="memory-empty"><h2>PostgreSQL is not configured</h2><p>Add <code>DATABASE_URL</code> to the server environment, then apply the reviewed Drizzle migration to enable persistent memory.</p></div>
        : repository === "Select a repository" ? <div className="memory-empty"><h2>Choose a repository</h2><p>Memory is scoped to the connected GitHub App installation and selected repository.</p><a href="/repositories">Open Repositories <span>→</span></a></div>
          : loading ? <div className="memory-empty memory-empty-compact"><span className="spinner" /> Loading repository memory…</div>
            : error ? <div className="memory-error" role="alert">{error}</div>
              : tab === "evidence" ? <div className="memory-event-list">{data?.events.length ? data.events.map((event) => <article className="memory-event" key={event.id}><div><strong>{event.eventType.replaceAll("-", " ")}</strong><span>{event.sourceType} · {event.sourceId}</span></div><time>{new Date(event.occurredAt).toLocaleDateString()}</time>{event.sourceUrl && <a href={event.sourceUrl} target="_blank" rel="noreferrer">Open evidence ↗</a>}</article>) : <div className="memory-empty"><h2>No learning events yet</h2><p>Source events will appear here as RedZone begins capturing review decisions and outcomes.</p></div>}</div>
                : tab === "applied" ? <div className="memory-event-list">{data?.applications.length ? data.applications.map((application) => <article className="memory-event memory-application" key={application.id}><div><strong>Analysis {application.analysisId}</strong><span>{application.memories.length} memories used · {application.resultSummary ?? "No result summary recorded"}</span>{application.memories.map((memory) => <small key={memory.memoryId}>{memory.title}: {memory.reason}</small>)}</div><time>{new Date(application.appliedAt).toLocaleDateString()}</time></article>) : <div className="memory-empty"><h2>No memory applied yet</h2><p>When an analysis retrieves durable memory, its references and rationale will appear here.</p></div>}</div>
                  : visibleMemories.length ? <div className="memory-list">{visibleMemories.map((memory) => <MemoryCard key={memory.id} memory={memory} />)}</div>
                    : <div className="memory-empty"><h2>{tab === "patterns" ? "No learned patterns yet" : tab === "instructions" ? "No instructions yet" : "No saved memory yet"}</h2><p>RedZone currently builds review context on demand. Persistent memory will appear here once learning events are captured and reviewed.</p></div>}
    </section>
  );
}
