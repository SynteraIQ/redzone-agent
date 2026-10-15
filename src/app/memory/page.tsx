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
import { MemoryWorkspace } from "../ui/memory-workspace.tsx";
import { Sidebar } from "../ui/sidebar.tsx";

export default async function MemoryPage() {
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
        activePage="memory"
      />
      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>Memory</strong></div>
          <div className="topbar-right"><span className="live-indicator"><i /> Evidence store</span><span className="topbar-divider" /><span className="version-label">RED ZONE AGENT</span></div>
        </header>
        <div className="content">
          <div className="page-intro"><div><div className="eyebrow"><span className="eyebrow-line" /> LEARNED REPOSITORY CONTEXT</div><h1>Memory with evidence.</h1><p className="intro-copy">Inspect what RedZone learns, the history behind it, and what it used in each analysis.</p></div></div>
          <MemoryWorkspace repository={repository} databaseConfigured={Boolean(process.env.DATABASE_URL?.trim())} />
          <footer className="page-footer"><span>RED ZONE AGENT</span><span>Learned patterns remain traceable to their source evidence.</span></footer>
        </div>
      </section>
    </main>
  );
}
