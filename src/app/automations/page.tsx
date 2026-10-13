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
import { AutomationWorkspace } from "../ui/automation-workspace";
import { Sidebar } from "../ui/sidebar";

export default async function AutomationsPage() {
  const session = githubOAuthConfigured ? await getServerSession(authOptions) : null;
  const localDeveloperMode = process.env.NODE_ENV !== "production" && process.env.REDZONE_DEV_MODE === "true";
  if (!session && !localDeveloperMode) redirect("/login");
  const cookieStore = await cookies();
  const installationId = session?.user?.id
    ? readInstallationCookie(cookieStore.get(GITHUB_INSTALLATION_COOKIE)?.value, session.user.id)
    : null;
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
        githubAppConnected={Boolean(installationId)}
        activePage="automations"
      />
      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>Automations</strong></div>
          <div className="topbar-right"><span className="live-indicator"><i /> Report-only preview</span><span className="topbar-divider" /><span className="version-label">RED ZONE AGENT</span></div>
        </header>
        <div className="content">
          <div className="page-intro"><div><div className="eyebrow"><span className="eyebrow-line" /> AUTOMATION WORKSPACE</div><h1>Automations</h1><p className="intro-copy">Run bounded workflows against repository activity. Review the evidence before taking action.</p></div></div>
          <AutomationWorkspace
            repository={repository}
            connected={Boolean(installationId)}
            configured={isGitHubAppConfigured()}
          />
          <footer className="page-footer"><span>RED ZONE AGENT</span><span>Automations report evidence; maintainers decide what happens next.</span></footer>
        </div>
      </section>
    </main>
  );
}
