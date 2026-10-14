import { getServerSession } from "next-auth";
import { authOptions, githubOAuthConfigured } from "../../../../auth.ts";
import { verifySlackConnection } from "../../../../connections/slack.ts";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const session = githubOAuthConfigured ? await getServerSession(authOptions) : null;
  const localDeveloperMode = process.env.NODE_ENV !== "production" && process.env.REDZONE_DEV_MODE === "true";
  if (!session && !localDeveloperMode) {
    return Response.json({ error: "Sign in before verifying workspace connections." }, { status: 401 });
  }

  const status = await verifySlackConnection();
  const response = Response.json(status, { status: status.state === "failed" ? 502 : 200 });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
