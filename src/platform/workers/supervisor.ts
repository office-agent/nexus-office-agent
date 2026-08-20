import type { WorkerRole } from "@/src/platform/workers/contracts";
import type { WorkCycleResult } from "@/src/platform/workers/durable-workers";
import type { PostgresTenantDirectory, PostgresWorkerHeartbeatRepository } from "@/src/platform/workers/postgres-work-repositories";
import { incrementCounter, logOperationalEvent } from "@/src/platform/observability/telemetry";

type TenantDirectory = Pick<PostgresTenantDirectory, "listActiveTenantIds">;
type WorkerHeartbeats = Pick<PostgresWorkerHeartbeatRepository, "beat">;

export interface TenantWorker {
  readonly role: WorkerRole;
  processTenant(tenantId: string, workerId: string, now?: Date): Promise<WorkCycleResult>;
  /**
   * Optional non-blocking claim path. Long-running workers use this so the
   * supervisor can continue polling other tenants while the lease is renewed
   * by the worker itself.
   */
  processTenantDetached?(tenantId: string, workerId: string, now?: Date): Promise<WorkCycleResult>;
  /**
   * Synchronously close the claim boundary before the supervisor waits for
   * active work. This is intentionally separate from drain(), because a
   * SIGTERM can arrive while a database claim is still in flight.
   */
  beginDrain?(): void;
  drain?(): Promise<void>;
}

export type WorkerSupervisorOptions = {
  instanceId: string;
  releaseVersion: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxItemsPerRolePerCycle?: number;
};

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export class WorkerSupervisor {
  private readonly cursors = new Map<WorkerRole, number>();
  private readonly startedAt = new Date();
  private lastHeartbeatAt = 0;
  private heartbeatInFlight?: Promise<void>;
  private drainPromise?: Promise<void>;

  constructor(
    private readonly tenants: TenantDirectory,
    private readonly heartbeats: WorkerHeartbeats,
    private readonly workers: TenantWorker[],
    private readonly options: WorkerSupervisorOptions,
  ) {
    if (workers.length === 0) throw new Error("WORKER_ROLE_REQUIRED");
  }

  async processCycle(now = new Date(), signal?: AbortSignal): Promise<WorkCycleResult[]> {
    await this.heartbeat(now, false);
    const tenantIds = await this.tenants.listActiveTenantIds();
    if (tenantIds.length === 0) return this.workers.map(({ role }) => ({ role, status: "idle" }));
    const results: WorkCycleResult[] = [];
    for (const worker of this.workers) {
      const cursor = this.cursors.get(worker.role) ?? 0;
      const ordered = tenantIds.map((_, offset) => tenantIds[(cursor + offset) % tenantIds.length]);
      let handled = 0;
      const budget = Math.max(1, this.options.maxItemsPerRolePerCycle ?? tenantIds.length);
      for (const tenantId of ordered) {
        if (signal?.aborted) break;
        try {
          const processTenant = worker.processTenantDetached ?? worker.processTenant;
          const result = await processTenant.call(worker, tenantId, `${this.options.instanceId}:${worker.role}`, now);
          results.push(result);
          incrementCounter("worker.cycle.total", { role: worker.role, outcome: result.status });
          if (result.status !== "idle") handled += 1;
          if (handled >= budget) break;
        } catch (error) {
          const errorCode = error instanceof Error ? error.message.split(":")[0] || "WORKER_CYCLE_FAILED" : "WORKER_CYCLE_FAILED";
          incrementCounter("worker.cycle.total", { role: worker.role, outcome: "infrastructure_failure" });
          logOperationalEvent("error", "worker.tenant_cycle_failed", { role: worker.role, tenantId, errorCode });
          results.push({ role: worker.role, status: "failed" });
          break;
        }
      }
      if (handled >= budget && tenantIds.length > budget) {
        incrementCounter("worker.backpressure.total", { role: worker.role, reason: "role_budget_exhausted" });
      }
      this.cursors.set(worker.role, (cursor + 1) % tenantIds.length);
    }
    return results;
  }

  async run(signal: AbortSignal): Promise<void> {
    const onAbort = () => {
      void this.requestDrain().catch((error) => {
        const errorCode = error instanceof Error ? error.message.split(":")[0] || "WORKER_DRAIN_FAILED" : "WORKER_DRAIN_FAILED";
        logOperationalEvent("error", "worker.drain_failed", { errorCode });
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const heartbeatLoop = this.runHeartbeatLoop(signal);
    try {
      while (!signal.aborted) {
        try {
          await this.processCycle(new Date(), signal);
        } catch (error) {
          const errorCode = error instanceof Error ? error.message.split(":")[0] || "WORKER_SUPERVISOR_FAILED" : "WORKER_SUPERVISOR_FAILED";
          incrementCounter("worker.supervisor.total", { outcome: "infrastructure_failure" });
          logOperationalEvent("error", "worker.supervisor_cycle_failed", { errorCode });
        }
        await wait(Math.max(50, this.options.pollIntervalMs ?? 500), signal);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      const drain = this.requestDrain();
      try {
        await this.heartbeat(new Date(), true);
      } catch (error) {
        const errorCode = error instanceof Error ? error.message.split(":")[0] || "WORKER_DRAIN_HEARTBEAT_FAILED" : "WORKER_DRAIN_HEARTBEAT_FAILED";
        logOperationalEvent("warn", "worker.drain_heartbeat_failed", { errorCode });
      }
      await drain;
      await heartbeatLoop;
    }
  }

  private requestDrain(): Promise<void> {
    if (!this.drainPromise) {
      for (const worker of this.workers) worker.beginDrain?.();
      this.drainPromise = Promise.all(this.workers.map((worker) => worker.drain?.() ?? Promise.resolve())).then(() => undefined);
    }
    return this.drainPromise;
  }

  private async runHeartbeatLoop(signal: AbortSignal): Promise<void> {
    const interval = Math.max(1_000, Math.floor((this.options.heartbeatIntervalMs ?? 10_000) / 3));
    while (!signal.aborted) {
      await wait(interval, signal);
      if (signal.aborted) return;
      try {
        await this.heartbeat(new Date(), false);
      } catch (error) {
        const errorCode = error instanceof Error ? error.message.split(":")[0] || "WORKER_HEARTBEAT_FAILED" : "WORKER_HEARTBEAT_FAILED";
        logOperationalEvent("warn", "worker.heartbeat_failed", { errorCode });
      }
    }
  }

  private async heartbeat(now: Date, draining: boolean): Promise<void> {
    if (this.heartbeatInFlight) await this.heartbeatInFlight;
    const operation = this.performHeartbeat(now, draining);
    this.heartbeatInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.heartbeatInFlight === operation) this.heartbeatInFlight = undefined;
    }
  }

  private async performHeartbeat(now: Date, draining: boolean): Promise<void> {
    const interval = Math.max(1_000, this.options.heartbeatIntervalMs ?? 10_000);
    if (!draining && now.getTime() - this.lastHeartbeatAt < interval) return;
    for (const worker of this.workers) {
      await this.heartbeats.beat({
        role: worker.role,
        instanceId: `${this.options.instanceId}:${worker.role}`,
        releaseVersion: this.options.releaseVersion,
        capabilities: { durableLease: true, staleTokenGuard: true, gracefulDrain: true },
        startedAt: this.startedAt,
        now,
        draining,
      });
    }
    this.lastHeartbeatAt = now.getTime();
  }
}
