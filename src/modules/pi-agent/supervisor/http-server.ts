import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  PiSandbox,
  PiSandboxLimits,
  PiSandboxResult,
  PiSandboxSpec,
  PiSandboxUsage,
  PiWorkspaceMount,
} from "@/src/modules/pi-agent/domain/contracts";
import type { PiSandboxRunTokenClaims, PiSandboxRunTokenScope, PiSandboxRunTokenVerifier } from "@/src/modules/pi-agent/application/sandbox-token";
import type { PiSandboxBindingStore, PiSandboxSupervisorBackend } from "@/src/modules/pi-agent/supervisor/contracts";
import { InMemoryPiSandboxBindingStore } from "@/src/modules/pi-agent/supervisor/store";

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT = 30_000;

class SupervisorHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function safeCode(error: unknown, fallback = "PI_SANDBOX_SUPERVISOR_FAILED"): string {
  const value = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_:-]{1,120}$/.test(value) ? value : fallback;
}

function responseStatus(error: unknown): number {
  if (error instanceof SupervisorHttpError) return error.status;
  const code = safeCode(error);
  if (code.includes("UNAUTHORIZED") || code.includes("TOKEN_INVALID") || code.includes("TOKEN_EXPIRED")) return 401;
  if (code.includes("SCOPE") || code.includes("PROVIDER_MISMATCH")) return 403;
  if (code.includes("NOT_FOUND")) return 404;
  if (code.includes("STATE_CONFLICT") || code.includes("DESTROY_UNVERIFIED")) return 409;
  if (code.includes("UNAVAILABLE") || code.includes("NOT_CONFIGURED") || code.includes("REQUIRED") || code.includes("FIRECRACKER") || code.includes("GUEST_AGENT") || code.includes("CGROUP") || code.includes("PROCESS")) return 503;
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

function object(value: unknown, code = "PI_SANDBOX_REQUEST_INVALID"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SupervisorHttpError(400, code);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, code = "PI_SANDBOX_REQUEST_INVALID"): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new SupervisorHttpError(400, code);
  return value;
}

function sandboxScopeFromSpec(spec: PiSandboxSpec, provider: "firecracker" | "kata"): PiSandboxRunTokenScope {
  return {
    tenantId: stringField(spec.tenantId),
    actorId: stringField(spec.actorId),
    sessionId: stringField(spec.sessionId),
    workspaceId: stringField(spec.workspaceId),
    runId: stringField(spec.runId, "PI_SANDBOX_RUN_ID_REQUIRED"),
    provider,
  };
}

function scopeFromClaims(claims: PiSandboxRunTokenClaims): PiSandboxRunTokenScope {
  return {
    tenantId: claims.tenantId,
    actorId: claims.actorId,
    sessionId: claims.sessionId,
    workspaceId: claims.workspaceId,
    runId: claims.runId,
    provider: claims.provider,
    ...(claims.sandboxId === undefined ? {} : { sandboxId: claims.sandboxId }),
  };
}

function projectSandbox(value: PiSandbox): PiSandbox {
  if (typeof value.id !== "string" || !value.id || typeof value.root !== "string" || !value.root) throw new SupervisorHttpError(502, "PI_SANDBOX_SUPERVISOR_RESPONSE_INVALID");
  if (value.provider !== "firecracker" && value.provider !== "kata") throw new SupervisorHttpError(502, "PI_SANDBOX_SUPERVISOR_PROVIDER_INVALID");
  if (!value.tenantId || !value.actorId || !value.sessionId || !value.workspaceId || !value.runId) throw new SupervisorHttpError(502, "PI_SANDBOX_SUPERVISOR_RESPONSE_SCOPE_MISSING");
  return {
    id: value.id,
    root: value.root,
    provider: value.provider,
    tenantId: value.tenantId,
    actorId: value.actorId,
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
    runId: value.runId,
  };
}

function assertSandboxScope(sandbox: PiSandbox, scope: PiSandboxRunTokenScope): void {
  if (sandbox.id !== scope.sandboxId || sandbox.provider !== scope.provider || sandbox.tenantId !== scope.tenantId || sandbox.actorId !== scope.actorId || sandbox.sessionId !== scope.sessionId || sandbox.workspaceId !== scope.workspaceId || sandbox.runId !== scope.runId) {
    throw new SupervisorHttpError(403, "PI_SANDBOX_SUPERVISOR_SCOPE_MISMATCH");
  }
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new SupervisorHttpError(413, "PI_SANDBOX_SUPERVISOR_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new SupervisorHttpError(400, "PI_SANDBOX_SUPERVISOR_JSON_INVALID"); }
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !/^Bearer [^\s]+$/.test(value)) throw new SupervisorHttpError(401, "PI_SANDBOX_SUPERVISOR_UNAUTHORIZED");
  return value.slice("Bearer ".length);
}

function assertNoCredentialFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialFields(item);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|authorization|credential|private.?key/i.test(key)) throw new SupervisorHttpError(400, "PI_SANDBOX_SUPERVISOR_CREDENTIAL_IN_BODY");
    assertNoCredentialFields(child);
  }
}

export type PiSandboxSupervisorServerOptions = {
  backend: PiSandboxSupervisorBackend;
  tokenVerifier?: PiSandboxRunTokenVerifier;
  bindingStore?: PiSandboxBindingStore;
  now?: () => Date;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
};

export function createPiSandboxSupervisorServer(options: PiSandboxSupervisorServerOptions): Server {
  const store = options.bindingStore ?? new InMemoryPiSandboxBindingStore();
  const now = options.now ?? (() => new Date());
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
  let initialized: Promise<void> | undefined;

  const ensureInitialized = async () => {
    initialized ??= store.initialize();
    await initialized;
  };

  const verify = (request: IncomingMessage, expected?: PiSandboxRunTokenScope): PiSandboxRunTokenClaims => {
    if (!options.tokenVerifier) throw new SupervisorHttpError(503, "PI_SANDBOX_RUN_TOKEN_SECRET_REQUIRED");
    try {
      return options.tokenVerifier.verify(bearer(request), expected, now());
    } catch {
      throw new SupervisorHttpError(401, "PI_SANDBOX_SUPERVISOR_UNAUTHORIZED");
    }
  };

  const ready = async (): Promise<{ ready: boolean; code?: string }> => {
    if (!options.tokenVerifier) return { ready: false, code: "PI_SANDBOX_RUN_TOKEN_SECRET_REQUIRED" };
    try {
      await ensureInitialized();
      return await options.backend.readiness();
    } catch {
      return { ready: false, code: "PI_SANDBOX_SUPERVISOR_NOT_READY" };
    }
  };

  const createSandbox = async (request: IncomingMessage): Promise<{ status: number; body: unknown }> => {
    const payload = object(await readJson(request, maxBodyBytes));
    assertNoCredentialFields(payload);
    const provider = payload.provider;
    if (provider !== "firecracker" && provider !== "kata") throw new SupervisorHttpError(400, "PI_SANDBOX_PROVIDER_INVALID");
    if (options.backend.kind !== provider) throw new SupervisorHttpError(503, "PI_SANDBOX_SUPERVISOR_PROVIDER_NOT_READY");
    const spec = object(payload.spec, "PI_SANDBOX_SPEC_INVALID") as unknown as PiSandboxSpec;
    const expected = sandboxScopeFromSpec(spec, provider);
    const claims = verify(request, expected);
    if (claims.sandboxId !== undefined) throw new SupervisorHttpError(401, "PI_SANDBOX_SUPERVISOR_UNAUTHORIZED");
    const sandbox = projectSandbox(await options.backend.create(spec));
    if (sandbox.provider !== provider || sandbox.tenantId !== claims.tenantId || sandbox.actorId !== claims.actorId || sandbox.sessionId !== claims.sessionId || sandbox.workspaceId !== claims.workspaceId || sandbox.runId !== claims.runId) {
      throw new SupervisorHttpError(502, "PI_SANDBOX_SUPERVISOR_RESPONSE_SCOPE_MISMATCH");
    }
    if (await store.get(sandbox.id)) {
      await options.backend.terminate(sandbox, "duplicate_binding").catch(() => undefined);
      await options.backend.destroy(sandbox).catch(() => undefined);
      throw new SupervisorHttpError(409, "PI_SANDBOX_DUPLICATE");
    }
    try {
      await store.put({ sandbox, scope: scopeFromClaims(claims), createdAt: now().toISOString() });
    } catch {
      await options.backend.terminate(sandbox, "binding_persist_failed").catch(() => undefined);
      await options.backend.destroy(sandbox).catch(() => undefined);
      throw new SupervisorHttpError(503, "PI_SANDBOX_BINDING_PERSIST_FAILED");
    }
    return { status: 201, body: { sandbox } };
  };

  const operation = async (request: IncomingMessage, sandboxId: string, name: string): Promise<{ status: number; body: unknown }> => {
    const binding = await store.get(sandboxId);
    if (!binding) throw new SupervisorHttpError(404, "PI_SANDBOX_NOT_FOUND");
    const expected: PiSandboxRunTokenScope = { ...binding.scope, sandboxId };
    const claims = verify(request, expected);
    assertSandboxScope(binding.sandbox, scopeFromClaims(claims));
    const body = request.method === "GET" ? undefined : await readJson(request, maxBodyBytes);
    if (body !== undefined) assertNoCredentialFields(body);
    switch (name) {
      case "mounts": await options.backend.mountWorkspace(binding.sandbox, object(body) as unknown as PiWorkspaceMount); return { status: 204, body: undefined };
      case "limits": await options.backend.setLimits(binding.sandbox, object(body) as unknown as PiSandboxLimits); return { status: 204, body: undefined };
      case "network-policy": await options.backend.applyNetworkPolicy(binding.sandbox, object(body) as never); return { status: 204, body: undefined };
      case "read": return { status: 200, body: await options.backend.read(binding.sandbox, stringField(object(body).path, "PI_SANDBOX_PATH_INVALID")) };
      case "list": return { status: 200, body: { items: await options.backend.list(binding.sandbox, stringField(object(body).path, "PI_SANDBOX_PATH_INVALID")) } };
      case "write": {
        const value = object(body);
        return { status: 200, body: await options.backend.write(binding.sandbox, stringField(value.path, "PI_SANDBOX_PATH_INVALID"), stringField(value.content, "PI_SANDBOX_CONTENT_INVALID")) };
      }
      case "patch": {
        const value = object(body);
        return { status: 200, body: await options.backend.applyPatch(binding.sandbox, stringField(value.path, "PI_SANDBOX_PATH_INVALID"), stringField(value.oldText, "PI_SANDBOX_PATCH_INVALID"), stringField(value.newText, "PI_SANDBOX_PATCH_INVALID")) };
      }
      case "exec": return { status: 200, body: await options.backend.run(binding.sandbox, stringField(object(body).command, "PI_SANDBOX_COMMAND_INVALID")) as PiSandboxResult };
      case "snapshot": return { status: 200, body: await options.backend.snapshot(binding.sandbox) };
      case "usage": return { status: 200, body: await options.backend.collectUsage(binding.sandbox) as PiSandboxUsage };
      case "terminate": await options.backend.terminate(binding.sandbox, stringField(object(body).reason ?? "supervisor_request", "PI_SANDBOX_REASON_INVALID")); return { status: 204, body: undefined };
      case "destroy": {
        await options.backend.destroy(binding.sandbox);
        const destroyed = await options.backend.verifyDestroyed(binding.sandbox);
        if (!destroyed) throw new SupervisorHttpError(409, "PI_SANDBOX_DESTROY_UNVERIFIED");
        await store.delete(sandboxId);
        return { status: 200, body: { destroyed: true, status: "destroyed" } };
      }
      case "status": {
        const destroyed = await options.backend.verifyDestroyed(binding.sandbox);
        return { status: 200, body: { destroyed, status: destroyed ? "destroyed" : "running" } };
      }
      default: throw new SupervisorHttpError(404, "PI_SANDBOX_OPERATION_NOT_FOUND");
    }
  };

  const server = createServer((request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    request.setTimeout(requestTimeoutMs);
    request.once("timeout", () => request.destroy(new Error("PI_SANDBOX_SUPERVISOR_REQUEST_TIMEOUT")));
    void (async () => {
      try {
        const pathname = new URL(request.url ?? "/", "http://sandbox-supervisor").pathname;
        if (request.method === "GET" && pathname === "/healthz") return writeJson(response, 200, { status: "ok" });
        if (request.method === "GET" && pathname === "/readyz") {
          const result = await ready();
          return writeJson(response, result.ready ? 200 : 503, result.ready ? { status: "ready" } : { status: "not_ready", code: result.code });
        }
        const parts = pathname.split("/").filter(Boolean);
        if (request.method === "POST" && parts.join("/") === "v1/sandboxes/create") {
          const result = await createSandbox(request);
          return writeJson(response, result.status, result.body);
        }
        if (parts.length === 4 && parts[0] === "v1" && parts[1] === "sandboxes") {
          const sandboxId = decodeURIComponent(parts[2]);
          const result = await operation(request, sandboxId, parts[3]);
          if (result.status === 204) {
            response.statusCode = 204;
            return response.end();
          }
          return writeJson(response, result.status, result.body);
        }
        throw new SupervisorHttpError(404, "PI_SANDBOX_SUPERVISOR_ROUTE_NOT_FOUND");
      } catch (error) {
        if (response.headersSent) { response.destroy(); return; }
        const code = error instanceof SupervisorHttpError ? error.code : safeCode(error);
        writeJson(response, responseStatus(error), { error: { code } });
      }
    })();
  });
  server.headersTimeout = requestTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  return server;
}
