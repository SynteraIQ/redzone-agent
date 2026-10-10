import { getServerSession } from "next-auth";
import { authOptions, googleCredentialsConfigured } from "../auth.ts";
import { Dashboard } from "./ui/dashboard";

export default async function HomePage() {
  const session = googleCredentialsConfigured ? await getServerSession(authOptions) : null;

  return (
    <Dashboard
      repository={process.env.GH_REPO ?? "Set GH_REPO to show repository"}
      initialBaseRef={process.env.REDZONE_BASE_REF ?? "main"}
      userName={session?.user?.name ?? null}
      signedIn={Boolean(session)}
      authConfigured={googleCredentialsConfigured}
    />
  );
}
