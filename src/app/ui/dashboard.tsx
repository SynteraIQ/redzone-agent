"use client";

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { DefaultChatTransport } from "ai";
import { useChat } from "@ai-sdk/react";
import { signIn, signOut } from "next-auth/react";
import ReactMarkdown from "react-markdown";

type DashboardProps = {
  repository: string;
  initialBaseRef: string;
  userName: string | null;
  signedIn: boolean;
  authConfigured: boolean;
};

export function Dashboard({ repository, initialBaseRef, userName, signedIn, authConfigured }: DashboardProps) {
  const [baseRef, setBaseRef] = useState(initialBaseRef);
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/analyze" }), []);
  const { messages, sendMessage, status, error } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

  async function runAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendMessage({ text: `Analyze the current change against ${baseRef.trim()}` }, {
      body: { baseRef: baseRef.trim() },
    });
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Red Zone home">
          <span className="brand-mark">R</span>
          <span>redzone<span className="brand-period">.</span></span>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <button className="repo-switcher" type="button">
          <span className="repo-icon">GH</span>
          <span className="repo-name">{repository}</span>
          <span className="chevron">⌄</span>
        </button>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="nav-item active" href="#analysis"><span>◈</span> Analysis</a>
          <a className="nav-item muted" href="#evidence"><span>◎</span> Historical evidence</a>
          <a className="nav-item muted" href="#coverage"><span>▤</span> Source coverage</a>
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
              <p className="intro-copy">Red Zone finds prior review concerns in the code your team is changing today.</p>
            </div>
            <div className="intro-mark" aria-hidden="true"><span>R</span><i /><i /><i /></div>
          </div>

          <form className="analysis-card" onSubmit={runAnalysis}>
            <div className="card-topline"><div><span className="card-icon">⌘</span><strong>Analyze current change</strong></div><span className="local-badge"><i /> {authConfigured && !signedIn ? "SIGN IN REQUIRED" : "READY TO RUN"}</span></div>
            <p>Compare this checkout with a base branch. The agent checks Git history and prior GitHub review evidence.</p>
            <div className="analysis-controls">
              <label className="branch-field"><span>BASE BRANCH</span><div><span className="branch-glyph">⑂</span><input aria-label="Base branch" value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="main" /></div></label>
              <button className="run-button" type="submit" disabled={busy || (authConfigured && !signedIn) || !baseRef.trim()}>
                {busy ? <><span className="spinner" /> Analyzing</> : <>Run analysis <span>↗</span></>}
              </button>
            </div>
            {authConfigured && !signedIn && <div className="auth-note">Sign in with Google to run an analysis. <button type="button" onClick={() => signIn("google")}>Continue with Google <span>→</span></button></div>}
            {!authConfigured && <div className="helper-note">Local developer mode · Configure Google OAuth before production deployment.</div>}
          </form>

          <section className="results-section" id="evidence">
            <div className="section-heading"><div><span className="section-kicker">LATEST RUN</span><h2>Analysis results</h2></div><span className="result-count">{messages.filter((message) => message.role === "assistant").length} reports</span></div>
            {error && <div className="error-banner"><strong>Analysis failed</strong><span>{error.message}</span></div>}
            {messages.filter((message) => message.role === "assistant").length === 0 && !busy ? (
              <div className="empty-state"><div className="empty-icon">⌁</div><strong>No analysis yet</strong><span>Run the agent to see a risk assessment with linked historical evidence.</span></div>
            ) : (
              <div className="reports-list">
                {messages.filter((message) => message.role === "assistant").map((message) => {
                  const report = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
                  return <article className="report-card" key={message.id}><div className="report-card-header"><span className="report-status"><i /> ANALYSIS COMPLETE</span><span className="report-id">RUN {message.id.slice(0, 8).toUpperCase()}</span></div><div className="report-markdown"><ReactMarkdown>{report}</ReactMarkdown></div></article>;
                })}
                {busy && <div className="running-card"><span className="spinner" /> Reading repository history and review evidence…</div>}
              </div>
            )}
          </section>
          <footer className="page-footer"><span>RED ZONE AGENT</span><span>Historical review concerns are signals, not proof of production incidents.</span></footer>
        </div>
      </section>
    </main>
  );
}
