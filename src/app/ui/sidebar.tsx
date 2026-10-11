"use client";

import { signIn, signOut } from "next-auth/react";

type SidebarProps = {
  repository: string;
  userName: string | null;
  signedIn: boolean;
  authConfigured: boolean;
  activePage: "analysis" | "agents";
};

export function Sidebar({ repository, userName, signedIn, authConfigured, activePage }: SidebarProps) {
  return (
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Red Zone home">
        <span className="brand-mark">R</span>
        <span>redzone<span className="brand-period">.</span></span>
      </a>
      <div className="workspace-label">WORKSPACE</div>
      <div className="repo-switcher">
        <span className="repo-icon">GH</span>
        <span className="repo-name">{repository}</span>
      </div>
      <nav className="side-nav" aria-label="Main navigation">
        <a className={`nav-item ${activePage === "analysis" ? "active" : "muted"}`} href="/" aria-current={activePage === "analysis" ? "page" : undefined}><span>◈</span> Analysis</a>
        <a className={`nav-item ${activePage === "agents" ? "active" : "muted"}`} href="/agents" aria-current={activePage === "agents" ? "page" : undefined}><span>◇</span> Agents</a>
      </nav>
      <div className="sidebar-bottom">
        <div className="connection-card">
          <span className="connection-dot" />
          <div><strong>{authConfigured ? "Google sign-in" : "Local demo mode"}</strong><small>{authConfigured ? "OAuth configured" : "OAuth not configured"}</small></div>
        </div>
        {signedIn ? (
          <button className="account-button" onClick={() => signOut()} type="button">
            <span className="avatar">{userName?.slice(0, 1).toUpperCase() ?? "U"}</span>
            <span className="account-name">{userName ?? "Signed in"}</span>
            <span className="account-action">Sign out</span>
          </button>
        ) : authConfigured ? (
          <button className="account-button" onClick={() => signIn("google")} type="button">
            <span className="avatar">G</span><span className="account-name">Sign in with Google</span>
          </button>
        ) : (
          <div className="account-button"><span className="avatar">D</span><span className="account-name">Developer session</span></div>
        )}
      </div>
    </aside>
  );
}
