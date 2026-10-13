import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions, githubOAuthConfigured } from "../../auth.ts";
import { LoginScreen } from "../ui/auth-screens";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ loggedOut?: string }>;
}) {
  const session = githubOAuthConfigured ? await getServerSession(authOptions) : null;
  if (session) redirect("/");
  const params = await searchParams;
  return <LoginScreen configured={githubOAuthConfigured} loggedOut={params.loggedOut === "true"} />;
}
