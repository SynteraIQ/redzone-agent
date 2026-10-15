"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type RepositoryItem = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch: string | null;
};

type RepositoryResponse = {
  repositories?: RepositoryItem[];
  selectedRepository?: string | null;
  error?: string;
};

type RepositoriesWorkspaceProps = {
  connected: boolean;
  configured: boolean;
  initialSelection: string | null;
};

export function RepositoriesWorkspace({ connected, configured, initialSelection }: RepositoriesWorkspaceProps) {
  const router = useRouter();
  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [selectedRepository, setSelectedRepository] = useState(initialSelection);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected || !configured) return;
    let active = true;
    setLoading(true);
    fetch("/api/repositories", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as RepositoryResponse;
        if (!response.ok) throw new Error(result.error ?? "Could not load repositories.");
        if (active) {
          setRepositories(result.repositories ?? []);
          setSelectedRepository(result.selectedRepository ?? null);
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load repositories.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [connected, configured]);

  const filteredRepositories = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return repositories;
    return repositories.filter((repository) => repository.full_name.toLowerCase().includes(query));
  }, [repositories, search]);
  async function selectRepository(repository: RepositoryItem) {
    setSaving(repository.full_name);
    setError(null);
    try {
      const response = await fetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository: repository.full_name }),
      });
      const result = await response.json() as RepositoryResponse;
      if (!response.ok) throw new Error(result.error ?? "Could not select repository.");
      setSelectedRepository(result.selectedRepository ?? repository.full_name);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not select repository.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="repository-workspace">
      {!configured ? (
        <div className="repository-empty"><h2>GitHub App setup needed</h2><p>Configure the GitHub App credentials before loading repositories.</p></div>
      ) : !connected ? (
        <div className="repository-empty"><h2>Connect GitHub to continue</h2><p>Install the RedZone GitHub App, then choose a repository here.</p><a className="plan-button" href="/api/github/install">Connect GitHub App <span>↗</span></a></div>
      ) : (
        <>
          <div className="repository-list-header">
            <div><span className="section-kicker">GITHUB APP INSTALLATION</span><h2>Choose a repository</h2></div>
            <label className="repository-search"><span>FILTER</span><input aria-label="Filter repositories" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="owner/repository" /></label>
          </div>
          <p className="repository-help">Select a repository RedZone can access through the GitHub App. The selection is saved to your account and used for analysis.</p>
          {error && <div className="plan-error" role="alert">{error}</div>}
          {loading ? <div className="repository-empty">Loading repositories…</div> : filteredRepositories.length === 0 ? (
            <div className="repository-empty">{repositories.length === 0 ? "No repositories are available to this GitHub App installation." : "No repositories match your filter."}</div>
          ) : (
            <div className="repository-list">
              {filteredRepositories.map((repository) => {
                const selected = selectedRepository === repository.full_name;
                return (
                  <article className={`repository-row${selected ? " repository-row-selected" : ""}`} key={repository.id}>
                    <div className="repository-row-icon">GH</div>
                    <div className="repository-row-info">
                      <strong>{repository.full_name}</strong>
                      <span>{repository.private ? "Private" : "Public"}{repository.default_branch ? ` · Default branch ${repository.default_branch}` : ""}</span>
                    </div>
                    <button className={selected ? "repository-selected-button" : "repository-select-button"} type="button" disabled={selected || saving !== null} onClick={() => selectRepository(repository)}>
                      {saving === repository.full_name ? "Saving…" : selected ? "Selected" : "Select"}
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
