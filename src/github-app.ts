import { createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";

export const GITHUB_INSTALLATION_COOKIE = "redzone_github_installation";
export const GITHUB_INSTALL_STATE_COOKIE = "redzone_github_install_state";
export const GITHUB_INSTALL_PENDING_COOKIE = "redzone_github_install_pending";
export const GITHUB_REPOSITORY_COOKIE = "redzone_github_repository";

export class RepositorySelectionError extends Error {}

type InstallationCookie = {
  installationId: number;
  subject: string;
  expiresAt: number;
};
type PendingInstallationCookie = { installationId: number; state: string; expiresAt: number };

type AccessibleInstallation = { id: number };
type InstallationList = { installations?: AccessibleInstallation[] };
type InstallationTokenResponse = { token?: string };
export type GitHubAppRepository = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch: string | null;
};
type InstallationRepositoriesResponse = {
  repositories?: GitHubAppRepository[];
  total_count?: number;
};
type SelectedRepositoryCookie = {
  repository: string;
  subject: string;
  installationId: number;
  expiresAt: number;
};

function appConfiguration(): { appId: string; privateKey: string } | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!appId || !privateKey) return null;
  return { appId, privateKey };
}

export function isGitHubAppConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_SLUG?.trim() && appConfiguration() &&
    process.env.GITHUB_APP_CLIENT_ID?.trim() && process.env.GITHUB_APP_CLIENT_SECRET &&
    process.env.NEXTAUTH_SECRET,
  );
}

export function createInstallState(): string {
  return randomBytes(32).toString("hex");
}

function appJwt(): string {
  const config = appConfiguration();
  if (!config) throw new Error("Configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY first.");

  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: config.appId,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(config.privateKey, "base64url")}`;
}

async function githubJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`GitHub App request failed (HTTP ${response.status}).`);
  }
  return await response.json() as T;
}

export async function verifyUserCanAccessInstallation(
  accessToken: string,
  installationId: number,
): Promise<boolean> {
  for (let page = 1; page <= 20; page++) {
    const result = await githubJson<InstallationList>(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      accessToken,
    );
    const installations = result.installations ?? [];
    if (installations.some((installation) => installation.id === installationId)) return true;
    if (installations.length < 100) return false;
  }
  throw new Error("Too many GitHub App installations to verify. Contact an administrator.");
}

function signCookiePayload(payload: object): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("Configure NEXTAUTH_SECRET before connecting GitHub.");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readCookiePayload<T>(value: string | undefined): T | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || !value) return null;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function createPendingInstallationCookie(installationId: number, state: string): string {
  const payload: PendingInstallationCookie = {
    installationId,
    state,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
  return signCookiePayload(payload);
}

export function readPendingInstallationCookie(value: string | undefined): PendingInstallationCookie | null {
  const payload = readCookiePayload<PendingInstallationCookie>(value);
  if (
    !payload || !Number.isSafeInteger(payload.installationId) || payload.installationId < 1 ||
    !payload.state || payload.expiresAt <= Math.floor(Date.now() / 1000)
  ) return null;
  return payload;
}

export async function exchangeGitHubAppCode(code: string, redirectUri: string): Promise<string> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Configure the GitHub App client credentials first.");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub authorization failed (HTTP ${response.status}).`);
  const result = await response.json() as { access_token?: string; error?: string };
  if (!result.access_token) throw new Error(result.error ?? "GitHub did not return an App user token.");
  return result.access_token;
}

export async function getGitHubUserId(accessToken: string): Promise<string> {
  const user = await githubJson<{ id?: number }>("https://api.github.com/user", accessToken);
  if (!Number.isSafeInteger(user.id)) throw new Error("GitHub did not return a valid user identity.");
  return String(user.id);
}

export function createInstallationCookie(installationId: number, subject: string): string {
  const payload: InstallationCookie = {
    installationId,
    subject,
    expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  };
  return signCookiePayload(payload);
}

export function readInstallationCookie(value: string | undefined, subject: string): number | null {
  const payload = readCookiePayload<InstallationCookie>(value);
  if (
    !payload || !Number.isSafeInteger(payload.installationId) || payload.installationId < 1 ||
    payload.subject !== subject || payload.expiresAt <= Math.floor(Date.now() / 1000)
  ) return null;
  return payload.installationId;
}

export function createSelectedRepositoryCookie(
  repository: string,
  subject: string,
  installationId: number,
): string {
  const payload: SelectedRepositoryCookie = {
    repository,
    subject,
    installationId,
    expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  };
  return signCookiePayload(payload);
}

export function readSelectedRepositoryCookie(
  value: string | undefined,
  subject: string,
  installationId: number,
): string | null {
  const payload = readCookiePayload<SelectedRepositoryCookie>(value);
  if (
    !payload || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repository) ||
    payload.subject !== subject || payload.installationId !== installationId ||
    payload.expiresAt <= Math.floor(Date.now() / 1000)
  ) return null;
  return payload.repository;
}

async function createInstallationToken(installationId: number, repository?: string): Promise<string> {
  const config = appConfiguration();
  if (!config) throw new Error("Configure the RedZone GitHub App credentials first.");
  const repositories = repository ? [repository.split("/")[1]] : undefined;
  const result = await githubJson<InstallationTokenResponse>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    appJwt(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(repositories ? { repositories } : {}),
        permissions: { issues: "read", metadata: "read", pull_requests: "read" },
      }),
    },
  );
  if (!result.token) throw new Error("GitHub did not return an installation token.");
  return result.token;
}

export async function createInstallationTokenForWorkflow(
  installationId: number,
  repository: string,
): Promise<string> {
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new Error("The GitHub App installation is invalid.");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("The selected GitHub repository is invalid.");
  }
  if (!isGitHubAppConfigured()) throw new Error("Configure the GitHub App before using repository access.");
  return createInstallationToken(installationId, repository);
}

async function installationContext(request: NextRequest): Promise<{ installationId: number; subject: string }> {
  const sessionToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  if (!sessionToken?.sub) throw new RepositorySelectionError("Sign in with GitHub before connecting a repository.");
  const installationId = readInstallationCookie(
    request.cookies.get(GITHUB_INSTALLATION_COOKIE)?.value,
    sessionToken.sub,
  );
  if (!installationId) throw new RepositorySelectionError("Connect the RedZone GitHub App before selecting a repository.");
  return { installationId, subject: sessionToken.sub };
}

export async function getInstalledRepositoriesForRequest(request: NextRequest): Promise<{
  repositories: GitHubAppRepository[];
  installationId: number;
  subject: string;
}> {
  const context = await installationContext(request);
  const token = await createInstallationToken(context.installationId);
  const repositories: GitHubAppRepository[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await githubJson<InstallationRepositoriesResponse>(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    const current = result.repositories ?? [];
    repositories.push(...current);
    if (current.length < 100) break;
    if (page === 100) throw new Error("The GitHub App installation has too many repositories to list.");
  }
  return { repositories, ...context };
}

export async function getSelectedRepositoryForRequest(request: NextRequest): Promise<string> {
  const context = await getSelectedRepositoryContextForRequest(request);
  return context.repository;
}

export async function getSelectedRepositoryContextForRequest(request: NextRequest): Promise<{
  repository: string;
  installationId: number;
  subject: string;
}> {
  const context = await installationContext(request);
  const repository = readSelectedRepositoryCookie(
    request.cookies.get(GITHUB_REPOSITORY_COOKIE)?.value,
    context.subject,
    context.installationId,
  );
  if (!repository) throw new RepositorySelectionError("Choose a repository from the Repositories menu before analyzing.");
  return { repository, ...context };
}

export async function getInstallationTokenForRequest(request: NextRequest): Promise<string> {
  if (!isGitHubAppConfigured()) throw new Error("Configure the GitHub App before using repository access.");
  const context = await installationContext(request);
  const repository = readSelectedRepositoryCookie(
    request.cookies.get(GITHUB_REPOSITORY_COOKIE)?.value,
    context.subject,
    context.installationId,
  );
  if (!repository) throw new RepositorySelectionError("Choose a repository from the Repositories menu before analyzing.");
  return createInstallationToken(context.installationId, repository);
}
