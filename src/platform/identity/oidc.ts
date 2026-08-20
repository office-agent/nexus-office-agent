import { createHash, createHmac, createPublicKey, createVerify, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";
import { createSessionCookieValue } from "@/src/platform/identity/session";
import { isDataScope } from "@/src/platform/identity/session";
import type { DataScope } from "@/src/platform/context/request-context";

export const OIDC_STATE_COOKIE_NAME = "nexus_oidc_state";

type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

type OidcState = { state: string; nonce: string; verifier: string; returnTo: string; expiresAt: number };
type JwtClaims = { iss?: string; sub?: string; aud?: string | string[]; azp?: string; exp?: number; nbf?: number; iat?: number; nonce?: string };
type JwtHeader = { alg?: string; kid?: string; typ?: string };

export type OidcSubjectMapping = {
  tenantId: string;
  actorId: string;
  roles: string[];
  permissions: string[];
  dataScopes: DataScope[];
};

export type OidcConfiguration = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
  stateSecret: string;
  subjectMappings: Record<string, OidcSubjectMapping>;
};

function b64(value: string | Buffer): string { return Buffer.from(value).toString("base64url"); }
function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
function signatureMatches(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function ensureHttpsUrl(value: string, label: string): URL {
  const parsed = new URL(value);
  const localTest = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !localTest) throw new Error(`${label}_HTTPS_REQUIRED`);
  return parsed;
}

function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) throw new Error("OIDC_SUBJECT_MAP_INVALID");
}

function parseSubjectMappings(serialized: string): Record<string, OidcSubjectMapping> {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error("OIDC_SUBJECT_MAP_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OIDC_SUBJECT_MAP_INVALID");
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OIDC_SUBJECT_MAP_INVALID");
    const mapping = value as Record<string, unknown>;
    if (typeof mapping.tenantId !== "string" || !mapping.tenantId || typeof mapping.actorId !== "string" || !mapping.actorId) throw new Error("OIDC_SUBJECT_MAP_INVALID");
    assertStringArray(mapping.roles); assertStringArray(mapping.permissions);
    if (!Array.isArray(mapping.dataScopes) || !mapping.dataScopes.every(isDataScope)) throw new Error("OIDC_SUBJECT_MAP_INVALID");
  }
  return parsed as Record<string, OidcSubjectMapping>;
}

export function loadOidcConfiguration(): OidcConfiguration {
  const required = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "SESSION_SECRET", "OIDC_SUBJECT_MAP_JSON"] as const;
  for (const key of required) if (!process.env[key]) throw new Error(`CONFIG_REQUIRED:${key}`);
  const issuer = ensureHttpsUrl(process.env.OIDC_ISSUER!, "OIDC_ISSUER").toString().replace(/\/$/, "");
  ensureHttpsUrl(process.env.OIDC_REDIRECT_URI!, "OIDC_REDIRECT_URI");
  const stateSecret = process.env.OIDC_STATE_SECRET || process.env.SESSION_SECRET!;
  if (Buffer.byteLength(process.env.SESSION_SECRET!, "utf8") < 32 || Buffer.byteLength(stateSecret, "utf8") < 32) throw new Error("OIDC_SECRET_TOO_SHORT");
  return {
    issuer,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET!,
    redirectUri: process.env.OIDC_REDIRECT_URI!,
    sessionSecret: process.env.SESSION_SECRET!,
    stateSecret,
    subjectMappings: parseSubjectMappings(process.env.OIDC_SUBJECT_MAP_JSON!),
  };
}

async function fetchJson<T>(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetcher(url, { ...init, cache: "no-store" });
  if (!response.ok) throw new Error(`OIDC_UPSTREAM_${response.status}`);
  return await response.json() as T;
}

export async function discoverOidc(config: OidcConfiguration, fetcher: typeof fetch = fetch): Promise<OidcDiscovery> {
  const discovery = await fetchJson<OidcDiscovery>(fetcher, `${config.issuer}/.well-known/openid-configuration`);
  if (discovery.issuer.replace(/\/$/, "") !== config.issuer) throw new Error("OIDC_ISSUER_MISMATCH");
  for (const value of [discovery.authorization_endpoint, discovery.token_endpoint, discovery.jwks_uri]) ensureHttpsUrl(value, "OIDC_ENDPOINT");
  return discovery;
}

export function createOidcState(config: OidcConfiguration, returnTo?: string, now = new Date()): { value: string; state: OidcState } {
  const state: OidcState = {
    state: randomBytes(24).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    returnTo: safeReturnTo(returnTo),
    expiresAt: Math.floor(now.getTime() / 1000) + 10 * 60,
  };
  const payload = b64(JSON.stringify(state));
  return { value: `${payload}.${hmac(payload, config.stateSecret)}`, state };
}

export function verifyOidcState(value: string, expectedState: string, config: OidcConfiguration, now = new Date()): OidcState {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra || !signatureMatches(hmac(payload, config.stateSecret), signature)) throw new Error("OIDC_STATE_INVALID");
  let state: OidcState;
  try { state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OidcState; } catch { throw new Error("OIDC_STATE_INVALID"); }
  if (!state.state || state.state !== expectedState || !state.nonce || !state.verifier || state.expiresAt <= Math.floor(now.getTime() / 1000)) throw new Error("OIDC_STATE_INVALID");
  return state;
}

function decodeSegment<T>(value: string): T {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T; } catch { throw new Error("OIDC_ID_TOKEN_INVALID"); }
}

async function validateIdToken(idToken: string, nonce: string, config: OidcConfiguration, discovery: OidcDiscovery, fetcher: typeof fetch, now: Date): Promise<JwtClaims> {
  const [encodedHeader, encodedPayload, signature, extra] = idToken.split(".");
  if (!encodedHeader || !encodedPayload || !signature || extra) throw new Error("OIDC_ID_TOKEN_INVALID");
  const header = decodeSegment<JwtHeader>(encodedHeader);
  const claims = decodeSegment<JwtClaims>(encodedPayload);
  if (header.alg !== "RS256" || !header.kid) throw new Error("OIDC_ID_TOKEN_ALGORITHM_DENIED");
  const jwks = await fetchJson<{ keys: Array<NodeJsonWebKey & { kid?: string; use?: string; alg?: string }> }>(fetcher, discovery.jwks_uri);
  const jwk = jwks.keys.find((key) => key.kid === header.kid && (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"));
  if (!jwk) throw new Error("OIDC_SIGNING_KEY_NOT_FOUND");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`); verifier.end();
  if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "base64url"))) throw new Error("OIDC_ID_TOKEN_SIGNATURE_INVALID");
  const timestamp = Math.floor(now.getTime() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss?.replace(/\/$/, "") !== config.issuer || !audiences.includes(config.clientId) || !claims.sub || claims.nonce !== nonce) throw new Error("OIDC_ID_TOKEN_CLAIMS_INVALID");
  if (!claims.exp || claims.exp <= timestamp - 60 || (claims.nbf && claims.nbf > timestamp + 60) || (claims.iat && claims.iat > timestamp + 60)) throw new Error("OIDC_ID_TOKEN_EXPIRED");
  if (audiences.length > 1 && claims.azp !== config.clientId) throw new Error("OIDC_ID_TOKEN_AZP_INVALID");
  return claims;
}

export async function exchangeOidcCallback(input: { code: string; state: OidcState; config: OidcConfiguration; fetcher?: typeof fetch; now?: Date }): Promise<{ session: string; returnTo: string }> {
  const fetcher = input.fetcher ?? fetch;
  const discovery = await discoverOidc(input.config, fetcher);
  const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.config.redirectUri, client_id: input.config.clientId, client_secret: input.config.clientSecret, code_verifier: input.state.verifier });
  const tokens = await fetchJson<{ id_token?: string }>(fetcher, discovery.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  if (!tokens.id_token) throw new Error("OIDC_ID_TOKEN_MISSING");
  const claims = await validateIdToken(tokens.id_token, input.state.nonce, input.config, discovery, fetcher, input.now ?? new Date());
  const mapping = input.config.subjectMappings[`${input.config.issuer}::${claims.sub}`];
  if (!mapping) throw new Error("OIDC_SUBJECT_NOT_PROVISIONED");
  const session = createSessionCookieValue({ ...mapping, channel: "web", sessionId: randomUUID() }, input.config.sessionSecret, { now: input.now });
  return { session, returnTo: input.state.returnTo };
}

export function oidcStateCookieHeader(value: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${OIDC_STATE_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/api/v1/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
}

export function clearOidcStateCookieHeader(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${OIDC_STATE_COOKIE_NAME}=; Path=/api/v1/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
