import { createHmac, timingSafeEqual } from "node:crypto";

type StalePullRequestRunReference = {
  kind: "report" | "approval";
  runId: string;
  repository: string;
  subject: string;
  requestId: string;
  expiresAt: number;
};

const RUN_REFERENCE_LIFETIME_SECONDS = 60 * 60 * 24;

function signature(value: string): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("Configure NEXTAUTH_SECRET before running automations.");
  return createHmac("sha256", secret).update(value).digest();
}

export function createStalePullRequestSubjectKey(subject: string): string {
  return signature(`stale-pr-history:${subject}`).toString("base64url");
}

export function createStalePullRequestRunReference(
  runId: string,
  repository: string,
  subject: string,
  requestId: string,
  kind: StalePullRequestRunReference["kind"] = "report",
): string {
  const payload: StalePullRequestRunReference = {
    kind,
    runId,
    repository,
    subject,
    requestId,
    expiresAt: Math.floor(Date.now() / 1000) + RUN_REFERENCE_LIFETIME_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded).toString("base64url")}`;
}

export function readStalePullRequestRunReference(
  value: string | null,
): StalePullRequestRunReference | null {
  if (!value) return null;
  const [encoded, providedSignature, extra] = value.split(".");
  if (!encoded || !providedSignature || extra) return null;

  let expectedSignature: Buffer;
  try {
    expectedSignature = signature(encoded);
  } catch {
    return null;
  }
  const receivedSignature = Buffer.from(providedSignature, "base64url");
  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<StalePullRequestRunReference>;
    if (
      (payload.kind !== undefined && payload.kind !== "report" && payload.kind !== "approval") ||
      typeof payload.runId !== "string" || !/^wrun_[A-Za-z0-9_-]+$/.test(payload.runId) ||
      typeof payload.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repository) ||
      typeof payload.subject !== "string" || !payload.subject ||
      typeof payload.requestId !== "string" || !payload.requestId ||
      typeof payload.expiresAt !== "number" || payload.expiresAt <= Math.floor(Date.now() / 1000)
    ) return null;
    return { ...payload, kind: payload.kind ?? "report" } as StalePullRequestRunReference;
  } catch {
    return null;
  }
}
