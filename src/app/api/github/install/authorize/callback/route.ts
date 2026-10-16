import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "../../../../../../auth.ts";
import {
  createInstallationCookie,
  exchangeGitHubAppCode,
  getGitHubUserId,
  GITHUB_INSTALLATION_COOKIE,
  GITHUB_INSTALL_PENDING_COOKIE,
  isGitHubAppConfigured,
  readPendingInstallationCookie,
  verifyUserCanAccessInstallation,
} from "../../../../../../github-app.ts";

function redirectWithStatus(request: NextRequest, status: string): NextResponse {
  const url = new URL("/", request.url);
  url.searchParams.set("githubApp", status);
  const response = NextResponse.redirect(url);
  response.cookies.delete(GITHUB_INSTALL_PENDING_COOKIE);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isGitHubAppConfigured()) return redirectWithStatus(request, "not-configured");
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const pending = readPendingInstallationCookie(
    request.cookies.get(GITHUB_INSTALL_PENDING_COOKIE)?.value,
  );
  if (!code || !state || !pending || pending.state !== state) {
    return redirectWithStatus(request, "invalid-state");
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectWithStatus(request, "sign-in-required");

  try {
    const callbackUrl = new URL("/api/github/install/authorize/callback", request.url).toString();
    const appUserToken = await exchangeGitHubAppCode(code, callbackUrl);
    const authorizedUserId = await getGitHubUserId(appUserToken);
    if (authorizedUserId !== session.user.id) {
      return redirectWithStatus(request, "account-mismatch");
    }

    const installationIsAccessible = await verifyUserCanAccessInstallation(
      appUserToken,
      pending.installationId,
    );
    if (!installationIsAccessible) return redirectWithStatus(request, "installation-not-yours");

    const response = redirectWithStatus(request, "connected");
    response.cookies.set(
      GITHUB_INSTALLATION_COOKIE,
      createInstallationCookie(pending.installationId, session.user.id),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      },
    );
    return response;
  } catch (error) {
    console.error("[redzone:github-app] Installation authorization verification failed", {
      message: error instanceof Error ? error.message : "Unknown GitHub App verification error",
    });
    return redirectWithStatus(request, "verification-failed");
  }
}
