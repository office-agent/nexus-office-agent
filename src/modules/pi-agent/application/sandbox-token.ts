import { createHmac, timingSafeEqual } from "node:crypto";

export type PiSandboxRunTokenProvider = "firecracker" | "kata";

export type PiSandboxRunTokenScope = {
  tenantId: string;
  actorId: string;
  sessionId: string;
  workspaceId: string;
  runId: string;
  provider: PiSandboxRunTokenProvider;
  sandboxId?: string;
};

export type PiSandboxRunTokenClaims = PiSandboxRunTokenScope & {
  version: 1;
  audience: "pi-sandbox";
  issuedAt: string;
  expiresAt: string;
};

export interface PiSandboxRunTokenIssuer {
  issue(scope: PiSandboxRunTokenScope, now?: Date): string;
}

export interface PiSandboxRunTokenVerifier {
  verify(token: string, expectedScope?: PiSandboxRunTokenScope, now?: Date): PiSandboxRunTokenClaims;
}

const TOKEN_PREFIX = "pst.v1";
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const MIN_SECRET_BYTES = 32;

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function validateIdentifier(value: string, code: string): void {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(code);
}

function validateScope(scope: PiSandboxRunTokenScope): void {
  validateIdentifier(scope.tenantId, "PI_SANDBOX_RUN_TOKEN_SCOPE_INVALID");
  validateIdentifier(scope.actorId, "PI_SANDBOX_RUN_TOKEN_SCOPE_INVALID");
  validateIdentifier(scope.sessionId, "PI_SANDBOX_RUN_TOKEN_SCOPE_INVALID");
  validateIdentifier(scope.workspaceId, "PI_SANDBOX_RUN_TOKEN_SCOPE_INVALID");
  validateIdentifier(scope.runId, "PI_SANDBOX_RUN_TOKEN_SCOPE_INVALID");
  if (scope.sandboxId !== undefined) validateIdentifier(scope.sandboxId, "PI_SANDBOX_RUN_TOKEN_SCOPE_INVALID");
  if (scope.provider !== "firecracker" && scope.provider !== "kata") throw new Error("PI_SANDBOX_RUN_TOKEN_PROVIDER_INVALID");
}

function signingInput(payload: string): string {
  return `${TOKEN_PREFIX}.${payload}`;
}

function signature(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(signingInput(payload), "utf8").digest("base64url");
}

function same(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertScopeMatches(actual: PiSandboxRunTokenClaims, expected: PiSandboxRunTokenScope): void {
  validateScope(expected);
  for (const key of ["tenantId", "actorId", "sessionId", "workspaceId", "runId", "provider", "sandboxId"] as const) {
    if (actual[key] !== expected[key]) throw new Error("PI_SANDBOX_RUN_TOKEN_SCOPE_MISMATCH");
  }
}

export class HmacPiSandboxRunTokenIssuer implements PiSandboxRunTokenIssuer, PiSandboxRunTokenVerifier {
  private readonly secret: Buffer;
  private readonly ttlMs: number;

  constructor(secret: string, ttlMs = DEFAULT_TTL_MS) {
    if (!secret || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) throw new Error("PI_SANDBOX_RUN_TOKEN_SECRET_INVALID");
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) throw new Error("PI_SANDBOX_RUN_TOKEN_TTL_INVALID");
    this.secret = Buffer.from(secret, "utf8");
    this.ttlMs = ttlMs;
  }

  issue(scope: PiSandboxRunTokenScope, now = new Date()): string {
    validateScope(scope);
    const issuedAt = now.getTime();
    if (!Number.isFinite(issuedAt)) throw new Error("PI_SANDBOX_RUN_TOKEN_TIME_INVALID");
    const claims: PiSandboxRunTokenClaims = {
      version: 1,
      audience: "pi-sandbox",
      ...scope,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + this.ttlMs).toISOString(),
    };
    const payload = encode(JSON.stringify(claims));
    return `${TOKEN_PREFIX}.${payload}.${signature(this.secret, payload)}`;
  }

  verify(token: string, expectedScope?: PiSandboxRunTokenScope, now = new Date()): PiSandboxRunTokenClaims {
    const parts = token.split(".");
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== TOKEN_PREFIX || !parts[2] || !parts[3]) throw new Error("PI_SANDBOX_RUN_TOKEN_INVALID");
    const [,, payload, providedSignature] = parts;
    if (!same(signature(this.secret, payload), providedSignature)) throw new Error("PI_SANDBOX_RUN_TOKEN_INVALID");
    let parsed: unknown;
    try {
      parsed = JSON.parse(decode(payload));
    } catch {
      throw new Error("PI_SANDBOX_RUN_TOKEN_INVALID");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("PI_SANDBOX_RUN_TOKEN_INVALID");
    const claims = parsed as Partial<PiSandboxRunTokenClaims>;
    if (claims.version !== 1 || claims.audience !== "pi-sandbox" || typeof claims.issuedAt !== "string" || typeof claims.expiresAt !== "string") {
      throw new Error("PI_SANDBOX_RUN_TOKEN_INVALID");
    }
    const scope = {
      tenantId: claims.tenantId,
      actorId: claims.actorId,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      runId: claims.runId,
      provider: claims.provider,
    } as PiSandboxRunTokenScope;
    validateScope(scope);
    const nowMs = now.getTime();
    const issuedMs = Date.parse(claims.issuedAt);
    const expiresMs = Date.parse(claims.expiresAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs || nowMs < issuedMs - 30_000 || nowMs >= expiresMs) {
      throw new Error("PI_SANDBOX_RUN_TOKEN_EXPIRED");
    }
    const normalized = claims as PiSandboxRunTokenClaims;
    if (expectedScope) assertScopeMatches(normalized, expectedScope);
    return normalized;
  }
}

export function createPiSandboxRunTokenIssuerFromEnv(): HmacPiSandboxRunTokenIssuer {
  const secret = process.env.NEXUS_PI_SANDBOX_RUN_TOKEN_SECRET;
  if (!secret) throw new Error("PI_SANDBOX_RUN_TOKEN_SECRET_REQUIRED");
  return new HmacPiSandboxRunTokenIssuer(secret);
}
