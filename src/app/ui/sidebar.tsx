"use client";

import { signIn } from "next-auth/react";

type SidebarProps = {
  repository: string;
  userName: string | null;
  signedIn: boolean;
  authConfigured: boolean;
  githubAppConfigured: boolean;
  githubAppConnected: boolean;
  activePage: "analysis" | "agents" | "repositories" | "experts" | "automations" | "connections";
};

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
      <div className="workspace-label">WORKSPACE</div>
      <a className="repo-switcher" href="/repositories" aria-label="Choose repository">
        <span className="repo-icon">GH</span>
        <span className="repo-name">{repository}</span>
      </a>
      <nav className="side-nav" aria-label="Main navigation">
        <a className={`nav-item ${activePage === "analysis" ? "active" : "muted"}`} href="/" aria-current={activePage === "analysis" ? "page" : undefined}><span>◈</span> Analysis</a>
        <a className={`nav-item ${activePage === "repositories" ? "active" : "muted"}`} href="/repositories" aria-current={activePage === "repositories" ? "page" : undefined}><span>▤</span> Repositories</a>
        <a className={`nav-item ${activePage === "experts" ? "active" : "muted"}`} href="/experts" aria-current={activePage === "experts" ? "page" : undefined}><span>◎</span> Expert map</a>
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
