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
import { isSlackConnectionConfigured } from "../../connections/slack.ts";
import { ConnectionsWorkspace } from "../ui/connections-workspace.tsx";
import { Sidebar } from "../ui/sidebar.tsx";

export default async function ConnectionsPage() {
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
        activePage="connections"
      />
      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>Connections</strong></div>
          <div className="topbar-right"><span className="live-indicator"><i /> Credential boundary</span><span className="topbar-divider" /><span className="version-label">RED ZONE PLATFORM</span></div>
        </header>
        <div className="content">
          <div className="page-intro"><div><div className="eyebrow"><span className="eyebrow-line" /> IDENTITY AND TRUST</div><h1>Connections with clear boundaries.</h1><p className="intro-copy">Connect external tools through Vercel Connect. RedZone requests credentials on the server only when needed and never sends them to the browser or an agent prompt.</p></div></div>
          <ConnectionsWorkspace
            githubConnected={Boolean(installationId)}
            githubConfigured={isGitHubAppConfigured()}
            slackConfigured={isSlackConnectionConfigured()}
          />
          <footer className="page-footer"><span>RED ZONE PLATFORM</span><span>Connection credentials authorize access; RedZone policy controls agent actions.</span></footer>
        </div>
      </section>
    </main>
  );
}
