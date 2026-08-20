import type {
  PiCompiledEgressPolicy,
  PiSandbox,
  PiSandboxFile,
  PiSandboxLimits,
  PiSandboxProvider,
  PiSandboxResult,
  PiSandboxSpec,
  PiSandboxUsage,
  PiWorkspaceMount,
} from "@/src/modules/pi-agent/domain/contracts";
import type { PiSandboxRunTokenIssuer, PiSandboxRunTokenScope } from "@/src/modules/pi-agent/application/sandbox-token";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type HttpSandboxSupervisorClientOptions = {
  tokenIssuer: PiSandboxRunTokenIssuer;
  fetcher?: FetchLike;
  now?: () => Date;
};

function supervisorError(status: number, code?: string): Error {
  return new Error(code && /^[A-Z0-9_:-]{1,100}$/.test(code) ? code : `PI_SANDBOX_SUPERVISOR_HTTP_${status}`);
}

export class HttpSandboxSupervisorClient {
  private readonly baseUrl: URL;
  private readonly fetcher: FetchLike;
  private readonly tokenIssuer: PiSandboxRunTokenIssuer;
  private readonly now: () => Date;

  constructor(endpoint: string, options: HttpSandboxSupervisorClientOptions) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("PI_SANDBOX_SUPERVISOR_TLS_REQUIRED");
    if (url.username || url.password || url.search || url.hash) throw new Error("PI_SANDBOX_SUPERVISOR_ENDPOINT_INVALID");
    this.baseUrl = new URL(url.toString().replace(/\/$/, "") + "/");
    this.fetcher = options.fetcher ?? fetch;
    this.tokenIssuer = options.tokenIssuer;
    this.now = options.now ?? (() => new Date());
  }

  private url(path: string): URL {
    if (!path.startsWith("v1/sandboxes/")) throw new Error("PI_SANDBOX_SUPERVISOR_PATH_INVALID");
    return new URL(path, this.baseUrl);
  }

  private async request<T>(method: string, path: string, scope: PiSandboxRunTokenScope, body?: unknown, signal?: AbortSignal): Promise<T> {
    const runToken = this.tokenIssuer.issue(scope, this.now());
    const response = await this.fetcher(this.url(path), {
      method,
      signal: signal ?? AbortSignal.timeout(15_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${runToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("PI_SANDBOX_SUPERVISOR_RESPONSE_TOO_LARGE");
    let parsed: unknown = undefined;
    if (text) {
      try { parsed = JSON.parse(text); } catch { throw new Error("PI_SANDBOX_SUPERVISOR_RESPONSE_INVALID"); }
    }
    if (!response.ok) {
      const code = parsed && typeof parsed === "object"
        ? ("code" in parsed ? String((parsed as { code: unknown }).code)
          : "error" in parsed && parsed.error && typeof parsed.error === "object" && "code" in parsed.error ? String((parsed.error as { code: unknown }).code) : undefined)
        : undefined;
      throw supervisorError(response.status, code);
    }
    return parsed as T;
  }

  private scopeFromSpec(kind: "firecracker" | "kata", spec: PiSandboxSpec): PiSandboxRunTokenScope {
    if (!spec.runId) throw new Error("PI_SANDBOX_RUN_TOKEN_CONTEXT_MISSING");
    return {
      tenantId: spec.tenantId,
      actorId: spec.actorId,
      sessionId: spec.sessionId,
      workspaceId: spec.workspaceId,
      runId: spec.runId,
      provider: kind,
    };
  }

  private scopeFromSandbox(sandbox: PiSandbox): PiSandboxRunTokenScope {
    if (!sandbox.tenantId || !sandbox.actorId || !sandbox.sessionId || !sandbox.workspaceId || !sandbox.runId || (sandbox.provider !== "firecracker" && sandbox.provider !== "kata")) {
      throw new Error("PI_SANDBOX_RUN_TOKEN_CONTEXT_MISSING");
    }
    return {
      tenantId: sandbox.tenantId,
      actorId: sandbox.actorId,
      sessionId: sandbox.sessionId,
      workspaceId: sandbox.workspaceId,
      runId: sandbox.runId,
      provider: sandbox.provider,
      sandboxId: sandbox.id,
    };
  }

  private bindSandbox(kind: "firecracker" | "kata", spec: PiSandboxSpec, value: PiSandbox): PiSandbox {
    const scope = this.scopeFromSpec(kind, spec);
    if (!value || typeof value.id !== "string" || !value.id || typeof value.root !== "string" || !value.root || value.provider !== kind) {
      throw new Error("PI_SANDBOX_SUPERVISOR_RESPONSE_INVALID");
    }
    if (value.tenantId !== scope.tenantId || value.actorId !== scope.actorId || value.sessionId !== scope.sessionId || value.runId !== scope.runId || (value.workspaceId !== undefined && value.workspaceId !== scope.workspaceId)) {
      throw new Error("PI_SANDBOX_SUPERVISOR_SCOPE_MISMATCH");
    }
    return { ...value, tenantId: scope.tenantId, actorId: scope.actorId, sessionId: scope.sessionId, workspaceId: scope.workspaceId, runId: scope.runId, provider: kind };
  }

  async create(kind: "firecracker" | "kata", spec: PiSandboxSpec, signal?: AbortSignal): Promise<PiSandbox> {
    const result = await this.request<{ sandbox?: PiSandbox }>("POST", "v1/sandboxes/create", this.scopeFromSpec(kind, spec), { provider: kind, spec }, signal);
    const sandbox = result?.sandbox ?? result as unknown as PiSandbox;
    return this.bindSandbox(kind, spec, sandbox);
  }

  async mountWorkspace(sandbox: PiSandbox, mount: PiWorkspaceMount, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/mounts`, this.scopeFromSandbox(sandbox), mount, signal);
  }

  async setLimits(sandbox: PiSandbox, limits: PiSandboxLimits, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/limits`, this.scopeFromSandbox(sandbox), limits, signal);
  }

  async applyNetworkPolicy(sandbox: PiSandbox, policy: PiCompiledEgressPolicy, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/network-policy`, this.scopeFromSandbox(sandbox), policy, signal);
  }

  async read(sandbox: PiSandbox, path: string): Promise<PiSandboxFile> {
    return this.request("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/read`, this.scopeFromSandbox(sandbox), { path });
  }

  async list(sandbox: PiSandbox, path: string): Promise<string[]> {
    const result = await this.request<{ items?: string[] }>("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/list`, this.scopeFromSandbox(sandbox), { path });
    if (!Array.isArray(result?.items)) throw new Error("PI_SANDBOX_SUPERVISOR_RESPONSE_INVALID");
    return result.items;
  }

  async write(sandbox: PiSandbox, path: string, content: string): Promise<PiSandboxFile> {
    return this.request("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/write`, this.scopeFromSandbox(sandbox), { path, content });
  }

  async applyPatch(sandbox: PiSandbox, path: string, oldText: string, newText: string): Promise<PiSandboxFile> {
    return this.request("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/patch`, this.scopeFromSandbox(sandbox), { path, oldText, newText });
  }

  async run(sandbox: PiSandbox, command: string, signal?: AbortSignal): Promise<PiSandboxResult> {
    return this.request("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/exec`, this.scopeFromSandbox(sandbox), { command }, signal);
  }

  async snapshot(sandbox: PiSandbox): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }> {
    return this.request("GET", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/snapshot`, this.scopeFromSandbox(sandbox));
  }

  async collectUsage(sandbox: PiSandbox): Promise<PiSandboxUsage> {
    return this.request("GET", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/usage`, this.scopeFromSandbox(sandbox));
  }

  async terminate(sandbox: PiSandbox, reason: string): Promise<void> {
    await this.request("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/terminate`, this.scopeFromSandbox(sandbox), { reason });
  }

  async destroy(sandbox: PiSandbox): Promise<void> {
    await this.request("POST", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/destroy`, this.scopeFromSandbox(sandbox));
  }

  async verifyDestroyed(sandbox: PiSandbox): Promise<boolean> {
    try {
      const result = await this.request<{ destroyed?: boolean; status?: string }>("GET", `v1/sandboxes/${encodeURIComponent(sandbox.id)}/status`, this.scopeFromSandbox(sandbox));
      return result.destroyed === true || result.status === "destroyed";
    } catch (error) {
      if (error instanceof Error && error.message === "PI_SANDBOX_SUPERVISOR_HTTP_404") return true;
      throw error;
    }
  }
}

export class RemoteMicroVMSandboxProvider implements PiSandboxProvider {
  readonly kind: "firecracker" | "kata";

  constructor(kind: "firecracker" | "kata", private readonly client: HttpSandboxSupervisorClient) {
    this.kind = kind;
  }

  create(spec: PiSandboxSpec, signal?: AbortSignal): Promise<PiSandbox> { return this.client.create(this.kind, spec, signal); }
  mountWorkspace(sandbox: PiSandbox, mount: PiWorkspaceMount, signal?: AbortSignal): Promise<void> { return this.client.mountWorkspace(sandbox, mount, signal); }
  setLimits(sandbox: PiSandbox, limits: PiSandboxLimits, signal?: AbortSignal): Promise<void> { return this.client.setLimits(sandbox, limits, signal); }
  applyNetworkPolicy(sandbox: PiSandbox, policy: PiCompiledEgressPolicy, signal?: AbortSignal): Promise<void> { return this.client.applyNetworkPolicy(sandbox, policy, signal); }
  read(sandbox: PiSandbox, path: string): Promise<PiSandboxFile> { return this.client.read(sandbox, path); }
  list(sandbox: PiSandbox, path: string): Promise<string[]> { return this.client.list(sandbox, path); }
  write(sandbox: PiSandbox, path: string, content: string): Promise<PiSandboxFile> { return this.client.write(sandbox, path, content); }
  applyPatch(sandbox: PiSandbox, path: string, oldText: string, newText: string): Promise<PiSandboxFile> { return this.client.applyPatch(sandbox, path, oldText, newText); }
  run(sandbox?: PiSandbox, command?: string, signal?: AbortSignal): Promise<PiSandboxResult> {
    if (!sandbox || !command) return Promise.reject(new Error("PI_SANDBOX_INPUT_INVALID"));
    return this.client.run(sandbox, command, signal);
  }
  snapshot(sandbox: PiSandbox): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }> { return this.client.snapshot(sandbox); }
  collectUsage(sandbox: PiSandbox): Promise<PiSandboxUsage> { return this.client.collectUsage(sandbox); }
  terminate(sandbox: PiSandbox, reason: string): Promise<void> { return this.client.terminate(sandbox, reason); }
  destroy(sandbox: PiSandbox): Promise<void> { return this.client.destroy(sandbox); }
  verifyDestroyed(sandbox: PiSandbox): Promise<boolean> { return this.client.verifyDestroyed(sandbox); }
}
