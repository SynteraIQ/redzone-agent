import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions, githubOAuthConfigured } from "../auth.ts";
import {
  GITHUB_INSTALLATION_COOKIE,
  GITHUB_REPOSITORY_COOKIE,
  isGitHubAppConfigured,
  readInstallationCookie,
  readSelectedRepositoryCookie,
} from "../github-app.ts";
import { Dashboard } from "./ui/dashboard";

export default async function HomePage() {
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
  const selectedRepository = session?.user?.id && installationId
    ? readSelectedRepositoryCookie(
      cookieStore.get(GITHUB_REPOSITORY_COOKIE)?.value,
      session.user.id,
      installationId,
    )
    : null;

  return (
    <Dashboard
      repository={selectedRepository ?? "Select a repository"}
      initialBaseRef={process.env.REDZONE_BASE_REF ?? "main"}
      userName={session?.user?.name ?? null}
      signedIn={Boolean(session)}
      authConfigured={githubOAuthConfigured}
      githubAppConfigured={isGitHubAppConfigured()}
      githubAppConnected={githubAppConnected}
    />
  );
}
