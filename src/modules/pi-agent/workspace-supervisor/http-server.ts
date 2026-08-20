import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { PiWorkspaceSupervisorService } from "@/src/modules/pi-agent/workspace-supervisor/service";
import type { PiWorkspaceSupervisorContext } from "@/src/modules/pi-agent/workspace-supervisor/contracts";

const DEFAULT_BODY_LIMIT = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

class WorkspaceHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "PI_WORKSPACE_SUPERVISOR_FAILED";
  return /^[A-Z0-9_:-]{1,160}$/.test(value) ? value : "PI_WORKSPACE_SUPERVISOR_FAILED";
}

function statusFor(error: unknown): number {
  if (error instanceof WorkspaceHttpError) return error.status;
  const code = safeCode(error);
  if (code.includes("SCOPE") || code.includes("UNAUTHORIZED")) return 403;
  if (code.includes("NOT_FOUND")) return 404;
  if (code.includes("EXPIRED")) return 410;
  if (code.includes("NOT_READY") || code.includes("REQUIRED") || code.includes("CREDENTIALS") || code.includes("STORAGE")) return 503;
  if (code.includes("STATE_CONFLICT")) return 409;
  return 400;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new WorkspaceHttpError(413, "PI_WORKSPACE_REQUEST_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new WorkspaceHttpError(400, "PI_WORKSPACE_REQUEST_JSON_INVALID"); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceHttpError(400, "PI_WORKSPACE_REQUEST_INVALID");
  return value as Record<string, unknown>;
}

function stringField(value: unknown, code = "PI_WORKSPACE_REQUEST_INVALID", max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new WorkspaceHttpError(400, code);
  return value;
}

function integerField(value: unknown, code = "PI_WORKSPACE_REQUEST_INVALID"): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new WorkspaceHttpError(400, code);
  return value;
}

function assertBodyBoundary(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) assertBodyBoundary(item); return; }
  for (const [key, child] of Object.entries(value)) {
    if (/^(tenantId|actorId|sessionId|runId|traceId|credentialRef|token|secret|password|authorization|privateKey)$/i.test(key)) throw new WorkspaceHttpError(400, "PI_WORKSPACE_IDENTITY_IN_BODY");
    assertBodyBoundary(child);
  }
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new WorkspaceHttpError(403, "PI_WORKSPACE_SCOPE_INVALID");
  return value;
}

function context(request: IncomingMessage): PiWorkspaceSupervisorContext {
  return { tenantId: header(request, "x-tenant-id"), actorId: header(request, "x-actor-id"), sessionId: header(request, "x-session-id"), runId: header(request, "x-run-id"), traceId: header(request, "x-trace-id") };
}

function classification(value: unknown): "public" | "internal" | "confidential" | "restricted" {
  if (value !== "public" && value !== "internal" && value !== "confidential" && value !== "restricted") throw new WorkspaceHttpError(400, "PI_ARTIFACT_CLASSIFICATION_INVALID");
  return value;
}

function base64(value: unknown): Uint8Array {
  const text = stringField(value, "PI_ARTIFACT_BYTES_INVALID", 28 * 1024 * 1024);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new WorkspaceHttpError(400, "PI_ARTIFACT_BYTES_INVALID");
  return new Uint8Array(Buffer.from(text, "base64"));
}

export type PiWorkspaceSupervisorServerOptions = {
  service: PiWorkspaceSupervisorService;
  maxBodyBytes?: number;
  tls?: { key: string | Buffer; cert: string | Buffer };
};

export function createPiWorkspaceSupervisorServer(options: PiWorkspaceSupervisorServerOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
  const requestHandler = (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("cache-control", "no-store");
    request.setTimeout(REQUEST_TIMEOUT_MS);
    request.once("timeout", () => request.destroy(new Error("PI_WORKSPACE_REQUEST_TIMEOUT")));
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://workspace-supervisor");
        if (url.search || url.hash) throw new WorkspaceHttpError(400, "PI_WORKSPACE_URL_QUERY_NOT_ALLOWED");
        if (request.method === "GET" && url.pathname === "/healthz") return writeJson(response, 200, { status: "ok" });
        if (request.method === "GET" && url.pathname === "/readyz") {
          const readiness = await options.service.readiness();
          return writeJson(response, readiness.ready ? 200 : 503, readiness.ready ? { status: "ready" } : { status: "not_ready", code: readiness.code });
        }
        if (request.method === "GET" && url.pathname.startsWith("/v1/objects/download/")) {
          const grantRef = decodeURIComponent(url.pathname.slice("/v1/objects/download/".length));
          const result = await options.service.download(grantRef);
          response.statusCode = 200;
          response.setHeader("content-type", result.mediaType);
          response.setHeader("content-length", result.bytes.byteLength);
          response.setHeader("cache-control", "no-store");
          response.end(Buffer.from(result.bytes));
          return;
        }
        if (request.method !== "POST") throw new WorkspaceHttpError(405, "PI_WORKSPACE_METHOD_NOT_ALLOWED");
        const body = object(await readBody(request, maxBodyBytes));
        assertBodyBoundary(body);
        const scope = context(request);
        const path = url.pathname;
        if (path === "/v1/repositories/authorize") {
          await options.service.authorizeRepository({ repositoryId: stringField(body.repositoryId), repositoryRef: stringField(body.repositoryRef) }, scope);
          return writeJson(response, 200, { authorized: true });
        }
        if (path === "/v1/git/credential-leases") {
          const result = await options.service.issueCredential({ repositoryId: stringField(body.repositoryId), repositoryRef: stringField(body.repositoryRef), workspaceId: stringField(body.workspaceId), branch: stringField(body.branch), ttlMs: integerField(body.ttlMs, "PI_CREDENTIAL_TTL_INVALID") }, scope);
          return writeJson(response, 201, result);
        }
        if (path === "/v1/git/credential-leases/revoke") {
          await options.service.revokeCredential(stringField(body.leaseRef), scope);
          response.statusCode = 204;
          return response.end();
        }
        if (path === "/v1/workspaces/prepare") {
          const result = await options.service.prepare({ repositoryId: stringField(body.repositoryId), repositoryRef: stringField(body.repositoryRef), baseRef: stringField(body.baseRef), baseCommitSha: stringField(body.baseCommitSha), credentialLeaseRef: stringField(body.credentialLeaseRef) }, scope);
          return writeJson(response, 201, result);
        }
        if (path === "/v1/workspaces/verify-base") {
          await options.service.verifyBase({ providerWorkspaceRef: stringField(body.providerWorkspaceRef), baseRef: stringField(body.baseRef), expectedCommitSha: stringField(body.expectedCommitSha), credentialLeaseRef: stringField(body.credentialLeaseRef) }, scope);
          response.statusCode = 204;
          return response.end();
        }
        if (path === "/v1/workspaces/branch") {
          const result = await options.service.createBranch({ providerWorkspaceRef: stringField(body.providerWorkspaceRef), branch: stringField(body.branch), baseCommitSha: stringField(body.baseCommitSha), credentialLeaseRef: stringField(body.credentialLeaseRef) }, scope);
          return writeJson(response, 200, result);
        }
        if (path === "/v1/workspaces/checkpoint") {
          const result = await options.service.checkpoint({ providerWorkspaceRef: stringField(body.providerWorkspaceRef), branch: stringField(body.branch), label: stringField(body.label, "PI_CHECKPOINT_LABEL_INVALID", 200), credentialLeaseRef: stringField(body.credentialLeaseRef) }, scope);
          return writeJson(response, 200, result);
        }
        if (path === "/v1/workspaces/diff") {
          const result = await options.service.diff({ providerWorkspaceRef: stringField(body.providerWorkspaceRef), baseCommitSha: stringField(body.baseCommitSha), branch: stringField(body.branch), credentialLeaseRef: stringField(body.credentialLeaseRef) }, scope);
          return writeJson(response, 200, result);
        }
        if (path === "/v1/workspaces/push") {
          const result = await options.service.push({ providerWorkspaceRef: stringField(body.providerWorkspaceRef), branch: stringField(body.branch), credentialLeaseRef: stringField(body.credentialLeaseRef) }, scope);
          return writeJson(response, 200, result);
        }
        if (path === "/v1/workspaces/cleanup") {
          await options.service.cleanup({ providerWorkspaceRef: stringField(body.providerWorkspaceRef), ...(typeof body.credentialLeaseRef === "string" && body.credentialLeaseRef.trim() ? { credentialLeaseRef: body.credentialLeaseRef } : {}) }, scope);
          response.statusCode = 204;
          return response.end();
        }
        if (path === "/v1/objects/put") {
          const result = await options.service.putObject({ artifactId: stringField(body.artifactId, "PI_ARTIFACT_ID_INVALID", 128), version: integerField(body.version), bytes: base64(body.bytesBase64), mediaType: stringField(body.mediaType, "PI_ARTIFACT_MEDIA_TYPE_INVALID", 128), classification: classification(body.classification) }, scope);
          return writeJson(response, 201, result);
        }
        if (path === "/v1/objects/download-grant") {
          const result = await options.service.issueDownloadGrant({ artifactId: stringField(body.artifactId, "PI_ARTIFACT_ID_INVALID", 128), version: integerField(body.version), storageRef: stringField(body.storageRef), ttlMs: integerField(body.ttlMs, "PI_DOWNLOAD_GRANT_TTL_INVALID") }, scope);
          return writeJson(response, 201, result);
        }
        if (path === "/v1/objects/download-grant/revoke") {
          await options.service.revokeDownloadGrant(stringField(body.grantRef), scope);
          response.statusCode = 204;
          return response.end();
        }
        if (path === "/v1/objects/delete") {
          await options.service.deleteObject({ artifactId: stringField(body.artifactId, "PI_ARTIFACT_ID_INVALID", 128), version: integerField(body.version), storageRef: stringField(body.storageRef) }, scope);
          response.statusCode = 204;
          return response.end();
        }
        throw new WorkspaceHttpError(404, "PI_WORKSPACE_ROUTE_NOT_FOUND");
      } catch (error) {
        if (response.headersSent) { response.destroy(); return; }
        writeJson(response, statusFor(error), { error: { code: safeCode(error) } });
      }
    })();
  };
  const server = options.tls ? createSecureServer(options.tls, requestHandler) : createServer(requestHandler);
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
