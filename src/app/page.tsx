import { basename } from "node:path";
import { getServerSession } from "next-auth";
import { authOptions, googleCredentialsConfigured } from "../auth.ts";
import { Dashboard } from "./ui/dashboard";

export default async function HomePage() {
  const session = googleCredentialsConfigured ? await getServerSession(authOptions) : null;
  const repositoryPath = process.env.REDZONE_REPOSITORY_PATH?.trim();

  return (
    <Dashboard
      repository={process.env.GH_REPO ?? (repositoryPath ? basename(repositoryPath) : "Set GH_REPO to show repository")}
      initialBaseRef={process.env.REDZONE_BASE_REF ?? "main"}
      userName={session?.user?.name ?? null}
      signedIn={Boolean(session)}
      authConfigured={googleCredentialsConfigured}
    />
  );
}
