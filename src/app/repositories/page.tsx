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
import { RepositoriesWorkspace } from "../ui/repositories-workspace";
import { Sidebar } from "../ui/sidebar";

export default async function RepositoriesPage() {
  const session = githubOAuthConfigured ? await getServerSession(authOptions) : null;
  const localDeveloperMode = process.env.NODE_ENV !== "production" && process.env.REDZONE_DEV_MODE === "true";
  if (!session && !localDeveloperMode) redirect("/login");
  const cookieStore = await cookies();
  const installationId = session?.user?.id
    ? readInstallationCookie(cookieStore.get(GITHUB_INSTALLATION_COOKIE)?.value, session.user.id)
    : null;
  const selectedRepository = session?.user?.id && installationId
    ? readSelectedRepositoryCookie(
      cookieStore.get(GITHUB_REPOSITORY_COOKIE)?.value,
      session.user.id,
      installationId,
    )
    : null;
  const githubAppConfigured = isGitHubAppConfigured();

  return (
    <main className="app-shell">
      <Sidebar
        repository={selectedRepository ?? "Select a repository"}
        userName={session?.user?.name ?? null}
        signedIn={Boolean(session)}
        authConfigured={githubOAuthConfigured}
        githubAppConfigured={githubAppConfigured}
        githubAppConnected={Boolean(installationId)}
        activePage="repositories"
      />
      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>Repositories</strong></div>
          <div className="topbar-right"><span className="live-indicator"><i /> GitHub access</span><span className="topbar-divider" /><span className="version-label">RED ZONE AGENT</span></div>
        </header>
        <div className="content">
          <div className="page-intro"><div><div className="eyebrow"><span className="eyebrow-line" /> WORKSPACE SETTINGS</div><h1>Your repositories.</h1><p className="intro-copy">Choose which GitHub repository RedZone should use for historical review evidence. It must match the origin of the local checkout RedZone analyzes.</p></div></div>
          <RepositoriesWorkspace connected={Boolean(installationId)} configured={githubAppConfigured} initialSelection={selectedRepository} />
          <footer className="page-footer"><span>RED ZONE AGENT</span><span>Repository access is limited to the GitHub App installation.</span></footer>
        </div>
      </section>
    </main>
  );
}
