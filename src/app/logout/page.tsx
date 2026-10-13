import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions, githubOAuthConfigured } from "../../auth.ts";
import { LogoutScreen } from "../ui/auth-screens";

export default async function LogoutPage() {
  const session = githubOAuthConfigured ? await getServerSession(authOptions) : null;
  if (!session) redirect("/login?loggedOut=true");
  return <LogoutScreen userName={session.user?.name ?? null} />;
}
