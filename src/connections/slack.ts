import { ConnectError, deleteTokenCacheEntry, getToken, type ConnectTokenParams } from "@vercel/connect";

export type SlackConnectionStatus =
  | { state: "not-configured"; message: string }
  | { state: "connected"; workspace: string; workspaceId: string; actor: string }
  | { state: "failed"; message: string };

type SlackAuthResponse = {
  ok?: boolean;
  error?: string;
  team?: string;
  team_id?: string;
  user?: string;
};

function getSlackConnector(): string | null {
  const name = process.env.VERCEL_CONNECT_SLACK_CONNECTOR?.trim();
  if (!name || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) return null;
  return `slack/${name}`;
}

export function isSlackConnectionConfigured(): boolean {
  return getSlackConnector() !== null;
}

export async function verifySlackConnection(): Promise<SlackConnectionStatus> {
  const connector = getSlackConnector();
  if (!connector) {
    return {
      state: "not-configured",
      message: "Set VERCEL_CONNECT_SLACK_CONNECTOR to the name of the Slack connector configured in Vercel.",
    };
  }

  try {
    const tokenParams: ConnectTokenParams = { subject: { type: "app" }, scopes: [] };
    const token = await getToken(connector, tokenParams);
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Slack auth.test returned HTTP ${response.status}.`);
    }
    const result = await response.json() as SlackAuthResponse;
    if (!result.ok || !result.team || !result.team_id || !result.user) {
      if (result.ok === false) deleteTokenCacheEntry(connector, tokenParams);
      console.error("[redzone:connections] Slack rejected the Vercel Connect credential", {
        connector,
        error: result.error ?? "incomplete-auth-response",
      });
      return { state: "failed", message: "Slack rejected this connection. Check its authorization in Vercel Connect." };
    }
    return {
      state: "connected",
      workspace: result.team,
      workspaceId: result.team_id,
      actor: result.user,
    };
  } catch (error) {
    console.error("[redzone:connections] Could not verify Slack connection", {
      connector,
      errorName: error instanceof Error ? error.name : "UnknownError",
      connectCode: error instanceof ConnectError ? error.code : undefined,
      connectStatus: error instanceof ConnectError ? error.status : undefined,
    });
    return {
      state: "failed",
      message: "Could not retrieve a Slack credential. Check Vercel Connect setup and runtime authorization.",
    };
  }
}
