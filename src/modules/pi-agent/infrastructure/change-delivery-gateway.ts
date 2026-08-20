import { createHash } from "node:crypto";
import { ManagedSecretClient } from "@/src/platform/secrets/managed-secret-client";
import { OpenBaoSecretClient } from "@/src/platform/secrets/openbao-secret-client";
import type {
  PiChangeReleaseGateway,
  PiExternalActionResult,
  PiMergeability,
  PiMergeGatewayInput,
  PiPullRequestGateway,
  PiPullRequestGatewayInput,
  PiReleaseGatewayInput,
} from "@/src/modules/pi-agent/domain/change-delivery-contracts";
import { FailClosedPiChangeReleaseGateway, FailClosedPiPullRequestGateway } from "@/src/modules/pi-agent/infrastructure/change-delivery-store";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_REPO_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type CredentialInput = Pick<PiPullRequestGatewayInput, "tenantId" | "actorId" | "sessionId" | "runId" | "repositoryId" | "credentialRef">;

export interface PiForgejoCredentialResolver {
  resolve(input: CredentialInput): Promise<string>;
}

export class FailClosedPiForgejoCredentialResolver implements PiForgejoCredentialResolver {
  async resolve(): Promise<never> { throw new Error("PI_FORGEJO_CREDENTIAL_UNAVAILABLE"); }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function localHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function normalizeEndpoint(value: string, allowLocalHttp: boolean): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("PI_FORGEJO_ENDPOINT_INVALID"); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname.includes("..")) throw new Error("PI_FORGEJO_ENDPOINT_INVALID");
  if (endpoint.protocol !== "https:" && !(allowLocalHttp && endpoint.protocol === "http:" && localHost(endpoint.hostname))) throw new Error("PI_FORGEJO_HTTPS_REQUIRED");
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") + "/";
  return endpoint;
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > MAX_TIMEOUT_MS) throw new Error("PI_FORGEJO_TIMEOUT_INVALID");
  return timeout;
}

function normalizeSecretReference(reference: string, tenantId: string): string {
  const normalized = reference.trim();
  if (!/^secret:\/\/[A-Za-z0-9/_-]{1,200}$/.test(normalized) || normalized.includes("..") || !normalized.startsWith(`secret://tenants/${tenantId}/`)) throw new Error("PI_FORGEJO_CREDENTIAL_SCOPE_INVALID");
  return normalized;
}

function tokenFromSecret(raw: string): string {
  if (!raw || raw.length > 64_000 || /[\r\n\u0000]/.test(raw)) throw new Error("PI_FORGEJO_CREDENTIAL_INVALID");
  let value = raw.trim();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("PI_FORGEJO_CREDENTIAL_INVALID");
    const authorization = typeof parsed.authorization === "string" ? parsed.authorization : undefined;
    const token = typeof parsed.token === "string" ? parsed.token : typeof parsed.access_token === "string" ? parsed.access_token : undefined;
    value = authorization ?? token ?? "";
    if (!value && parsed.headers && typeof parsed.headers === "object" && !Array.isArray(parsed.headers)) {
      const headers = parsed.headers as Record<string, unknown>;
      value = typeof headers.authorization === "string" ? headers.authorization : typeof headers.Authorization === "string" ? headers.Authorization : "";
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PI_FORGEJO_CREDENTIAL_INVALID") throw error;
  }
  value = value.trim().replace(/^(?:Bearer|token)\s+/i, "");
  if (!value || value.length > 4_096 || /[\s\r\n\u0000]/.test(value)) throw new Error("PI_FORGEJO_CREDENTIAL_INVALID");
  return value;
}

class SecretClientForgejoCredentialResolver implements PiForgejoCredentialResolver {
  constructor(private readonly resolveSecret: (reference: string, purpose: string) => Promise<string>) {}

  async resolve(input: CredentialInput): Promise<string> {
    const reference = normalizeSecretReference(input.credentialRef, input.tenantId);
    return tokenFromSecret(await this.resolveSecret(reference, `pi-change-delivery:forgejo:${input.repositoryId}`));
  }
}

class StaticForgejoCredentialResolver implements PiForgejoCredentialResolver {
  constructor(private readonly token: string) {}

  async resolve(input: CredentialInput): Promise<string> {
    normalizeSecretReference(input.credentialRef, input.tenantId);
    return tokenFromSecret(this.token);
  }
}

export function createPiForgejoCredentialResolver(): PiForgejoCredentialResolver {
  if (process.env.SECRET_PROVIDER === "openbao" || process.env.OPENBAO_ADDR) {
    try {
      const client = new OpenBaoSecretClient();
      return new SecretClientForgejoCredentialResolver(client.resolveString.bind(client));
    } catch { return new FailClosedPiForgejoCredentialResolver(); }
  }
  if (process.env.SECRET_PROVIDER === "managed-http") {
    try {
      const client = new ManagedSecretClient();
      return new SecretClientForgejoCredentialResolver(client.resolveString.bind(client));
    } catch { return new FailClosedPiForgejoCredentialResolver(); }
  }
  if (process.env.NODE_ENV !== "production" && process.env.NEXUS_PI_FORGEJO_TOKEN) return new StaticForgejoCredentialResolver(process.env.NEXUS_PI_FORGEJO_TOKEN);
  return new FailClosedPiForgejoCredentialResolver();
}

type ForgejoResponse = { status: number; body: unknown };

class ForgejoPermanentError extends Error {
  constructor(readonly code: string) { super(code); }
}

function safeExternalId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!SAFE_ID.test(normalized)) throw new ForgejoPermanentError("PI_FORGEJO_RESPONSE_INVALID");
  return normalized;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ForgejoPermanentError("PI_FORGEJO_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function bodyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeUrl(value: unknown, publicOrigin?: URL): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ForgejoPermanentError("PI_FORGEJO_EXTERNAL_URL_INVALID"); }
  if (parsed.username || parsed.password || parsed.hash || /[\u0000-\u001f\u007f]/.test(value) || value.length > 8_000) throw new ForgejoPermanentError("PI_FORGEJO_EXTERNAL_URL_INVALID");
  if (parsed.protocol === "https:") return parsed.toString();
  if (!publicOrigin) return undefined;
  const rewritten = new URL(parsed.pathname + parsed.search, publicOrigin);
  return rewritten.toString();
}

function mergeability(body: Record<string, unknown>): PiMergeability {
  if (body.mergeable === true || body.mergeable_state === "clean") return "mergeable";
  if (body.mergeable === false || body.mergeable_state === "dirty") return "conflicted";
  if (body.mergeable_state === "blocked" || body.state === "closed") return "blocked";
  return "unknown";
}

function digestResult(input: Record<string, unknown>): string {
  return sha256(JSON.stringify(input));
}

function traceHeader(value: string): string {
  return /^[A-Za-z0-9._:/-]{1,200}$/.test(value) ? value : sha256(value).slice(0, 64);
}

function repositoryParts(repositoryRef: string): [string, string] {
  const parts = repositoryRef.trim().split("/");
  if (parts.length !== 2 || !parts.every((part) => SAFE_REPO_PART.test(part))) throw new ForgejoPermanentError("PI_FORGEJO_REPOSITORY_REF_INVALID");
  return [parts[0], parts[1]];
}

function statusCode(status: number, operation: string): ForgejoPermanentError | Error {
  if (status === 401 || status === 403) return new ForgejoPermanentError("PI_FORGEJO_AUTH_FAILED");
  if (status === 404) return new ForgejoPermanentError("PI_FORGEJO_NOT_FOUND");
  if (status === 409 || status === 422) return new ForgejoPermanentError(`PI_FORGEJO_${operation.toUpperCase()}_REJECTED`);
  if (status === 429 || status >= 500) return new Error("PI_FORGEJO_UPSTREAM_UNKNOWN");
  return new ForgejoPermanentError(`PI_FORGEJO_${operation.toUpperCase()}_HTTP`);
}

function responseId(body: Record<string, unknown>): string {
  return safeExternalId(body.number ?? body.id);
}

export type ForgejoPiChangeDeliveryGatewayOptions = {
  apiEndpoint: string;
  credentialResolver: PiForgejoCredentialResolver;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  allowLocalHttp?: boolean;
  publicOrigin?: string;
  allowMerge?: boolean;
};

export class ForgejoPiChangeDeliveryGateway implements PiPullRequestGateway, PiChangeReleaseGateway {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly publicOrigin?: URL;

  constructor(
    private readonly options: ForgejoPiChangeDeliveryGatewayOptions,
  ) {
    this.endpoint = normalizeEndpoint(options.apiEndpoint, options.allowLocalHttp === true && process.env.NODE_ENV !== "production");
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    if (options.publicOrigin) {
      let origin: URL;
      try { origin = new URL(options.publicOrigin); } catch { throw new Error("PI_FORGEJO_PUBLIC_ORIGIN_INVALID"); }
      if (origin.username || origin.password || origin.search || origin.hash || (origin.protocol !== "https:" && !(options.allowLocalHttp && process.env.NODE_ENV !== "production" && localHost(origin.hostname)))) throw new Error("PI_FORGEJO_PUBLIC_ORIGIN_INVALID");
      origin.pathname = origin.pathname.replace(/\/+$/, "") + "/";
      this.publicOrigin = origin;
    }
  }

  async createPullRequest(input: PiPullRequestGatewayInput): Promise<PiExternalActionResult> {
    this.assertProvider(input);
    const token = await this.token(input);
    try {
      const [owner, repository] = repositoryParts(input.repositoryRef);
      const existing = input.externalId ? await this.readPullRequest(input, token, owner, repository, input.externalId) : await this.findExisting(input, token, owner, repository);
      if (existing) return this.success("create_pull_request", existing);
      const response = await this.request("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`, token, input, {
        head: input.branch,
        base: input.targetBranch,
        title: `Pi change ${input.changeSetDigest.slice(0, 12)}`,
        body: `Controlled Pi Change Delivery\nChange digest: ${input.changeSetDigest}`,
      });
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 409 || response.status === 422) {
          const afterConflict = await this.findExisting(input, token, owner, repository);
          if (afterConflict) return this.success("create_pull_request", afterConflict);
        }
        throw statusCode(response.status, "create_pull_request");
      }
      return this.success("create_pull_request", this.normalizePull(input, objectBody(response.body)));
    } catch (error) {
      if (error instanceof ForgejoPermanentError) return this.failure("create_pull_request", error.code);
      throw error;
    }
  }

  async refreshMergeability(input: PiPullRequestGatewayInput): Promise<PiExternalActionResult> {
    this.assertProvider(input);
    const token = await this.token(input);
    if (!input.externalId) throw new Error("PI_FORGEJO_EXTERNAL_ID_REQUIRED");
    try {
      const [owner, repository] = repositoryParts(input.repositoryRef);
      const current = await this.readPullRequest(input, token, owner, repository, input.externalId);
      return this.success("refresh_mergeability", current);
    } catch (error) {
      if (error instanceof ForgejoPermanentError) return this.failure("refresh_mergeability", error.code);
      throw error;
    }
  }

  async proposeMerge(input: PiMergeGatewayInput): Promise<PiExternalActionResult> {
    this.assertProvider(input);
    if (this.options.allowMerge !== true) throw new Error("PI_CHANGE_RELEASE_GATEWAY_DISABLED");
    if (!input.externalId) throw new Error("PI_FORGEJO_EXTERNAL_ID_REQUIRED");
    const token = await this.token(input);
    try {
      const [owner, repository] = repositoryParts(input.repositoryRef);
      const response = await this.request("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${encodeURIComponent(input.externalId)}/merge`, token, input, {
        Do: "merge",
        MergeMessage: `Pi change ${input.changeSetDigest.slice(0, 12)}`,
        delete_branch_after_merge: false,
        force_merge: false,
      });
      if (response.status < 200 || response.status >= 300) throw statusCode(response.status, "merge");
      return { status: "succeeded", resultDigest: digestResult({ action: "merge", externalId: input.externalId, status: response.status }), externalId: input.externalId };
    } catch (error) {
      if (error instanceof ForgejoPermanentError) return this.failure("propose_merge", error.code, input.externalId);
      throw error;
    }
  }

  async proposeRelease(_input: PiReleaseGatewayInput): Promise<never> { void _input; throw new Error("PI_CHANGE_RELEASE_GATEWAY_UNAVAILABLE"); }

  private async token(input: PiPullRequestGatewayInput): Promise<string> {
    return tokenFromSecret(await this.options.credentialResolver.resolve(input));
  }

  private assertProvider(input: PiPullRequestGatewayInput): void {
    if (input.provider !== "forgejo") throw new Error("PI_FORGEJO_PROVIDER_UNSUPPORTED");
    if (input.tenantId.trim() === "" || input.actorId.trim() === "" || input.sessionId.trim() === "" || input.runId.trim() === "" || input.repositoryId.trim() === "") throw new Error("PI_FORGEJO_SCOPE_INVALID");
  }

  private buildUrl(path: string, query?: Record<string, string>): URL {
    const url = new URL(path.replace(/^\//, ""), this.endpoint);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private async request(method: string, path: string, token: string, input: PiPullRequestGatewayInput, body?: Record<string, unknown>): Promise<ForgejoResponse> {
    const url = this.buildUrl(path);
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method,
        headers: {
          accept: "application/json",
          authorization: `token ${token}`,
          "x-nexus-tenant-id": input.tenantId,
          "x-nexus-actor-id": input.actorId,
          "x-nexus-trace-id": traceHeader(input.traceId),
          "x-idempotency-key": input.idempotencyKey,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw new Error("PI_FORGEJO_UPSTREAM_UNKNOWN"); }
    let text: string;
    try { text = await response.text(); } catch { throw new Error("PI_FORGEJO_RESPONSE_INVALID"); }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("PI_FORGEJO_RESPONSE_TOO_LARGE");
    if (!text.trim()) return { status: response.status, body: undefined };
    try { return { status: response.status, body: JSON.parse(text) }; } catch { throw new Error("PI_FORGEJO_RESPONSE_INVALID"); }
  }

  private async findExisting(input: PiPullRequestGatewayInput, token: string, owner: string, repository: string): Promise<NormalizedPull | undefined> {
    const response = await this.requestWithQuery("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`, token, input, { state: "open", head: `${owner}:${input.branch}`, base: input.targetBranch, limit: "50" });
    if (response.status < 200 || response.status >= 300) throw statusCode(response.status, "list_pull_requests");
    if (!Array.isArray(response.body)) throw new ForgejoPermanentError("PI_FORGEJO_RESPONSE_INVALID");
    for (const item of response.body.slice(0, 256)) {
      const body = objectBody(item);
      const head = body.head && typeof body.head === "object" && !Array.isArray(body.head) ? String((body.head as Record<string, unknown>).ref ?? "") : "";
      const base = body.base && typeof body.base === "object" && !Array.isArray(body.base) ? String((body.base as Record<string, unknown>).ref ?? "") : "";
      if (head === input.branch && base === input.targetBranch) return this.normalizePull(input, body);
    }
    return undefined;
  }

  private async requestWithQuery(method: string, path: string, token: string, input: PiPullRequestGatewayInput, query: Record<string, string>): Promise<ForgejoResponse> {
    const url = this.buildUrl(path, query);
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method,
        headers: { accept: "application/json", authorization: `token ${token}`, "x-nexus-tenant-id": input.tenantId, "x-nexus-actor-id": input.actorId, "x-nexus-trace-id": traceHeader(input.traceId), "x-idempotency-key": input.idempotencyKey },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw new Error("PI_FORGEJO_UPSTREAM_UNKNOWN"); }
    let text: string;
    try { text = await response.text(); } catch { throw new Error("PI_FORGEJO_RESPONSE_INVALID"); }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("PI_FORGEJO_RESPONSE_TOO_LARGE");
    if (!text.trim()) return { status: response.status, body: undefined };
    try { return { status: response.status, body: JSON.parse(text) }; } catch { throw new Error("PI_FORGEJO_RESPONSE_INVALID"); }
  }

  private async readPullRequest(input: PiPullRequestGatewayInput, token: string, owner: string, repository: string, externalId: string): Promise<NormalizedPull> {
    const id = safeExternalId(externalId);
    const response = await this.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${encodeURIComponent(id)}`, token, input);
    if (response.status < 200 || response.status >= 300) throw statusCode(response.status, "read_pull_request");
    return this.normalizePull(input, objectBody(response.body));
  }

  private normalizePull(input: PiPullRequestGatewayInput, body: Record<string, unknown>): NormalizedPull {
    const id = responseId(body);
    const head = body.head && typeof body.head === "object" && !Array.isArray(body.head) ? String((body.head as Record<string, unknown>).ref ?? "") : "";
    const base = body.base && typeof body.base === "object" && !Array.isArray(body.base) ? String((body.base as Record<string, unknown>).ref ?? "") : "";
    if ((head && head !== input.branch) || (base && base !== input.targetBranch)) throw new ForgejoPermanentError("PI_FORGEJO_OBJECT_SCOPE_MISMATCH");
    const url = safeUrl(body.html_url, this.publicOrigin);
    const state = bodyText(body.state);
    return { externalId: id, externalUrl: url, mergeability: mergeability(body), state, branch: head || input.branch, targetBranch: base || input.targetBranch };
  }

  private success(action: string, value: NormalizedPull): PiExternalActionResult {
    return { status: "succeeded", resultDigest: digestResult({ action, externalId: value.externalId, externalUrl: value.externalUrl ?? null, mergeability: value.mergeability, state: value.state ?? null }), externalId: value.externalId, ...(value.externalUrl ? { externalUrl: value.externalUrl } : {}), mergeability: value.mergeability };
  }

  private failure(action: string, code: string, externalId?: string): PiExternalActionResult {
    return { status: "failed", resultDigest: digestResult({ action, externalId: externalId ?? null, errorCode: code }), ...(externalId ? { externalId } : {}), errorCode: code };
  }
}

type NormalizedPull = {
  externalId: string;
  externalUrl?: string;
  mergeability: "unknown" | "mergeable" | "conflicted" | "blocked";
  state?: string;
  branch: string;
  targetBranch: string;
};

export type PiChangeDeliveryGatewaySet = {
  pullRequests: PiPullRequestGateway;
  releases: PiChangeReleaseGateway;
  enabled: boolean;
};

export function createPiChangeDeliveryGateways(): PiChangeDeliveryGatewaySet {
  if (process.env.NEXUS_PI_CHANGE_DELIVERY_EXTERNAL_ENABLED !== "true") return { pullRequests: new FailClosedPiPullRequestGateway(), releases: new FailClosedPiChangeReleaseGateway(), enabled: false };
  const endpoint = process.env.NEXUS_PI_FORGEJO_API_URL?.trim();
  if (!endpoint) return { pullRequests: new FailClosedPiPullRequestGateway(), releases: new FailClosedPiChangeReleaseGateway(), enabled: false };
  try {
    const gateway = new ForgejoPiChangeDeliveryGateway({
      apiEndpoint: endpoint,
      credentialResolver: createPiForgejoCredentialResolver(),
      allowLocalHttp: process.env.NEXUS_PI_FORGEJO_ALLOW_INSECURE_LOCAL === "true",
      publicOrigin: process.env.NEXUS_PI_FORGEJO_PUBLIC_ORIGIN,
      allowMerge: process.env.NEXUS_PI_CHANGE_DELIVERY_ENABLE_MERGE === "true",
    });
    return { pullRequests: gateway, releases: gateway, enabled: true };
  } catch {
    return { pullRequests: new FailClosedPiPullRequestGateway(), releases: new FailClosedPiChangeReleaseGateway(), enabled: false };
  }
}
