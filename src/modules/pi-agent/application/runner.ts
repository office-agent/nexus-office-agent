import { createHash } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type {
  PiRunCommand,
  PiRunFailure,
  PiRunLease,
  PiRunManifest,
  PiRunStore,
  PiSandbox,
  PiSandboxProvider,
  PiSession,
  PiSessionEvent,
  PiSessionStore,
} from "@/src/modules/pi-agent/domain/contracts";
import { verifyPiRunManifest } from "@/src/modules/pi-agent/application/manifest";
import { createPiRuntime, type PiRuntimeAdapter } from "@/src/modules/pi-agent/infrastructure/runtime-adapter";
import type { SandboxOrchestrator } from "@/src/modules/pi-agent/application/sandbox-orchestrator";
import type { PiWorkspaceRecord } from "@/src/modules/pi-agent/domain/workspace-contracts";
import type { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { computePiValidationPlanDigest, PiValidationFailedError, PiValidationUnknownError, PiWorkspaceValidationService } from "@/src/modules/pi-agent/application/validation-service";
import type { PiValidationPlan, PiValidationRunResult } from "@/src/modules/pi-agent/domain/validation-contracts";
import type { PiResourceRegistryService } from "@/src/modules/pi-agent/application/resource-registry";
import type { ToolGateway } from "@/src/modules/pi-agent/application/tool-gateway";
import type { PiApprovalService } from "@/src/modules/pi-agent/application/approval-service";
import type { PiApprovalObjectVersionReader, PiApproval } from "@/src/modules/pi-agent/domain/approval-contracts";
import type { PiApprovalExecutionPermit } from "@/src/modules/pi-agent/domain/approval-contracts";
import { hasPiRuntimeArtifacts, type PiResourceMaterializer } from "@/src/modules/pi-agent/infrastructure/resource-materializer";
import type { PiSecurityResilienceService } from "@/src/modules/pi-agent/application/security-resilience";
import type { PiRunnerFaultContext, PiRunnerFaultInjector } from "@/src/modules/pi-agent/application/runner-faults";
import { noopPiRunnerFaultInjector } from "@/src/modules/pi-agent/application/runner-faults";
import { PiRunScheduler } from "@/src/modules/pi-agent/application/scheduler";
import { failureFrom, retryAt } from "@/src/platform/workers/contracts";
import type { WorkCycleResult } from "@/src/platform/workers/durable-workers";

type RuntimeFactory = typeof createPiRuntime;

export type PiValidationPlanResolver = (input: {
  context: RequestContext;
  session: PiSession;
  manifest: PiRunManifest;
  workspace: PiWorkspaceRecord;
}) => PiValidationPlan | undefined | Promise<PiValidationPlan | undefined>;

type ActiveRun = {
  runId: string;
  signal: AbortSignal;
  runtime?: PiRuntimeAdapter;
  abort: () => Promise<void>;
};

export type PiRunnerOptions = {
  leaseMs?: number;
  maxTenantConcurrency?: number;
  maxDurationMs?: number;
  heartbeatEventIntervalMs?: number;
  runtimeFactory?: RuntimeFactory;
  sandboxOrchestrator?: SandboxOrchestrator;
  workspaceService?: PiWorkspaceService;
  validationService?: PiWorkspaceValidationService;
  validationPlanResolver?: PiValidationPlanResolver;
  resourceRegistry?: PiResourceRegistryService;
  resourceMaterializer?: PiResourceMaterializer;
  toolGateway?: ToolGateway;
  approvalService?: PiApprovalService;
  approvalObjectVersionReader?: PiApprovalObjectVersionReader;
  approvalPollMs?: number;
  approvalWaitTimeoutMs?: number;
  safetyGate?: PiSecurityResilienceService;
  enforceCapacity?: boolean;
  faultInjector?: PiRunnerFaultInjector;
  scheduler?: PiRunScheduler;
};

function safePayload(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return Number(item);
      if (item instanceof Error) return { name: item.name, message: item.message };
      return item;
    }));
  } catch {
    return { serializationError: true };
  }
}

function validationSummary(result: PiValidationRunResult): unknown {
  return {
    planId: result.planId,
    planVersion: result.planVersion,
    planDigest: result.planDigest,
    status: result.status,
    checks: result.checks.map((check) => ({
      id: check.id,
      kind: check.kind,
      status: check.status,
      exitCode: check.exitCode,
      errorCode: check.errorCode,
      commandDigest: check.commandDigest,
      outputDigest: check.outputDigest,
      outputTruncated: check.outputTruncated,
      artifactId: check.artifactId,
    })),
    failedCheckIds: result.failedCheckIds,
    unknownCheckIds: result.unknownCheckIds,
    artifactIds: result.artifactIds,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  };
}

function contextFor(tenantId: string, actorId: string, sessionId: string, traceId: string): RequestContext {
  return {
    tenantId,
    actorId,
    sessionId,
    channel: "system",
    traceId,
    roles: ["pi-runner"],
    permissions: [],
    dataScopes: [{ type: "tenant" }],
  };
}

function codeOf(error: unknown): string {
  return error instanceof Error ? error.message.split(":")[0] || "PI_RUN_FAILED" : "PI_RUN_FAILED";
}

function isNonRetryableResourceFailure(code: string): boolean {
  return [
    "PI_RESOURCE_RUNTIME_ARTIFACT_UNAVAILABLE",
    "PI_RESOURCE_REGISTRY_UNAVAILABLE",
    "PI_RESOURCE_SIGNATURE_INVALID",
    "PI_RESOURCE_DIGEST_MISMATCH",
    "PI_RESOURCE_SNAPSHOT_REVOKED",
    "PI_RESOURCE_SNAPSHOT_VERSION_INVALID",
    "PI_RESOURCE_SNAPSHOT_DIGEST_INVALID",
    "PI_RESOURCE_PROFILE_NOT_ALLOWED",
    "PI_RESOURCE_TOOL_NOT_ALLOWED",
    "PI_SKILL_CONTENT_UNAVAILABLE",
    "PI_MCP_TOOL_GATEWAY_UNAVAILABLE",
    "PI_MCP_EXECUTION_SCOPE_REQUIRED",
    "PI_KILL_SWITCH_ACTIVE",
  ].includes(code);
}

function failure(error: unknown): PiRunFailure {
  const classified = failureFrom(error);
  return { code: classified.code, digest: classified.digest };
}

function isCancellation(command: PiRunCommand): boolean {
  return command.type === "cancel" || command.type === "interrupt";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("PI_RUN_ABORTED");
}

function hasPendingCancellation(commands: PiRunCommand[]): boolean {
  return commands.some((command) => isCancellation(command) && ["accepted", "queued", "leased", "cancel_requested"].includes(command.status));
}

export class PiRunnerWorker {
  readonly role = "pi-runner" as const;
  private readonly active = new Map<string, ActiveRun>();
  private readonly inFlight = new Map<string, Promise<WorkCycleResult>>();
  private readonly sandboxes = new Map<string, PiSandbox>();
  private readonly workspaces = new Map<string, PiWorkspaceRecord>();
  private readonly runtimeFactory: RuntimeFactory;
  private readonly faults: PiRunnerFaultInjector;
  private readonly scheduler: PiRunScheduler;
  private draining = false;

  constructor(
    private readonly sessions: PiSessionStore,
    private readonly runs: PiRunStore,
    private readonly sandboxesProvider: PiSandboxProvider,
    private readonly options: PiRunnerOptions = {},
  ) {
    this.runtimeFactory = options.runtimeFactory ?? createPiRuntime;
    this.faults = options.faultInjector ?? noopPiRunnerFaultInjector;
    this.scheduler = options.scheduler ?? new PiRunScheduler(runs, {
      leaseMs: options.leaseMs,
      maxTenantConcurrency: options.maxTenantConcurrency,
    });
  }

  async processTenant(tenantId: string, workerId: string, now = new Date()): Promise<WorkCycleResult> {
    if (this.draining) return { role: this.role, status: "idle" };
    const lease = await this.scheduler.claimRun(tenantId, workerId, now);
    if (!lease) return { role: this.role, status: "idle" };
    await this.faults.checkpoint("after_claim", this.faultContext(lease));
    return this.track(lease);
  }

  /**
   * Claim and return immediately. The durable work remains tracked by the
   * Runner and is joined by drain(); the web/control process never calls this
   * path and never constructs a Pi runtime.
   */
  async processTenantDetached(tenantId: string, workerId: string, now = new Date()): Promise<WorkCycleResult> {
    if (this.draining) return { role: this.role, status: "idle" };
    const lease = await this.scheduler.claimRun(tenantId, workerId, now);
    if (!lease) return { role: this.role, status: "idle" };
    await this.faults.checkpoint("after_claim", this.faultContext(lease));
    void this.track(lease).catch(() => undefined);
    return { role: this.role, status: "running", workId: lease.id };
  }

  private track(lease: PiRunLease): Promise<WorkCycleResult> {
    const work = this.startLease(lease);
    this.inFlight.set(lease.runId, work);
    void work.then(() => {
      if (this.inFlight.get(lease.runId) === work) this.inFlight.delete(lease.runId);
    }, () => {
      if (this.inFlight.get(lease.runId) === work) this.inFlight.delete(lease.runId);
    });
    return work;
  }

  private async startLease(lease: PiRunLease): Promise<WorkCycleResult> {
    const context = contextFor(lease.tenantId, lease.actorId, lease.sessionId, lease.runId);
    if (!await this.scheduler.isLeaseActive(lease)) return { role: this.role, status: "lease_lost", workId: lease.id };
    await this.faults.checkpoint("before_run_leased_event", this.faultContext(lease));
    if (!await this.appendLeaseEvent(lease, context, lease.sessionId, "run_leased", {
      runId: lease.runId,
      commandId: lease.id,
      attempts: lease.attempts,
      reclaimedFromExpiredLease: lease.reclaimedFromExpiredLease ?? false,
      leaseExpiresAt: lease.leaseExpiresAt,
    })) return { role: this.role, status: "lease_lost", workId: lease.id };
    await this.faults.checkpoint("after_run_leased_event", this.faultContext(lease));
    if (lease.reclaimedFromExpiredLease) return this.recoverExpiredLease(lease, context);
    return isCancellation(lease) ? this.processCancellation(lease) : this.execute(lease);
  }

  private async recoverExpiredLease(lease: PiRunLease, context: RequestContext): Promise<WorkCycleResult> {
    const status = await this.runs.getRunStatus(context, lease.runId);
    if (!status) return { role: this.role, status: "lease_lost", workId: lease.id };
    if (this.options.sandboxOrchestrator && ["provisioning", "running", "awaiting_approval", "cancelling"].includes(status)) {
      const sandboxRecordExists = await this.options.sandboxOrchestrator.hasRunRecord(context, lease.runId);
      const recovered = await this.options.sandboxOrchestrator.recoverRun(context, lease.runId);
      if (!recovered) {
        if (!await this.runs.updateRunStatusForLease(lease, "unknown")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(context, lease.sessionId, { status: "unknown", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, context, lease.sessionId, "run_unknown", { runId: lease.runId, code: "PI_SANDBOX_RECOVERY_FAILED" })) return { role: this.role, status: "lease_lost", workId: lease.id };
        return { role: this.role, status: await this.runs.markUnknown(lease, { code: "PI_SANDBOX_RECOVERY_FAILED", digest: createHash("sha256").update("PI_SANDBOX_RECOVERY_FAILED").digest("hex") }) ? "unknown" : "lease_lost", workId: lease.id };
      }
      if (sandboxRecordExists && status === "provisioning") {
        if (!await this.runs.updateRunStatusForLease(lease, "unknown")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(context, lease.sessionId, { status: "unknown", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, context, lease.sessionId, "run_unknown", { runId: lease.runId, code: "PI_RUN_CRASH_RECOVERED_AFTER_SANDBOX" })) return { role: this.role, status: "lease_lost", workId: lease.id };
        return { role: this.role, status: await this.runs.markUnknown(lease, { code: "PI_RUN_CRASH_RECOVERED_AFTER_SANDBOX", digest: createHash("sha256").update("PI_RUN_CRASH_RECOVERED_AFTER_SANDBOX").digest("hex") }) ? "unknown" : "lease_lost", workId: lease.id };
      }
    }
    if (["running", "awaiting_approval", "cancelling"].includes(status)) {
      if (!await this.runs.updateRunStatusForLease(lease, "unknown")) return { role: this.role, status: "lease_lost", workId: lease.id };
      await this.sessions.updateSession(context, lease.sessionId, { status: "unknown", updatedAt: new Date().toISOString() });
      if (!await this.appendLeaseEvent(lease, context, lease.sessionId, "run_unknown", { runId: lease.runId, code: "PI_RUN_CRASH_RECOVERED_UNKNOWN" })) return { role: this.role, status: "lease_lost", workId: lease.id };
      return { role: this.role, status: await this.runs.markUnknown(lease, { code: "PI_RUN_CRASH_RECOVERED_UNKNOWN", digest: createHash("sha256").update("PI_RUN_CRASH_RECOVERED_UNKNOWN").digest("hex") }) ? "unknown" : "lease_lost", workId: lease.id };
    }
    if (status === "completed") return { role: this.role, status: await this.runs.acknowledge(lease, "acknowledged") ? "succeeded" : "lease_lost", workId: lease.id };
    if (status === "failed" || status === "timed_out" || status === "cancelled" || status === "unknown") {
      const commandStatus = status === "unknown" ? "unknown" : status === "cancelled" ? "cancelled" : "dead_lettered";
      return { role: this.role, status: await this.runs.acknowledge(lease, commandStatus) ? status === "unknown" ? "unknown" : "failed" : "lease_lost", workId: lease.id };
    }
    if (!await this.runs.updateRunStatusForLease(lease, "queued")) return { role: this.role, status: "lease_lost", workId: lease.id };
    await this.sessions.updateSession(context, lease.sessionId, { status: "queued", updatedAt: new Date().toISOString() });
    if (!await this.appendLeaseEvent(lease, context, lease.sessionId, "run_reclaimed", { runId: lease.runId, code: "PI_RUN_LEASE_EXPIRED_BEFORE_RUNTIME" })) return { role: this.role, status: "lease_lost", workId: lease.id };
    const disposition = await this.runs.requeue(lease, { code: "PI_RUN_LEASE_EXPIRED_BEFORE_RUNTIME", digest: createHash("sha256").update("PI_RUN_LEASE_EXPIRED_BEFORE_RUNTIME").digest("hex") }, new Date());
    return { role: this.role, status: disposition === "queued" ? "retry_scheduled" : disposition === "dead_lettered" ? "dead_letter" : "lease_lost", workId: lease.id };
  }

  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.scheduler.beginDrain();
    for (const active of this.active.values()) void active.abort().catch(() => undefined);
  }

  async drain(): Promise<void> {
    this.beginDrain();
    await Promise.all([...this.active.values()].map((active) => active.abort().catch(() => undefined)));
    await Promise.all([...this.inFlight.values()]);
  }

  private faultContext(lease: PiRunLease, eventType?: string): PiRunnerFaultContext {
    return { tenantId: lease.tenantId, actorId: lease.actorId, sessionId: lease.sessionId, runId: lease.runId, commandId: lease.id, ...(eventType ? { eventType } : {}) };
  }

  private async processCancellation(lease: PiRunLease): Promise<WorkCycleResult> {
    const active = this.active.get(lease.runId);
    if (active) {
      await active.abort();
      const context = contextFor(lease.tenantId, lease.actorId, lease.sessionId, lease.runId);
      if (!await this.appendLeaseEvent(lease, context, lease.sessionId, "interrupt_applied", { runId: lease.runId, commandId: lease.id })) return { role: this.role, status: "lease_lost", workId: lease.id };
      return {
        role: this.role,
        status: await this.runs.acknowledge(lease, "cancelled") ? "succeeded" : "lease_lost",
        workId: lease.id,
      };
    }
    const context = contextFor(lease.tenantId, lease.actorId, lease.sessionId, lease.runId);
    const currentStatus = await this.runs.getRunStatus(context, lease.runId);
    if (!currentStatus) return { role: this.role, status: "lease_lost", workId: lease.id };
    const terminal = ["completed", "failed", "cancelled", "timed_out", "unknown"].includes(currentStatus);
    if (!terminal) {
      const nextStatus = ["running", "awaiting_approval", "cancelling"].includes(currentStatus) ? "unknown" : "cancelled";
      if (!await this.runs.updateRunStatusForLease(lease, nextStatus)) return { role: this.role, status: "lease_lost", workId: lease.id };
      await this.sessions.updateSession(context, lease.sessionId, { status: nextStatus === "unknown" ? "unknown" : "cancelled", updatedAt: new Date().toISOString() });
      if (!await this.appendLeaseEvent(lease, context, lease.sessionId, nextStatus === "unknown" ? "run_unknown" : "interrupt_applied", { runId: lease.runId, commandId: lease.id, ...(nextStatus === "unknown" ? { code: "PI_CANCELLED_WITHOUT_ACTIVE_RUNNER" } : {}) })) return { role: this.role, status: "lease_lost", workId: lease.id };
      return {
        role: this.role,
        status: await this.runs.acknowledge(lease, nextStatus === "unknown" ? "unknown" : "cancelled") ? nextStatus === "unknown" ? "unknown" : "succeeded" : "lease_lost",
        workId: lease.id,
      };
    }
    return {
      role: this.role,
      status: await this.runs.acknowledge(lease, currentStatus === "unknown" ? "unknown" : "cancelled") ? currentStatus === "unknown" ? "unknown" : "succeeded" : "lease_lost",
      workId: lease.id,
    };
  }

  private async execute(lease: PiRunLease): Promise<WorkCycleResult> {
    const manifestContext = contextFor(lease.tenantId, lease.actorId, lease.sessionId, lease.runId);
    const manifest = await this.runs.getManifest(manifestContext, lease.runId);
    if (!manifest || manifest.tenantId !== lease.tenantId || manifest.actorId !== lease.actorId || manifest.sessionId !== lease.sessionId || !verifyPiRunManifest(manifest) || (process.env.NODE_ENV === "production" && manifest.controllerSignature.startsWith("dev-controller:"))) {
      if (!await this.runs.updateRunStatusForLease(lease, "failed")) return { role: this.role, status: "lease_lost", workId: lease.id };
      await this.sessions.updateSession(manifestContext, lease.sessionId, { status: "failed", updatedAt: new Date().toISOString() });
      if (!await this.appendLeaseEvent(lease, manifestContext, lease.sessionId, "run_manifest_rejected", { runId: lease.runId, commandId: lease.id })) return { role: this.role, status: "lease_lost", workId: lease.id };
      return { role: this.role, status: await this.runs.acknowledge(lease, "dead_lettered") ? "failed" : "lease_lost", workId: lease.id };
    }
    if (new Date(manifest.expiresAt) <= new Date()) {
      if (!await this.runs.updateRunStatusForLease(lease, "timed_out")) return { role: this.role, status: "lease_lost", workId: lease.id };
      await this.sessions.updateSession(manifestContext, lease.sessionId, { status: "timed_out", updatedAt: new Date().toISOString() });
      if (!await this.appendLeaseEvent(lease, manifestContext, lease.sessionId, "run_expired", { runId: lease.runId, commandId: lease.id })) return { role: this.role, status: "lease_lost", workId: lease.id };
      return { role: this.role, status: await this.runs.acknowledge(lease, "dead_lettered") ? "failed" : "lease_lost", workId: lease.id };
    }

    const session = await this.sessions.getSession(manifestContext, lease.sessionId);
    if (!session) return { role: this.role, status: "lease_lost", workId: lease.id };
    const controller = new AbortController();
    const active: ActiveRun = {
      runId: lease.runId,
      signal: controller.signal,
      abort: async () => {
        controller.abort();
        await active.runtime?.session.abort().catch(() => undefined);
      },
    };
    this.active.set(lease.runId, active);
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let started = false;
    let cancellationRequested = false;
    let leaseLost = false;
    let capacityLeaseId: string | undefined;
    let eventPersistenceError: Error | undefined;
    let eventChain = Promise.resolve();
    let unsubscribe: (() => void) | undefined;
    const pendingApprovalIds = new Set<string>();
    const sandboxKey = this.options.sandboxOrchestrator ? lease.runId : lease.sessionId;
    let cleanupStarted = false;
    let cleanupCompleted = false;
    const cleanupResources = async (): Promise<void> => {
      if (cleanupCompleted || cleanupStarted) return;
      cleanupStarted = true;
      const errors: string[] = [];
      const workspace = this.workspaces.get(lease.runId);
      if (workspace && this.options.workspaceService) {
        try {
          await this.options.workspaceService.cleanupWorkspace(manifestContext, workspace.id);
        } catch (error) {
          errors.push(codeOf(error));
        }
      }
      const sandbox = this.sandboxes.get(sandboxKey);
      if (sandbox) {
        try {
          if (this.options.sandboxOrchestrator) {
            const destroyed = await this.options.sandboxOrchestrator.destroy(manifestContext, sandbox);
            if (!destroyed) throw new Error("PI_SANDBOX_DESTROY_UNVERIFIED");
          } else {
            await this.sandboxesProvider.terminate(sandbox, "runner_cleanup");
            await this.sandboxesProvider.destroy(sandbox);
            if (!await this.sandboxesProvider.verifyDestroyed(sandbox)) throw new Error("PI_SANDBOX_DESTROY_UNVERIFIED");
          }
        } catch (error) {
          errors.push(codeOf(error));
        }
      }
      if (errors.length > 0) throw new Error("PI_RUN_CLEANUP_UNKNOWN");
      cleanupCompleted = true;
      this.sandboxes.delete(sandboxKey);
      this.workspaces.delete(lease.runId);
    };
    try {
      const leaseMs = this.options.leaseMs ?? 30_000;
      timeoutTimer = setTimeout(() => { timedOut = true; void active.abort(); }, this.options.maxDurationMs ?? 10 * 60 * 1000);
      const renewedAt = async () => {
        try {
          const renewed = await this.scheduler.renewLease(lease, lease.leaseOwner);
          if (!renewed) {
            leaseLost = true;
            await active.abort();
            return;
          }
          eventChain = eventChain.then(async () => {
            if (eventPersistenceError || leaseLost) return;
            await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "run_heartbeat", {
              runId: lease.runId,
              commandId: lease.id,
              leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
            });
          }).catch((error) => {
            eventPersistenceError = error instanceof Error ? error : new Error("PI_EVENT_PERSISTENCE_FAILED");
            void active.abort();
          });
          if (hasPendingCancellation(await this.runs.listCommands(manifestContext, session.id))) {
            cancellationRequested = true;
            await active.abort();
          }
        } catch {
          leaseLost = true;
          await active.abort();
        }
      };
      renewTimer = setInterval(() => void renewedAt(), Math.max(100, this.options.heartbeatEventIntervalMs ?? Math.floor(leaseMs / 3)));
      if (this.draining) throw new Error("PI_RUN_DRAINING");
      await this.options.safetyGate?.assertExecutionAllowed(manifestContext, { profile: manifest.profile.id, modelRouteId: manifest.modelPolicy.id });
      await this.updateRunStatus(lease, "provisioning");
      await this.sessions.updateSession(manifestContext, session.id, { status: "queued", updatedAt: new Date().toISOString() });
      if (hasPendingCancellation(await this.runs.listCommands(manifestContext, session.id))) throw new Error("PI_RUN_CANCELLED_BEFORE_START");

      const sandbox = await this.getSandbox(session, manifestContext, lease.runId, active.signal);
      throwIfAborted(active.signal);
      await this.options.safetyGate?.consumeFault(manifestContext, "runner.runtime");
      if (this.options.safetyGate && this.options.enforceCapacity) {
        const admission = await this.options.safetyGate.admitCapacity(manifestContext, { runId: lease.runId, idempotencyKey: `runner:${lease.runId}`, profile: manifest.profile.id });
        if (!admission.allowed) throw new Error(admission.reasonCode ?? "PI_CAPACITY_EXCEEDED");
        capacityLeaseId = admission.leaseId;
      }
      const workspace = await this.prepareWorkspace(session, manifest, manifestContext, lease.runId);
      throwIfAborted(active.signal);
      if (workspace) {
        this.workspaces.set(lease.runId, workspace);
          await this.mountWorkspace(manifestContext, sandbox, {
          sourceRef: workspace.providerWorkspaceRef ?? `workspace://${workspace.id}`,
          targetPath: "workspace",
          readOnly: false,
          contentDigest: workspace.workspaceDigest,
        });
      }
      if (lease.type === "checkpoint") {
        if (workspace && this.options.workspaceService) {
          const result = await this.options.workspaceService.checkpoint(manifestContext, workspace.id, lease.payload.message?.trim() || "checkpoint");
          await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "checkpoint_created", {
            checkpointId: result.checkpoint?.id ?? lease.runId,
            diffDigest: result.diff.diffDigest,
            artifactId: result.diff.artifactId,
            gitCommitSha: result.commit.commitSha,
            runId: lease.runId,
          });
          await cleanupResources();
          await this.sessions.updateSession(manifestContext, session.id, { status: "succeeded", updatedAt: new Date().toISOString() });
          await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "run_terminal", { runId: lease.runId, status: "completed" });
          return { role: this.role, status: await this.scheduler.complete(lease) ? "succeeded" : "lease_lost", workId: lease.id };
        }
        const snapshot = await this.sandboxesProvider.snapshot(sandbox);
        const checkpoint = {
          id: lease.runId,
          tenantId: manifestContext.tenantId,
          sessionId: session.id,
          label: lease.payload.message?.trim() || "checkpoint",
          diffDigest: snapshot.digest,
          snapshot,
          createdAt: new Date().toISOString(),
        };
        await this.sessions.createCheckpoint(manifestContext, checkpoint);
        await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "checkpoint_created", { checkpointId: checkpoint.id, diffDigest: checkpoint.diffDigest, runId: lease.runId });
        await cleanupResources();
        await this.sessions.updateSession(manifestContext, session.id, { status: "succeeded", updatedAt: new Date().toISOString() });
        await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "run_terminal", { runId: lease.runId, status: "completed" });
        return { role: this.role, status: await this.scheduler.complete(lease) ? "succeeded" : "lease_lost", workId: lease.id };
      }

      const history = await this.sessions.getEvents(manifestContext, session.id, 0, 500);
      if ((session.mcpBindingIds?.length ?? 0) > 0 && !this.options.toolGateway) throw new Error("PI_MCP_TOOL_GATEWAY_UNAVAILABLE");
      if (session.resourceSnapshot && !this.options.resourceRegistry) throw new Error("PI_RESOURCE_REGISTRY_UNAVAILABLE");
      const resources = session.resourceSnapshot
        ? await this.options.resourceRegistry!.loadSnapshot(manifestContext, session.resourceSnapshot, { profile: session.profile, availableTools: manifest.toolSnapshot.names })
        : undefined;
      if (resources && hasPiRuntimeArtifacts(resources)) {
        if (!this.options.resourceMaterializer) throw new Error("PI_RESOURCE_RUNTIME_ARTIFACT_UNAVAILABLE");
        if (sandbox.provider !== "firecracker" && sandbox.provider !== "kata") throw new Error("PI_RESOURCE_RUNTIME_SANDBOX_REQUIRED");
        if (sandbox.executionBoundary !== "guest") throw new Error("PI_RESOURCE_RUNTIME_GUEST_BOUNDARY_REQUIRED");
      }
      await this.faults.checkpoint("before_runtime_create", this.faultContext(lease));
      throwIfAborted(active.signal);
      const runtime = await this.runtimeFactory({
        context: manifestContext,
        record: session,
        sandbox,
        provider: this.sandboxesProvider,
        history,
        resources,
        resourceMaterializer: this.options.resourceMaterializer,
        signal: active.signal,
        toolGateway: this.options.toolGateway,
        mcpBindingIds: session.mcpBindingIds,
        runId: lease.runId,
        enforceEnterprisePolicy: true,
        approvalService: this.options.approvalService,
        approvalObjectVersions: {
          manifestDigest: manifest.manifestDigest,
          profileVersion: session.profileVersion,
          policyVersion: session.policyVersion,
          sandboxRunId: session.sandboxRunId,
        },
        approvalObjectVersionReader: this.options.approvalObjectVersionReader,
        approvalPollMs: this.options.approvalPollMs,
        approvalWaitTimeoutMs: this.options.approvalWaitTimeoutMs,
        onApprovalRequired: async ({ approval, created }: { approval: PiApproval; created: boolean }) => {
          pendingApprovalIds.add(approval.id);
          if (pendingApprovalIds.size === 1) {
            await this.updateRunStatus(lease, "awaiting_approval");
            await this.sessions.updateSession(manifestContext, session.id, { status: "awaiting_approval", updatedAt: new Date().toISOString() });
          }
          await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "approval_required", {
            runId: lease.runId,
            approvalId: approval.id,
            toolCallId: approval.toolCallId,
            toolName: approval.toolName,
            riskLevel: approval.riskLevel,
            proposalHash: approval.proposalHash,
            expiresAt: approval.expiresAt,
            created,
          });
        },
        onApprovalResumed: async ({ approval, permit }: { approval: PiApproval; permit: PiApprovalExecutionPermit }) => {
          pendingApprovalIds.delete(approval.id);
          await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "approval_resumed", {
            runId: lease.runId,
            approvalId: approval.id,
            toolCallId: approval.toolCallId,
            toolName: approval.toolName,
            proposalHash: permit.proposalHash,
            policyVersion: permit.policyVersion,
          });
          if (pendingApprovalIds.size === 0) {
            await this.updateRunStatus(lease, "running");
            await this.sessions.updateSession(manifestContext, session.id, { status: "running", updatedAt: new Date().toISOString() });
          }
        },
        onApprovalDenied: async ({ approval, reason }: { approval: PiApproval; reason: string }) => {
          pendingApprovalIds.delete(approval.id);
          await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "approval_denied", {
            runId: lease.runId,
            approvalId: approval.id,
            toolCallId: approval.toolCallId,
            toolName: approval.toolName,
            reason,
          });
        },
      });
      active.runtime = runtime;
      throwIfAborted(active.signal);
      await this.faults.checkpoint("after_runtime_create", this.faultContext(lease));
      if (!runtime.model) throw new Error("PI_MODEL_NOT_CONFIGURED");
      unsubscribe = runtime.subscribe((event) => {
        eventChain = eventChain.then(async () => {
          if (eventPersistenceError) return;
          const eventContext = this.faultContext(lease, event.type);
          if (event.type === "tool_execution_start") await this.faults.checkpoint("before_tool", eventContext);
          await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, event.type, safePayload(event));
          if (event.type === "tool_execution_end") await this.faults.checkpoint("after_tool", eventContext);
        }).catch((error) => {
          eventPersistenceError = error instanceof Error ? error : new Error("PI_EVENT_PERSISTENCE_FAILED");
          void active.abort();
        });
      });
      await this.updateRunStatus(lease, "running");
      await this.sessions.updateSession(manifestContext, session.id, { status: "running", updatedAt: new Date().toISOString() });
      started = true;
      await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "run_started", { runId: lease.runId, commandId: lease.id, manifestDigest: manifest.manifestDigest });
      await this.faults.checkpoint("before_prompt", this.faultContext(lease));
      throwIfAborted(active.signal);
      const prompt = runtime.session.prompt(lease.payload.message ?? "");
      // The prompt has been handed to Pi before this checkpoint. A process
      // kill/pause here therefore exercises an in-flight model call instead
      // of merely testing admission before the call starts.
      await this.faults.checkpoint("during_prompt", this.faultContext(lease));
      await prompt;
      await eventChain;
      if (eventPersistenceError) throw eventPersistenceError;
      if (workspace && this.options.validationPlanResolver) {
        const plan = await this.options.validationPlanResolver({ context: manifestContext, session, manifest, workspace });
        if (plan) {
          if (!this.options.validationService) throw new Error("PI_VALIDATION_SERVICE_UNAVAILABLE");
          const planDigest = computePiValidationPlanDigest(plan);
          await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "validation_started", {
            runId: lease.runId,
            planId: plan.id,
            planVersion: plan.version,
            planDigest,
            checkIds: plan.checks.map((check) => check.id),
          });
          const validation = await this.options.validationService.run(manifestContext, {
            workspaceRecordId: workspace.id,
            sandbox,
            plan,
            signal: active.signal,
          });
          await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "validation_completed", validationSummary(validation));
          if (validation.status === "unknown") throw new PiValidationUnknownError(validation);
          if (validation.status === "failed") throw new PiValidationFailedError(validation);
        }
      }
      await this.faults.checkpoint("before_terminal_commit", this.faultContext(lease));
      await cleanupResources();
      await this.sessions.updateSession(manifestContext, session.id, { status: "succeeded", updatedAt: new Date().toISOString() });
      await this.appendLeaseEventOrThrow(lease, manifestContext, session.id, "run_terminal", { runId: lease.runId, status: "completed" });
      return { role: this.role, status: await this.scheduler.complete(lease) ? "succeeded" : "lease_lost", workId: lease.id };
    } catch (error) {
      let cleanupFailed = false;
      if (!cleanupStarted) {
        try {
          await cleanupResources();
        } catch {
          cleanupFailed = true;
        }
      }
      const effectiveError = cleanupFailed ? new Error("PI_RUN_CLEANUP_UNKNOWN") : error;
      const code = codeOf(effectiveError);
      await eventChain.catch(() => undefined);
      const cancelled = code === "PI_RUN_CANCELLED_BEFORE_START" || cancellationRequested || (!timedOut && (code.includes("ABORT") || code.includes("CANCEL")));
      if (leaseLost || code === "PI_RUN_LEASE_LOST") return { role: this.role, status: "lease_lost", workId: lease.id };
      if (eventPersistenceError && !cleanupFailed) {
        if (!await this.runs.updateRunStatusForLease(lease, "unknown")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(manifestContext, session.id, { status: "unknown", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, manifestContext, session.id, "run_unknown", { runId: lease.runId, code: "PI_EVENT_PERSISTENCE_FAILED" })) return { role: this.role, status: "lease_lost", workId: lease.id };
        return { role: this.role, status: await this.runs.markUnknown(lease, failure(eventPersistenceError)) ? "unknown" : "lease_lost", workId: lease.id };
      }
      if (code === "PI_VALIDATION_CHECK_FAILED") {
        await this.sessions.updateSession(manifestContext, session.id, { status: "failed", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, manifestContext, session.id, "run_terminal", { runId: lease.runId, status: "failed", code })) return { role: this.role, status: "lease_lost", workId: lease.id };
        return { role: this.role, status: await this.runs.fail(lease, failure(effectiveError)) ? "failed" : "lease_lost", workId: lease.id };
      }
      if (code === "PI_VALIDATION_UNKNOWN") {
        if (!await this.runs.updateRunStatusForLease(lease, "unknown")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(manifestContext, session.id, { status: "unknown", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, manifestContext, session.id, "run_unknown", { runId: lease.runId, code })) return { role: this.role, status: "lease_lost", workId: lease.id };
        return { role: this.role, status: await this.runs.markUnknown(lease, failure(effectiveError)) ? "unknown" : "lease_lost", workId: lease.id };
      }
      if (cleanupFailed || code === "PI_RUN_CLEANUP_UNKNOWN") {
        if (!await this.runs.updateRunStatusForLease(lease, "unknown")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(manifestContext, session.id, { status: "unknown", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, manifestContext, session.id, "run_unknown", { runId: lease.runId, code })) return { role: this.role, status: "lease_lost", workId: lease.id };
        return { role: this.role, status: await this.runs.markUnknown(lease, failure(effectiveError)) ? "unknown" : "lease_lost", workId: lease.id };
      }
      if (this.draining) {
        const localSandboxKey = this.options.sandboxOrchestrator ? lease.runId : session.id;
        let resourceCreated = this.sandboxes.has(localSandboxKey) || this.workspaces.has(lease.runId);
        if (!resourceCreated && this.options.sandboxOrchestrator) {
          try {
            resourceCreated = await this.options.sandboxOrchestrator.hasRunRecord(manifestContext, lease.runId);
          } catch {
            resourceCreated = true;
          }
        }
        if (started || resourceCreated) {
          if (!await this.runs.updateRunStatusForLease(lease, "unknown")) return { role: this.role, status: "lease_lost", workId: lease.id };
          await this.sessions.updateSession(manifestContext, session.id, { status: "unknown", updatedAt: new Date().toISOString() });
          if (!await this.appendLeaseEvent(lease, manifestContext, session.id, "run_unknown", {
            runId: lease.runId,
            code: started ? "PI_RUN_DRAINING_AFTER_RUNTIME" : "PI_RUN_DRAINING_AFTER_RESOURCE",
          })) return { role: this.role, status: "lease_lost", workId: lease.id };
          return {
            role: this.role,
            status: await this.runs.markUnknown(lease, {
              code: started ? "PI_RUN_DRAINING_AFTER_RUNTIME" : "PI_RUN_DRAINING_AFTER_RESOURCE",
              digest: createHash("sha256").update(started ? "PI_RUN_DRAINING_AFTER_RUNTIME" : "PI_RUN_DRAINING_AFTER_RESOURCE").digest("hex"),
            }) ? "unknown" : "lease_lost",
            workId: lease.id,
          };
        }
        if (!await this.runs.updateRunStatusForLease(lease, "queued")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(manifestContext, session.id, { status: "queued", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, manifestContext, session.id, "run_requeued", { runId: lease.runId, code: "PI_RUN_DRAINING" })) return { role: this.role, status: "lease_lost", workId: lease.id };
        const disposition = await this.runs.requeue(lease, { code: "PI_RUN_DRAINING", digest: createHash("sha256").update("PI_RUN_DRAINING").digest("hex") }, new Date());
        return { role: this.role, status: disposition === "queued" ? "retry_scheduled" : disposition === "dead_lettered" ? "dead_letter" : "lease_lost", workId: lease.id };
      }
      if (timedOut) {
        if (!await this.runs.updateRunStatusForLease(lease, "timed_out")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(manifestContext, session.id, { status: "timed_out", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, manifestContext, session.id, "run_terminal", { runId: lease.runId, status: "timed_out" })) return { role: this.role, status: "lease_lost", workId: lease.id };
        return { role: this.role, status: await this.runs.markUnknown(lease, { code: "PI_RUN_TIMEOUT", digest: createHash("sha256").update("PI_RUN_TIMEOUT").digest("hex") }) ? "unknown" : "lease_lost", workId: lease.id };
      }
      if (cancelled) {
        if (!await this.runs.updateRunStatusForLease(lease, "cancelled")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(manifestContext, session.id, { status: "cancelled", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, manifestContext, session.id, "run_terminal", { runId: lease.runId, status: "cancelled" })) return { role: this.role, status: "lease_lost", workId: lease.id };
        return { role: this.role, status: await this.runs.acknowledge(lease, "cancelled") ? "succeeded" : "lease_lost", workId: lease.id };
      }
      if (code === "PI_RUN_DRAINING") {
        if (!await this.runs.updateRunStatusForLease(lease, "queued")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(manifestContext, session.id, { status: "queued", updatedAt: new Date().toISOString() });
        const disposition = await this.runs.requeue(lease, { code, digest: createHash("sha256").update(code).digest("hex") }, new Date());
        return { role: this.role, status: disposition === "queued" ? "retry_scheduled" : disposition === "dead_lettered" ? "dead_letter" : "lease_lost", workId: lease.id };
      }
      if (isNonRetryableResourceFailure(code)) {
        if (!await this.runs.updateRunStatusForLease(lease, "failed")) return { role: this.role, status: "lease_lost", workId: lease.id };
        await this.sessions.updateSession(manifestContext, session.id, { status: "failed", updatedAt: new Date().toISOString() });
        if (!await this.appendLeaseEvent(lease, manifestContext, session.id, "resource_rejected", { runId: lease.runId, code })) return { role: this.role, status: "lease_lost", workId: lease.id };
        return { role: this.role, status: await this.runs.acknowledge(lease, "dead_lettered") ? "failed" : "lease_lost", workId: lease.id };
      }
      if (!await this.runs.updateRunStatusForLease(lease, started ? "unknown" : "failed")) return { role: this.role, status: "lease_lost", workId: lease.id };
      await this.sessions.updateSession(manifestContext, session.id, { status: started ? "unknown" : "failed", updatedAt: new Date().toISOString() });
      if (!await this.appendLeaseEvent(lease, manifestContext, session.id, started ? "run_unknown" : "runtime_error", { runId: lease.runId, code })) return { role: this.role, status: "lease_lost", workId: lease.id };
      if (started) return { role: this.role, status: await this.runs.markUnknown(lease, failure(effectiveError)) ? "unknown" : "lease_lost", workId: lease.id };
      const disposition = await this.runs.requeue(lease, failure(effectiveError), retryAt(lease.attempts));
      return { role: this.role, status: disposition === "queued" ? "retry_scheduled" : disposition === "dead_lettered" ? "dead_letter" : "lease_lost", workId: lease.id };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (renewTimer) clearInterval(renewTimer);
      unsubscribe?.();
      await eventChain.catch(() => undefined);
      await active.runtime?.dispose().catch(() => undefined);
      if (capacityLeaseId) await this.options.safetyGate?.releaseCapacity(manifestContext, capacityLeaseId).catch(() => undefined);
      this.sandboxes.delete(sandboxKey);
      this.workspaces.delete(lease.runId);
      this.active.delete(lease.runId);
    }
  }

  private async mountWorkspace(context: RequestContext, sandbox: PiSandbox, mount: Parameters<PiSandboxProvider["mountWorkspace"]>[1], signal?: AbortSignal): Promise<void> {
    if (this.options.sandboxOrchestrator) {
      await this.options.sandboxOrchestrator.mountWorkspace(context, sandbox, mount, signal);
      return;
    }
    await this.sandboxesProvider.mountWorkspace(sandbox, mount, signal);
  }

  private async getSandbox(session: PiSession, context: RequestContext, runId: string, signal?: AbortSignal): Promise<PiSandbox> {
    const key = this.options.sandboxOrchestrator ? runId : session.id;
    const existing = this.sandboxes.get(key);
    if (existing) return existing;
    const sandbox = this.options.sandboxOrchestrator
      ? await this.options.sandboxOrchestrator.createSandbox(context, {
        runId,
        workspaceId: session.workspaceId,
        profile: session.profile,
        repositoryId: session.repositoryId,
        baseCommit: session.baseCommit,
        networkPolicy: session.networkPolicy,
      }, signal)
      : await this.sandboxesProvider.create({
        tenantId: context.tenantId,
        actorId: context.actorId,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        profile: session.profile,
        repositoryId: session.repositoryId,
        baseCommit: session.baseCommit,
        networkPolicy: session.networkPolicy,
        runId,
      }, signal);
    this.sandboxes.set(key, sandbox);
    return sandbox;
  }

  private async prepareWorkspace(session: PiSession, manifest: Parameters<typeof verifyPiRunManifest>[0], context: RequestContext, runId: string): Promise<PiWorkspaceRecord | undefined> {
    if (!this.options.workspaceService) return undefined;
    if (!session.repositoryId || !session.baseCommit) throw new Error("PI_REPOSITORY_REQUIRED");
    return this.options.workspaceService.prepareWorkspace(context, {
      sessionId: session.id,
      runId,
      workspaceId: session.workspaceId,
      repositoryId: session.repositoryId,
      baseRef: manifest.repository?.baseRef ?? session.baseRef ?? "HEAD",
      baseCommitSha: session.baseCommit,
      profile: session.profile,
    });
  }

  private async updateRunStatus(lease: PiRunLease, status: Parameters<PiRunStore["updateRunStatusForLease"]>[1]): Promise<void> {
    if (!await this.runs.updateRunStatusForLease(lease, status)) throw new Error("PI_RUN_LEASE_LOST");
  }

  private async appendLeaseEvent(lease: PiRunLease, context: RequestContext, sessionId: string, type: string, payload: unknown): Promise<boolean> {
    if (!await this.scheduler.isLeaseActive(lease)) return false;
    await this.appendEvent(context, sessionId, type, payload, lease);
    return true;
  }

  private async appendLeaseEventOrThrow(lease: PiRunLease, context: RequestContext, sessionId: string, type: string, payload: unknown): Promise<void> {
    if (!await this.appendLeaseEvent(lease, context, sessionId, type, payload)) throw new Error("PI_RUN_LEASE_LOST");
  }

  private async appendEvent(context: RequestContext, sessionId: string, type: string, payload: unknown, lease?: PiRunLease): Promise<PiSessionEvent> {
    const faultContext: PiRunnerFaultContext = lease
      ? this.faultContext(lease, type)
      : { tenantId: context.tenantId, actorId: context.actorId, sessionId, runId: context.traceId, eventType: type };
    await this.faults.checkpoint("before_event_flush", faultContext);
    const event = await this.sessions.appendEvent(context, sessionId, { type, payload: safePayload(payload), traceId: context.traceId });
    await this.faults.checkpoint("after_event_flush", faultContext);
    return event;
  }
}
