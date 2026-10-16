"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

type RepositoryItem = {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string | null;
};

type RepositoryResponse = {
  repositories?: RepositoryItem[];
  selectedRepository?: string | null;
  error?: string;
};

type SidebarProps = {
  repository: string;
  userName: string | null;
  signedIn: boolean;
  authConfigured: boolean;
  githubAppConfigured: boolean;
  githubAppConnected: boolean;
  activePage: "analysis" | "agents" | "repositories" | "experts" | "automations" | "connections" | "knowledge";
};

type RepositorySwitcherProps = {
  repository: string;
  connected: boolean;
  configured: boolean;
};

function RepositorySwitcher({ repository, connected, configured }: RepositorySwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [selectedRepository, setSelectedRepository] = useState(repository);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedRepository(repository);
  }, [repository]);

  useEffect(() => {
    if (!open || !connected || !configured) return;
    let active = true;
    setLoading(true);
    setError(null);
    fetch("/api/repositories", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as RepositoryResponse;
        if (!response.ok) throw new Error(result.error ?? "Could not load repositories.");
        if (active) {
          setRepositories(result.repositories ?? []);
          setSelectedRepository(result.selectedRepository ?? repository);
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load repositories.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [connected, configured, open, repository]);

  async function selectRepository(fullName: string) {
    setSaving(fullName);
    setError(null);
    try {
      const response = await fetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository: fullName }),
      });
      const result = await response.json() as RepositoryResponse;
      if (!response.ok) throw new Error(result.error ?? "Could not select repository.");
      setSelectedRepository(result.selectedRepository ?? fullName);
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not select repository.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="repo-switcher-wrap">
      <button
        className="repo-switcher"
        type="button"
        aria-label={`Selected repository: ${selectedRepository}. Switch repository`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="repo-icon">GH</span>
        <span className="repo-name">{selectedRepository}</span>
        <span className="repo-caret" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="repo-menu" role="menu" aria-label="Choose repository">
          <div className="repo-menu-heading">SWITCH REPOSITORY</div>
          {!configured ? (
            <p className="repo-menu-message">Configure the GitHub App to load repositories.</p>
          ) : !connected ? (
            <p className="repo-menu-message">Connect the GitHub App to choose a repository.</p>
          ) : loading ? (
            <p className="repo-menu-message"><span className="spinner" /> Loading repositories…</p>
          ) : repositories.length === 0 ? (
            <p className="repo-menu-message">No repositories are available to this installation.</p>
          ) : (
            <div className="repo-menu-list">
              {repositories.map((item) => {
                const selected = item.full_name === selectedRepository;
                return (
                  <button
                    className={`repo-menu-item${selected ? " selected" : ""}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    key={item.id}
                    disabled={saving !== null}
                    onClick={() => void selectRepository(item.full_name)}
                  >
                    <span className="repo-menu-item-name">{item.full_name}</span>
                    <span className="repo-menu-item-state">{saving === item.full_name ? "Saving…" : selected ? "Selected" : ""}</span>
                  </button>
                );
              })}
            </div>
          )}
          {error && <p className="repo-menu-error" role="alert">{error}</p>}
          {!connected && configured && <a className="repo-menu-manage" href="/api/github/install">Connect GitHub App <span>↗</span></a>}
          <a className="repo-menu-manage" href="/repositories">Manage repositories <span>↗</span></a>
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  repository,
  userName,
  signedIn,
  authConfigured,
  githubAppConfigured,
  githubAppConnected,
  activePage,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Red Zone home">
        <span className="brand-mark">R</span>
        <span>redzone<span className="brand-period">.</span></span>
      </a>
      <div className="repository-context-label">CURRENT REPOSITORY</div>
      <RepositorySwitcher repository={repository} connected={githubAppConnected} configured={githubAppConfigured} />
      <div className="workspace-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        <a className={`nav-item ${activePage === "analysis" ? "active" : "muted"}`} href="/" aria-current={activePage === "analysis" ? "page" : undefined}><span>◈</span> Review</a>
        <a className={`nav-item ${activePage === "experts" ? "active" : "muted"}`} href="/experts" aria-current={activePage === "experts" ? "page" : undefined}><span>◎</span> Expert map</a>
        <a className={`nav-item ${activePage === "knowledge" ? "active" : "muted"}`} href="/knowledge" aria-current={activePage === "knowledge" ? "page" : undefined}><span>◉</span> Knowledge</a>
        <a className={`nav-item ${activePage === "automations" ? "active" : "muted"}`} href="/automations" aria-current={activePage === "automations" ? "page" : undefined}><span>↻</span> Automations</a>
        <a className={`nav-item ${activePage === "connections" ? "active" : "muted"}`} href="/connections" aria-current={activePage === "connections" ? "page" : undefined}><span>⌘</span> Connections</a>
        <a className={`nav-item ${activePage === "agents" ? "active" : "muted"}`} href="/agents" aria-current={activePage === "agents" ? "page" : undefined}><span>◇</span> Agents</a>
      </nav>
      <div className="sidebar-bottom">
        <div className="connection-card">
          <span className={`connection-dot${githubAppConnected ? "" : " connection-dot-muted"}`} />
          <div>
            <strong>Repository access</strong>
            <small>{githubAppConnected ? "GitHub App connected" : githubAppConfigured ? "GitHub App not connected" : "GitHub App not configured"}</small>
            {signedIn && githubAppConfigured && (
              <a className="app-connect-link" href="/api/github/install">
                {githubAppConnected ? "Manage access" : "Connect GitHub App"}
              </a>
            )}
          </div>
        </div>
        {signedIn ? (
          <a className="account-button" href="/logout">
            <span className="avatar">{userName?.slice(0, 1).toUpperCase() ?? "U"}</span>
            <span className="account-name">{userName ?? "Signed in"}</span>
            <span className="account-action">Sign out</span>
          </a>
        ) : authConfigured ? (
          <button className="account-button" onClick={() => signIn("github")} type="button">
            <span className="avatar">GH</span><span className="account-name">Sign in with GitHub</span>
          </button>
        ) : (
          <div className="account-button"><span className="avatar">D</span><span className="account-name">Developer session</span></div>
        )}
      </div>
    </aside>
  );
}
