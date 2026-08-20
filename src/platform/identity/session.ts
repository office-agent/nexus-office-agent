import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Channel, DataScope, RequestContext } from "@/src/platform/context/request-context";

export const SESSION_COOKIE_NAME = "nexus_session";
const SESSION_VERSION = 1;

export type SessionClaims = Omit<RequestContext, "traceId"> & {
  version: typeof SESSION_VERSION;
  issuedAt: number;
  expiresAt: number;
};

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

export function isDataScope(value: unknown): value is DataScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (scope.type === "self" || scope.type === "owned" || scope.type === "tenant") return true;
  if (scope.type === "team") return isStringArray(scope.teamIds);
  if (scope.type === "org_subtree") return isStringArray(scope.orgUnitIds);
  if (scope.type === "project") return isStringArray(scope.projectIds);
  if (scope.type === "explicit") return isStringArray(scope.resourceIds);
  return false;
}

function isChannel(value: unknown): value is Channel {
  return ["web", "feishu", "dingtalk", "wecom", "system"].includes(String(value));
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("SESSION_SECRET_TOO_SHORT");
}

export function createSessionCookieValue(
  identity: Omit<SessionClaims, "version" | "issuedAt" | "expiresAt" | "sessionId"> & { sessionId?: string },
  secret: string,
  options: { now?: Date; ttlSeconds?: number } = {},
): string {
  assertSecret(secret);
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const claims: SessionClaims = {
    ...identity,
    sessionId: identity.sessionId ?? randomUUID(),
    version: SESSION_VERSION,
    issuedAt,
    expiresAt: issuedAt + (options.ttlSeconds ?? 8 * 60 * 60),
  };
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionCookieValue(value: string, secret: string, now: Date = new Date()): SessionClaims {
  assertSecret(secret);
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra || !safeEqual(sign(payload, secret), signature)) throw new Error("SESSION_INVALID");

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("SESSION_INVALID");
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error("SESSION_INVALID");
  const record = claims as Record<string, unknown>;
  const valid = record.version === SESSION_VERSION
    && typeof record.tenantId === "string" && record.tenantId.length > 0
    && typeof record.actorId === "string" && record.actorId.length > 0
    && typeof record.sessionId === "string" && record.sessionId.length > 0
    && isChannel(record.channel)
    && isStringArray(record.roles)
    && isStringArray(record.permissions)
    && Array.isArray(record.dataScopes) && record.dataScopes.every(isDataScope)
    && typeof record.issuedAt === "number"
    && typeof record.expiresAt === "number";
  if (!valid || (record.expiresAt as number) <= Math.floor(now.getTime() / 1000)) throw new Error("SESSION_INVALID");
  return claims as SessionClaims;
}

export function verifySessionCookieWithRotation(value: string, secrets: string[], now: Date = new Date()): SessionClaims {
  for (const secret of secrets.filter(Boolean)) {
    try { return verifySessionCookieValue(value, secret, now); } catch { /* Try the explicitly configured grace key. */ }
  }
  throw new Error("SESSION_INVALID");
}

export function readCookie(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function sessionCookieHeader(value: string, maxAgeSeconds = 8 * 60 * 60): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearSessionCookieHeader(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
