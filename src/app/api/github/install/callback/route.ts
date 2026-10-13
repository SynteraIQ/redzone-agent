import { NextRequest, NextResponse } from "next/server";
import {
  createInstallState,
  createPendingInstallationCookie,
  GITHUB_INSTALLATION_COOKIE,
  GITHUB_INSTALL_PENDING_COOKIE,
  GITHUB_INSTALL_STATE_COOKIE,
  isGitHubAppConfigured,
} from "../../../../../github-app.ts";

function redirectWithStatus(request: NextRequest, status: string): NextResponse {
  const url = new URL("/", request.url);
  url.searchParams.set("githubApp", status);
  const response = NextResponse.redirect(url);
  response.cookies.delete(GITHUB_INSTALL_STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isGitHubAppConfigured()) return redirectWithStatus(request, "not-configured");

  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(GITHUB_INSTALL_STATE_COOKIE)?.value;
  if (!state || !expectedState || state !== expectedState) {
    return redirectWithStatus(request, "invalid-state");
  }

  const installationId = Number(request.nextUrl.searchParams.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    return redirectWithStatus(request, "installation-missing");
  }

  const appClientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  if (!appClientId) return redirectWithStatus(request, "not-configured");

  const oauthState = createInstallState();
  const callbackUrl = new URL("/api/github/install/authorize/callback", request.url);
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", appClientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  authorizeUrl.searchParams.set("state", oauthState);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.delete(GITHUB_INSTALL_STATE_COOKIE);
  response.cookies.set(
    GITHUB_INSTALL_PENDING_COOKIE,
    createPendingInstallationCookie(installationId, oauthState),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 600,
    },
  );
  return response;
}
