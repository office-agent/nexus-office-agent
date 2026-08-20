import type {
  PiRunBacklogQuery,
  PiRunCommand,
  PiRunFailure,
  PiRunLease,
  PiRunLeaseRequest,
  PiRunManifest,
  PiRunStatus,
  PiRunStore,
} from "@/src/modules/pi-agent/domain/contracts";
import type { RequestContext } from "@/src/platform/context/request-context";

export type PiRunSchedulerOptions = {
  leaseMs?: number;
  maxTenantConcurrency?: number;
};

/**
 * The Runner-facing Queue control facade.
 *
 * The scheduler owns admission/drain policy and keeps the Worker independent
 * from the storage implementation. Store methods remain the persistence and
 * compare-and-set boundary; this class is deliberately free of HTTP concerns.
 */
export class PiRunScheduler {
  private draining = false;

  constructor(
    private readonly runs: PiRunStore,
    private readonly options: PiRunSchedulerOptions = {},
  ) {}

  beginDrain(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  async claimRun(tenantId: string, workerId: string, now = new Date()): Promise<PiRunLease | null> {
    if (this.draining) return null;
    const leaseRequest: PiRunLeaseRequest = {
      workerId,
      leaseMs: this.options.leaseMs ?? 30_000,
      maxTenantConcurrency: this.options.maxTenantConcurrency ?? 1,
      now,
    };
    const lease = await this.runs.claim(tenantId, leaseRequest);
    if (!lease || !this.draining) return lease;

    // A drain can begin while the durable claim is in flight. Return the
    // command to the queue before exposing it to the Runner when that occurs.
    await this.runs.release(lease, now, now).catch(() => undefined);
    return null;
  }

  renewLease(lease: PiRunLease, workerId: string, now = new Date()): Promise<boolean> {
    return this.runs.renew(lease, workerId, this.options.leaseMs ?? 30_000, now);
  }

  isLeaseActive(lease: PiRunLease, now = new Date()): Promise<boolean> {
    return this.runs.isLeaseActive(lease, now);
  }

  release(lease: PiRunLease, availableAt: Date, now = new Date()): Promise<boolean> {
    return this.runs.release(lease, availableAt, now);
  }

  complete(lease: PiRunLease, now = new Date()): Promise<boolean> {
    return this.runs.complete(lease, now);
  }

  fail(lease: PiRunLease, failure: PiRunFailure, now = new Date()): Promise<boolean> {
    return this.runs.fail(lease, failure, now);
  }

  deadLetter(lease: PiRunLease, failure: PiRunFailure, now = new Date()): Promise<boolean> {
    return this.runs.deadLetter(lease, failure, now);
  }

  acknowledge(lease: PiRunLease, status: "acknowledged" | "cancelled" | "unknown" | "dead_lettered", now = new Date()): Promise<boolean> {
    return this.runs.acknowledge(lease, status, now);
  }

  requeue(lease: PiRunLease, failure: PiRunFailure, availableAt: Date, now = new Date()): Promise<"queued" | "dead_lettered" | null> {
    return this.runs.requeue(lease, failure, availableAt, now);
  }

  markUnknown(lease: PiRunLease, failure: PiRunFailure, now = new Date()): Promise<boolean> {
    return this.runs.markUnknown(lease, failure, now);
  }

  updateRunStatusForLease(lease: PiRunLease, status: PiRunStatus, now = new Date()): Promise<boolean> {
    return this.runs.updateRunStatusForLease(lease, status, now);
  }

  getManifest(context: RequestContext, runId: string): Promise<PiRunManifest | null> {
    return this.runs.getManifest(context, runId);
  }

  getRunStatus(context: RequestContext, runId: string): Promise<PiRunStatus | null> {
    return this.runs.getRunStatus(context, runId);
  }

  listCommands(context: RequestContext, sessionId: string): Promise<PiRunCommand[]> {
    return this.runs.listCommands(context, sessionId);
  }

  listBacklog(tenantId: string, query?: PiRunBacklogQuery): Promise<PiRunCommand[]> {
    return this.runs.listBacklog(tenantId, query);
  }
}
