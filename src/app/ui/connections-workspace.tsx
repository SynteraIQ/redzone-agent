"use client";

import { useState } from "react";
import type { SlackConnectionStatus } from "../../connections/slack.ts";

type ConnectionsWorkspaceProps = {
  githubConnected: boolean;
  githubConfigured: boolean;
  slackConfigured: boolean;
};

export function ConnectionsWorkspace({ githubConnected, githubConfigured, slackConfigured }: ConnectionsWorkspaceProps) {
  const [slackStatus, setSlackStatus] = useState<SlackConnectionStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verifySlack() {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch("/api/connections/slack", { method: "POST", cache: "no-store" });
      const status = await response.json() as SlackConnectionStatus & { error?: string };
      if (!response.ok && status.state !== "failed") {
        throw new Error(status.error ?? "Could not verify the Slack connection.");
      }
      setSlackStatus(status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not verify the Slack connection.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="connections-workspace" aria-label="Connected services">
      <article className="connection-integration-card">
        <div className="connection-integration-icon github-integration-icon" aria-hidden="true">GH</div>
        <div className="connection-integration-copy">
          <div className="connection-integration-heading"><h2>GitHub App</h2><span className={`connection-state ${githubConnected ? "connection-state-ready" : ""}`}>{githubConnected ? "Connected" : githubConfigured ? "Not connected" : "Not configured"}</span></div>
          <p>Repository access for RedZone analysis. The GitHub App installation grants repository permissions; GitHub sign-in identifies the person using the app.</p>
          <a href="/repositories" className="connection-secondary-link">Manage repository access <span>→</span></a>
        </div>
      </article>

      <article className="connection-integration-card">
        <div className="connection-integration-icon slack-integration-icon" aria-hidden="true">S</div>
        <div className="connection-integration-copy">
          <div className="connection-integration-heading"><h2>Slack workspace</h2><span className={`connection-state ${slackStatus?.state === "connected" ? "connection-state-ready" : ""}`}>{slackStatus?.state === "connected" ? "Connected" : slackStatus?.state === "failed" ? "Needs attention" : slackConfigured ? "Ready to verify" : "Not configured"}</span></div>
          <p>One shared Slack workspace connection for this RedZone deployment, managed by Vercel Connect. This prototype verifies access with Slack’s read-only authentication check; no messages are sent.</p>
          {slackStatus?.state === "connected" && <div className="connection-metadata"><strong>{slackStatus.workspace}</strong><span>Workspace {slackStatus.workspaceId}</span><span>Authorized as {slackStatus.actor}</span></div>}
          {slackStatus && slackStatus.state !== "connected" && <p className="connection-feedback" role="status">{slackStatus.message}</p>}
          {error && <p className="connection-feedback connection-feedback-error" role="alert">{error}</p>}
          <button className="plan-button connection-verify-button" type="button" onClick={verifySlack} disabled={checking}>
            {checking ? <><span className="spinner" /> Checking connection</> : <>Verify Slack connection <span>↗</span></>}
          </button>
          <div className="connection-setup-note"><strong>Setup</strong><span><strong>Local development:</strong> <code>vercel link</code> associates this local folder with a Vercel project. Then create and authorize the connector with <code>vercel connect create slack --name redzone-slack</code>, attach it to the project with <code>vercel connect attach slack/redzone-slack --environment development</code>, and run <code>vercel env pull .env.local</code>. Set <code>VERCEL_CONNECT_SLACK_CONNECTOR=redzone-slack</code> in <code>.env.local</code>. <strong>Production:</strong> Attach the connector to the project’s Production environment with <code>vercel connect attach slack/redzone-slack --environment production</code> and set <code>VERCEL_CONNECT_SLACK_CONNECTOR=redzone-slack</code> in that environment’s variables. Redeploy to apply the configuration.</span></div>
        </div>
      </article>

      <div className="connection-trust-note"><span className="connection-trust-icon">✓</span><div><strong>Credentials are separate from agent authority</strong><p>Vercel Connect supplies the credential. RedZone still decides which tools an agent may call, what permissions to request, and when a human must approve an action. This first slice is shared at the deployment level; tenant-specific connections need an organization model and installation mapping.</p></div></div>
    </section>
  );
}
