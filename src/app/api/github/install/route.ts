import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "../../../../auth.ts";
import { createInstallState, GITHUB_INSTALL_STATE_COOKIE, isGitHubAppConfigured } from "../../../../github-app.ts";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/?githubApp=sign-in-required", request.url));
  }

  const slug = process.env.GITHUB_APP_SLUG?.trim();
  if (!slug || !/^[A-Za-z0-9-]+$/.test(slug) || !isGitHubAppConfigured()) {
    return NextResponse.redirect(new URL("/?githubApp=not-configured", request.url));
  }

  const state = createInstallState();
  const installUrl = new URL(`https://github.com/apps/${slug}/installations/new`);
  installUrl.searchParams.set("state", state);
  const response = NextResponse.redirect(installUrl);
  response.cookies.set(GITHUB_INSTALL_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 600,
  });
  return response;
}
