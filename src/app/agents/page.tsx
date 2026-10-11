import { basename } from "node:path";
import { getServerSession } from "next-auth";
import { authOptions, googleCredentialsConfigured } from "../../auth.ts";
import { AgentWorkspace } from "../ui/agent-workspace";
import { Sidebar } from "../ui/sidebar";

export default async function AgentsPage() {
  const session = googleCredentialsConfigured ? await getServerSession(authOptions) : null;
  const repositoryPath = process.env.REDZONE_REPOSITORY_PATH?.trim();
  const repository = process.env.GH_REPO ?? (repositoryPath ? basename(repositoryPath) : "Set GH_REPO to show repository");

  return (
    <main className="app-shell">
      <Sidebar
        repository={repository}
        userName={session?.user?.name ?? null}
        signedIn={Boolean(session)}
        authConfigured={googleCredentialsConfigured}
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
