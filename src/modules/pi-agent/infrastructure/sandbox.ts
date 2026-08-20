import { createHash, randomUUID } from "node:crypto";
import type {
  PiSandbox,
  PiCompiledEgressPolicy,
  PiSandboxFile,
  PiSandboxLimits,
  PiSandboxProvider,
  PiSandboxResult,
  PiSandboxSpec,
  PiSandboxUsage,
  PiWorkspaceMount,
} from "@/src/modules/pi-agent/domain/contracts";
import { HttpSandboxSupervisorClient, RemoteMicroVMSandboxProvider } from "@/src/modules/pi-agent/infrastructure/microvm-sandbox";
import { createPiSandboxRunTokenIssuerFromEnv } from "@/src/modules/pi-agent/application/sandbox-token";

function normalizeSandboxPath(input: string): string {
  const value = input.trim().replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) throw new Error("PI_SANDBOX_PATH_INVALID");
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) throw new Error("PI_SANDBOX_PATH_INVALID");
  const normalized = parts.join("/");
  if (normalized.length > 512) throw new Error("PI_SANDBOX_PATH_TOO_LONG");
  return normalized;
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

type VirtualState = {
  spec: PiSandboxSpec;
  files: Map<string, string>;
  limits?: PiSandboxLimits;
  networkPolicy?: PiCompiledEgressPolicy;
  status: "running" | "terminating";
};

/**
 * Development/test provider. It never touches the host filesystem and never spawns a process.
 * Production must use the Firecracker/Kata provider behind the same interface.
 */
export class VirtualSandboxProvider implements PiSandboxProvider {
  readonly kind = "virtual" as const;
  private readonly states = new Map<string, VirtualState>();

  async create(spec: PiSandboxSpec, _signal?: AbortSignal): Promise<PiSandbox> {
    void _signal;
    const id = randomUUID();
    this.states.set(id, { spec, files: new Map(), limits: spec.limits, status: "running" });
    return {
      id,
      root: `virtual://${spec.tenantId}/${spec.sessionId}`,
      provider: "virtual",
      tenantId: spec.tenantId,
      actorId: spec.actorId,
      sessionId: spec.sessionId,
      workspaceId: spec.workspaceId,
      runId: spec.runId,
    };
  }

  private state(sandbox: PiSandbox): VirtualState {
    const state = this.states.get(sandbox.id);
    if (!state) throw new Error("PI_SANDBOX_NOT_FOUND");
    return state;
  }

  private activeState(sandbox: PiSandbox): VirtualState {
    const state = this.state(sandbox);
    if (state.status !== "running") throw new Error("PI_SANDBOX_NOT_RUNNING");
    return state;
  }

  async mountWorkspace(sandbox: PiSandbox, mount: PiWorkspaceMount, _signal?: AbortSignal): Promise<void> {
    void _signal;
    normalizeSandboxPath(mount.targetPath);
    if (!mount.sourceRef.trim()) throw new Error("PI_SANDBOX_MOUNT_INVALID");
    this.activeState(sandbox);
  }

  async setLimits(sandbox: PiSandbox, limits: PiSandboxLimits, _signal?: AbortSignal): Promise<void> {
    void _signal;
    this.activeState(sandbox).limits = limits;
  }

  async applyNetworkPolicy(sandbox: PiSandbox, policy: PiCompiledEgressPolicy, _signal?: AbortSignal): Promise<void> {
    void _signal;
    this.activeState(sandbox).networkPolicy = policy;
  }

  async read(sandbox: PiSandbox, path: string): Promise<PiSandboxFile> {
    const normalized = normalizeSandboxPath(path);
    const content = this.activeState(sandbox).files.get(normalized);
    if (content === undefined) throw new Error("PI_SANDBOX_FILE_NOT_FOUND");
    return { path: normalized, content, digest: digest(content) };
  }

  async list(sandbox: PiSandbox, path: string): Promise<string[]> {
    const prefix = path.trim() ? `${normalizeSandboxPath(path)}/` : "";
    const values = new Set<string>();
    for (const key of this.activeState(sandbox).files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      values.add(rest.split("/")[0]);
    }
    return [...values].sort();
  }

  async write(sandbox: PiSandbox, path: string, content: string): Promise<PiSandboxFile> {
    const normalized = normalizeSandboxPath(path);
    if (content.length > 2_000_000) throw new Error("PI_SANDBOX_FILE_TOO_LARGE");
    this.activeState(sandbox).files.set(normalized, content);
    return { path: normalized, content, digest: digest(content) };
  }

  async applyPatch(sandbox: PiSandbox, path: string, oldText: string, newText: string): Promise<PiSandboxFile> {
    const current = await this.read(sandbox, path);
    if (!current.content.includes(oldText)) throw new Error("PI_SANDBOX_PATCH_CONTEXT_NOT_FOUND");
    return this.write(sandbox, current.path, current.content.replace(oldText, newText));
  }

  async run(sandbox?: PiSandbox): Promise<PiSandboxResult> {
    if (sandbox) this.activeState(sandbox);
    return {
      ok: false,
      output: "当前开发沙盒是无进程虚拟沙盒；生产环境必须切换到 Firecracker/Kata Runner。",
      exitCode: 126,
      errorCode: "PI_SANDBOX_EXECUTION_DISABLED",
    };
  }

  async snapshot(sandbox: PiSandbox): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }> {
    const files = [...this.activeState(sandbox).files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => ({ path, content, digest: digest(content) }));
    const serialized = JSON.stringify(files);
    return { files, diff: files.map((file) => `+++ ${file.path}\n${file.content}`).join("\n"), digest: digest(serialized) };
  }

  async collectUsage(sandbox: PiSandbox): Promise<PiSandboxUsage> {
    const state = this.activeState(sandbox);
    const diskBytes = [...state.files.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0);
    return { cpuMillis: 0, memoryBytesPeak: 0, pidsPeak: 0, diskBytes, outputBytes: 0, collectedAt: new Date().toISOString() };
  }

  async terminate(sandbox: PiSandbox): Promise<void> {
    const state = this.state(sandbox);
    if (state.status === "running") state.status = "terminating";
  }

  async destroy(sandbox: PiSandbox): Promise<void> {
    this.states.delete(sandbox.id);
  }

  async verifyDestroyed(sandbox: PiSandbox): Promise<boolean> {
    return !this.states.has(sandbox.id);
  }
}

export class FailClosedSandboxProvider implements PiSandboxProvider {
  readonly kind = "unavailable" as const;
  private unavailable(): never {
    throw new Error("PI_SANDBOX_PROVIDER_UNAVAILABLE");
  }

  create(): Promise<PiSandbox> { return this.unavailable(); }
  mountWorkspace(): Promise<void> { return this.unavailable(); }
  setLimits(): Promise<void> { return this.unavailable(); }
  applyNetworkPolicy(): Promise<void> { return this.unavailable(); }
  read(): Promise<PiSandboxFile> { return this.unavailable(); }
  list(): Promise<string[]> { return this.unavailable(); }
  write(): Promise<PiSandboxFile> { return this.unavailable(); }
  applyPatch(): Promise<PiSandboxFile> { return this.unavailable(); }
  run(): Promise<PiSandboxResult> { return this.unavailable(); }
  snapshot(): Promise<{ files: PiSandboxFile[]; diff: string; digest: string }> { return this.unavailable(); }
  collectUsage(): Promise<PiSandboxUsage> { return this.unavailable(); }
  terminate(): Promise<void> { return this.unavailable(); }
  destroy(): Promise<void> { return this.unavailable(); }
  verifyDestroyed(): Promise<boolean> { return this.unavailable(); }
}

export function createPiSandboxProvider(): PiSandboxProvider {
  if (process.env.NEXUS_PI_SANDBOX_PROVIDER === "virtual" && process.env.NODE_ENV !== "production") {
    return new VirtualSandboxProvider();
  }
  const requested = process.env.NEXUS_PI_SANDBOX_PROVIDER;
  const endpoint = process.env.NEXUS_PI_SANDBOX_ENDPOINT;
  if ((requested === "firecracker" || requested === "kata") && endpoint) {
    try {
      return new RemoteMicroVMSandboxProvider(requested, new HttpSandboxSupervisorClient(endpoint, { tokenIssuer: createPiSandboxRunTokenIssuerFromEnv() }));
    } catch {
      return new FailClosedSandboxProvider();
    }
  }
  return new FailClosedSandboxProvider();
}
