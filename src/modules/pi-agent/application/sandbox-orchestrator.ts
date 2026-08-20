import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type {
  PiEgressPolicy,
  PiSandbox,
  PiSandboxLimits,
  PiSandboxProvider,
  PiSandboxRunRecord,
  PiSandboxRunStore,
  PiSandboxUsage,
  PiSandboxSpec,
  PiWorkspaceMount,
} from "@/src/modules/pi-agent/domain/contracts";
import { defaultEgressPolicyCompiler } from "@/src/modules/pi-agent/application/sandbox-policy";
import type { PiRunnerFaultContext, PiRunnerFaultInjector } from "@/src/modules/pi-agent/application/runner-faults";
import { noopPiRunnerFaultInjector } from "@/src/modules/pi-agent/application/runner-faults";

export const DEFAULT_PI_SANDBOX_LIMITS: PiSandboxLimits = {
  cpuMillis: 2_000,
  memoryBytes: 1_073_741_824,
  pids: 256,
  diskBytes: 5_368_709_120,
  maxDurationMs: 600_000,
  maxOutputBytes: 1_000_000,
};

type CreateSandboxInput = {
  sandboxRunId?: string;
  runId: string;
  workspaceId: string;
  profile: PiSandboxSpec["profile"];
  repositoryId?: string;
  baseCommit?: string;
  networkPolicy: PiSandboxSpec["networkPolicy"];
  egressPolicy?: PiEgressPolicy;
  limits?: Partial<PiSandboxLimits>;
  imageDigest?: string;
  workspaceMount?: PiWorkspaceMount;
};

type SandboxHandle = {
  sandbox: PiSandbox;
  recordId: string;
};

function assertSandboxBinding(sandbox: PiSandbox, context: RequestContext, input: Pick<CreateSandboxInput, "runId" | "workspaceId" | "profile">, provider: PiSandboxProvider["kind"]): void {
  if (sandbox.provider !== provider) throw new Error("PI_SANDBOX_PROVIDER_MISMATCH");
  if (sandbox.tenantId !== context.tenantId || sandbox.actorId !== context.actorId || sandbox.sessionId !== context.sessionId || sandbox.workspaceId !== input.workspaceId || sandbox.runId !== input.runId) {
    throw new Error("PI_SANDBOX_SCOPE_MISMATCH");
  }
  if (sandbox.id.length === 0 || sandbox.root.length === 0) throw new Error("PI_SANDBOX_HANDLE_INVALID");
}

function mergeLimits(input: Partial<PiSandboxLimits> | undefined): PiSandboxLimits {
  const limits = { ...DEFAULT_PI_SANDBOX_LIMITS, ...input };
  if (!Number.isInteger(limits.cpuMillis) || limits.cpuMillis < 100 || limits.cpuMillis > 64_000) throw new Error("PI_SANDBOX_CPU_LIMIT_INVALID");
  if (!Number.isInteger(limits.memoryBytes) || limits.memoryBytes < 64 * 1024 * 1024 || limits.memoryBytes > 256 * 1024 * 1024 * 1024) throw new Error("PI_SANDBOX_MEMORY_LIMIT_INVALID");
  if (!Number.isInteger(limits.pids) || limits.pids < 16 || limits.pids > 16_384) throw new Error("PI_SANDBOX_PID_LIMIT_INVALID");
  if (!Number.isInteger(limits.diskBytes) || limits.diskBytes < 16 * 1024 * 1024 || limits.diskBytes > 1024 * 1024 * 1024 * 1024) throw new Error("PI_SANDBOX_DISK_LIMIT_INVALID");
  if (!Number.isInteger(limits.maxDurationMs) || limits.maxDurationMs < 1_000 || limits.maxDurationMs > 24 * 60 * 60 * 1000) throw new Error("PI_SANDBOX_DURATION_LIMIT_INVALID");
  if (!Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1_024 || limits.maxOutputBytes > 100 * 1024 * 1024) throw new Error("PI_SANDBOX_OUTPUT_LIMIT_INVALID");
  return limits;
}

function assertDigest(value: string | undefined): void {
  if (value !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("PI_SANDBOX_IMAGE_DIGEST_INVALID");
}

function failureCode(error: unknown): string {
  return error instanceof Error ? error.message.split(":")[0] || "PI_SANDBOX_PROVISION_FAILED" : "PI_SANDBOX_PROVISION_FAILED";
}

export class SandboxOrchestrator {
  private readonly handles = new Map<string, SandboxHandle>();

  constructor(
    private readonly provider: PiSandboxProvider,
    private readonly runs: PiSandboxRunStore,
    private readonly faults: PiRunnerFaultInjector = noopPiRunnerFaultInjector,
  ) {}

  async createSandbox(context: RequestContext, input: CreateSandboxInput, signal?: AbortSignal): Promise<PiSandbox> {
    if (!context.tenantId || !context.actorId || !input.runId || !input.workspaceId) throw new Error("PI_SANDBOX_INPUT_INVALID");
    assertDigest(input.imageDigest);
    if (process.env.NODE_ENV === "production" && (this.provider.kind === "virtual" || this.provider.kind === "unavailable")) {
      throw new Error("PI_SANDBOX_PROVIDER_NOT_ALLOWED");
    }
    if (process.env.NODE_ENV === "production" && this.provider.kind !== "firecracker" && this.provider.kind !== "kata") {
      throw new Error("PI_SANDBOX_PROVIDER_NOT_ALLOWED");
    }

    const limits = mergeLimits(input.limits);
    const egressPolicy = defaultEgressPolicyCompiler.compile(input.egressPolicy ?? { mode: input.networkPolicy });
    const sandboxRunId = input.sandboxRunId ?? randomUUID();
    const createdAt = new Date().toISOString();
    const record: PiSandboxRunRecord = {
      id: sandboxRunId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      sessionId: context.sessionId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      provider: this.provider.kind,
      imageDigest: input.imageDigest,
      networkPolicy: input.networkPolicy,
      networkPolicySpec: egressPolicy,
      networkPolicyDigest: egressPolicy.digest,
      limits,
      status: "provisioning",
      destroyVerified: false,
      createdAt,
      updatedAt: createdAt,
    };
    await this.runs.create(record);

    let sandbox: PiSandbox | undefined;
    try {
      const spec: PiSandboxSpec = {
        tenantId: context.tenantId,
        actorId: context.actorId,
        sessionId: context.sessionId,
        workspaceId: input.workspaceId,
        profile: input.profile,
        repositoryId: input.repositoryId,
        baseCommit: input.baseCommit,
        networkPolicy: input.networkPolicy,
        runId: input.runId,
        imageDigest: input.imageDigest,
        limits,
        egressPolicy: input.egressPolicy ?? { mode: input.networkPolicy },
      };
      const faultContext: PiRunnerFaultContext = { tenantId: context.tenantId, actorId: context.actorId, sessionId: context.sessionId, runId: input.runId };
      await this.faults.checkpoint("before_sandbox_create", faultContext);
      sandbox = await this.provider.create(spec, signal);
      assertSandboxBinding(sandbox, context, input, this.provider.kind);
      // Persist the external handle before any subsequent lifecycle step.
      // If the Runner dies after provider.create(), lease recovery must be
      // able to terminate the resource instead of treating it as unknown.
      await this.runs.transition(context, sandboxRunId, "provisioning", { providerSandboxId: sandbox.id });
      await this.faults.checkpoint("after_sandbox_create", { ...faultContext, commandId: sandbox.id });
      await this.faults.checkpoint("before_sandbox_limits", { ...faultContext, commandId: sandbox.id });
      await this.provider.setLimits(sandbox, limits, signal);
      await this.faults.checkpoint("after_sandbox_limits", { ...faultContext, commandId: sandbox.id });
      await this.faults.checkpoint("before_sandbox_network", { ...faultContext, commandId: sandbox.id });
      await this.provider.applyNetworkPolicy(sandbox, egressPolicy, signal);
      await this.faults.checkpoint("after_sandbox_network", { ...faultContext, commandId: sandbox.id });
      if (input.workspaceMount) {
        await this.faults.checkpoint("before_workspace_mount", { ...faultContext, commandId: sandbox.id });
        await this.provider.mountWorkspace(sandbox, input.workspaceMount, signal);
        await this.faults.checkpoint("after_workspace_mount", { ...faultContext, commandId: sandbox.id });
      }
      this.handles.set(sandbox.id, { sandbox, recordId: sandboxRunId });
      await this.runs.transition(context, sandboxRunId, "running", {
        providerSandboxId: sandbox.id,
        startedAt: new Date().toISOString(),
      });
      return sandbox;
    } catch (error) {
      const code = failureCode(error);
      let destroyed = false;
      if (sandbox) {
        await this.provider.terminate(sandbox, code).catch(() => undefined);
        await this.provider.destroy(sandbox).catch(() => undefined);
        destroyed = await this.provider.verifyDestroyed(sandbox).catch(() => false);
        this.handles.delete(sandbox.id);
      }
      await this.runs.transition(context, sandboxRunId, destroyed ? "failed" : "unknown", {
        failureCode: code,
        destroyVerified: destroyed,
        completedAt: new Date().toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Reconstructs the provider handle from the durable sandbox record after a
   * Runner process disappears. This is deliberately called only while
   * reclaiming an expired lease; a live lease never gets a second owner.
   */
  async recoverRun(context: RequestContext, runId: string): Promise<boolean> {
    let record = await this.runs.getByRun(context, runId);
    if (!record || record.status === "destroyed") return true;
    if (!record.providerSandboxId) {
      await this.runs.transition(context, record.id, "unknown", { failureCode: "PI_SANDBOX_RECOVERY_HANDLE_MISSING", destroyVerified: false, completedAt: new Date().toISOString() }).catch(() => undefined);
      return false;
    }
    const recordId = record.id;
    if (record.provider !== this.provider.kind) {
      await this.runs.transition(context, recordId, "unknown", { failureCode: "PI_SANDBOX_PROVIDER_MISMATCH", destroyVerified: false, completedAt: new Date().toISOString() }).catch(() => undefined);
      return false;
    }
    const sandbox: PiSandbox = {
      id: record.providerSandboxId,
      root: `recovered://${record.tenantId}/${record.runId}`,
      provider: record.provider,
      tenantId: record.tenantId,
      actorId: record.actorId,
      sessionId: record.sessionId,
      workspaceId: record.workspaceId,
      runId: record.runId,
    };
    try {
      if (record.status !== "terminating") {
        await this.runs.transition(context, recordId, "terminating", { terminationReason: "lease_recovery" });
        record = await this.runs.get(context, recordId);
        if (!record) throw new Error("PI_SANDBOX_RUN_NOT_FOUND");
      }
      await this.provider.terminate(sandbox, "lease_recovery");
      await this.provider.destroy(sandbox);
      const verified = await this.provider.verifyDestroyed(sandbox);
      const finalRecord = await this.runs.transition(context, recordId, verified ? "destroyed" : "unknown", {
        failureCode: verified ? undefined : "PI_SANDBOX_DESTROY_UNVERIFIED",
        destroyVerified: verified,
        completedAt: new Date().toISOString(),
      });
      return verified && finalRecord.status === "destroyed" && finalRecord.destroyVerified;
    } catch (error) {
      await this.runs.transition(context, recordId, "unknown", {
        failureCode: failureCode(error),
        destroyVerified: false,
        completedAt: new Date().toISOString(),
      }).catch(() => undefined);
      return false;
    }
  }

  async hasRunRecord(context: RequestContext, runId: string): Promise<boolean> {
    return Boolean(await this.runs.getByRun(context, runId));
  }

  async mountWorkspace(context: RequestContext, sandbox: PiSandbox, mount: PiWorkspaceMount, signal?: AbortSignal): Promise<void> {
    await this.requireHandle(context, sandbox);
    await this.provider.mountWorkspace(sandbox, mount, signal);
  }

  async exec(context: RequestContext, sandbox: PiSandbox, command: string, signal?: AbortSignal) {
    await this.requireHandle(context, sandbox);
    return this.provider.run(sandbox, command, signal);
  }

  async read(context: RequestContext, sandbox: PiSandbox, path: string) {
    await this.requireHandle(context, sandbox);
    return this.provider.read(sandbox, path);
  }

  async list(context: RequestContext, sandbox: PiSandbox, path: string) {
    await this.requireHandle(context, sandbox);
    return this.provider.list(sandbox, path);
  }

  async write(context: RequestContext, sandbox: PiSandbox, path: string, content: string) {
    await this.requireHandle(context, sandbox);
    return this.provider.write(sandbox, path, content);
  }

  async applyPatch(context: RequestContext, sandbox: PiSandbox, path: string, oldText: string, newText: string) {
    await this.requireHandle(context, sandbox);
    return this.provider.applyPatch(sandbox, path, oldText, newText);
  }

  async snapshot(context: RequestContext, sandbox: PiSandbox) {
    await this.requireHandle(context, sandbox);
    return this.provider.snapshot(sandbox);
  }

  async collectUsage(context: RequestContext, sandbox: PiSandbox): Promise<PiSandboxUsage> {
    const handle = await this.requireHandle(context, sandbox);
    const usage = await this.provider.collectUsage(sandbox);
    await this.runs.transition(context, handle.recordId, (await this.runs.get(context, handle.recordId))?.status ?? "running", { usage });
    return usage;
  }

  async terminate(context: RequestContext, sandbox: PiSandbox, reason: string): Promise<void> {
    const handle = await this.requireHandle(context, sandbox);
    const record = await this.runs.get(context, handle.recordId);
    if (!record) throw new Error("PI_SANDBOX_RUN_NOT_FOUND");
    if (record.status !== "terminating" && record.status !== "destroyed") await this.runs.transition(context, handle.recordId, "terminating", { terminationReason: reason.slice(0, 500) });
    if (record.status !== "destroyed") await this.provider.terminate(sandbox, reason.slice(0, 500));
  }

  async destroy(context: RequestContext, sandbox: PiSandbox): Promise<boolean> {
    const handle = await this.requireHandle(context, sandbox);
    let record = await this.runs.get(context, handle.recordId);
    if (!record) throw new Error("PI_SANDBOX_RUN_NOT_FOUND");
    try {
      if (record.status !== "terminating" && record.status !== "destroyed") await this.terminate(context, sandbox, "orchestrator_destroy");
      record = await this.runs.get(context, handle.recordId);
      if (!record) throw new Error("PI_SANDBOX_RUN_NOT_FOUND");
      if (record.status !== "destroyed") await this.provider.destroy(sandbox);
      const verified = await this.provider.verifyDestroyed(sandbox);
      if (!verified) {
        await this.runs.transition(context, handle.recordId, "unknown", { failureCode: "PI_SANDBOX_DESTROY_UNVERIFIED", destroyVerified: false, completedAt: new Date().toISOString() });
        return false;
      }
      if (record.status !== "destroyed") await this.runs.transition(context, handle.recordId, "destroyed", { destroyVerified: true, completedAt: new Date().toISOString() });
      this.handles.delete(sandbox.id);
      return true;
    } catch (error) {
      await this.runs.transition(context, handle.recordId, "unknown", { failureCode: failureCode(error), destroyVerified: false, completedAt: new Date().toISOString() }).catch(() => undefined);
      throw error;
    }
  }

  async getRun(context: RequestContext, sandboxRunId: string): Promise<PiSandboxRunRecord> {
    const record = await this.runs.get(context, sandboxRunId);
    if (!record) throw new Error("PI_SANDBOX_RUN_NOT_FOUND");
    return record;
  }

  private async requireHandle(context: RequestContext, sandbox: PiSandbox): Promise<SandboxHandle> {
    if (sandbox.tenantId && sandbox.tenantId !== context.tenantId) throw new Error("PI_SANDBOX_TENANT_DENIED");
    if (sandbox.actorId && sandbox.actorId !== context.actorId) throw new Error("PI_SANDBOX_ACTOR_DENIED");
    if (sandbox.sessionId && sandbox.sessionId !== context.sessionId) throw new Error("PI_SANDBOX_SESSION_DENIED");
    const handle = this.handles.get(sandbox.id);
    if (!handle) throw new Error("PI_SANDBOX_HANDLE_NOT_FOUND");
    const record = await this.runs.get(context, handle.recordId);
    if (!record || record.providerSandboxId !== sandbox.id) throw new Error("PI_SANDBOX_NOT_FOUND");
    if (record.actorId !== context.actorId || record.sessionId !== context.sessionId || record.workspaceId !== sandbox.workspaceId || record.runId !== sandbox.runId || record.provider !== sandbox.provider) throw new Error("PI_SANDBOX_SCOPE_MISMATCH");
    if (["destroyed", "unknown"].includes(record.status)) throw new Error("PI_SANDBOX_NOT_RUNNING");
    return handle;
  }
}
