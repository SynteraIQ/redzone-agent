import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions, githubOAuthConfigured } from "../../auth.ts";
import {
  GITHUB_INSTALLATION_COOKIE,
  GITHUB_REPOSITORY_COOKIE,
  isGitHubAppConfigured,
  readInstallationCookie,
  readSelectedRepositoryCookie,
} from "../../github-app.ts";
import { AgentWorkspace } from "../ui/agent-workspace";
import { Sidebar } from "../ui/sidebar";

export default async function AgentsPage() {
  const session = githubOAuthConfigured ? await getServerSession(authOptions) : null;
  const localDeveloperMode = process.env.NODE_ENV !== "production" && process.env.REDZONE_DEV_MODE === "true";
  if (!session && !localDeveloperMode) redirect("/login");
  const cookieStore = await cookies();
  const installationId = session?.user?.id
    ? readInstallationCookie(
      cookieStore.get(GITHUB_INSTALLATION_COOKIE)?.value,
      session.user.id,
    )
    : null;
  const githubAppConnected = Boolean(installationId);
  const repository = session?.user?.id && installationId
    ? readSelectedRepositoryCookie(
      cookieStore.get(GITHUB_REPOSITORY_COOKIE)?.value,
      session.user.id,
      installationId,
    ) ?? "Select a repository"
    : "Select a repository";

  return (
    <main className="app-shell">
      <Sidebar
        repository={repository}
        userName={session?.user?.name ?? null}
        signedIn={Boolean(session)}
        authConfigured={githubOAuthConfigured}
        githubAppConfigured={isGitHubAppConfigured()}
        githubAppConnected={githubAppConnected}
        activePage="agents"
      />
      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>Agents</strong></div>
          <div className="topbar-right"><span className="live-indicator"><i /> Agents ready</span><span className="topbar-divider" /> <span className="version-label">RED ZONE AGENT</span></div>
        </header>
        <div className="content">
          <div className="page-intro">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> AGENT WORKSPACE</div>
              <h1>Meet the agents.</h1>
              <p className="intro-copy">Chat with the Planner or go directly to a specialist. The Planner routes focused requests and synthesizes the specialist’s response.</p>
            </div>
          </div>
          <div className="section-heading"><div><span className="section-kicker">RED ZONE FLEET</span><h2>Choose an agent</h2></div><span className="result-count">4 agents</span></div>
          <AgentWorkspace />
          <footer className="page-footer"><span>RED ZONE AGENT</span><span>Chats use the selected agent’s role and conversation context.</span></footer>
        </div>
      </section>
    </main>
  );
}
