import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiChangeDeliveryService } from "@/src/modules/pi-agent/application/change-delivery-service";
import type { PiDeliveryOutbox } from "@/src/modules/pi-agent/domain/change-delivery-contracts";
import type { WorkCycleResult } from "@/src/platform/workers/durable-workers";
import type { TenantWorker } from "@/src/platform/workers/supervisor";

const SYSTEM_ACTOR = "00000000-0000-4000-8000-000000000000";

function workerContext(tenantId: string, workerId: string, outbox?: PiDeliveryOutbox): RequestContext {
  return {
    tenantId,
    actorId: outbox?.actorId ?? SYSTEM_ACTOR,
    sessionId: outbox?.sessionId ?? `system:${workerId}`,
    channel: "system",
    traceId: `pi-change-delivery:${workerId}:${outbox?.id ?? "poll"}`,
    roles: ["system"],
    permissions: ["*"],
    dataScopes: [{ type: "tenant" }],
  };
}

/**
 * Durable consumer for the Pi Change Delivery outbox. It is intentionally a
 * separate worker role from the Pi runtime worker, and it never claims an
 * awaiting-approval row until the approval gateway has issued a fresh permit.
 */
export class PiChangeDeliveryOutboxWorker implements TenantWorker {
  readonly role = "pi-change-delivery" as const;
  private draining = false;
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    private readonly service: PiChangeDeliveryService,
    private readonly maxItemsPerTenant = 1,
    private readonly externalDispatchEnabled = true,
  ) {
    if (!Number.isInteger(maxItemsPerTenant) || maxItemsPerTenant < 1 || maxItemsPerTenant > 32) throw new Error("PI_CHANGE_WORKER_BUDGET_INVALID");
  }

  async processTenant(tenantId: string, workerId: string, now = new Date()): Promise<WorkCycleResult> {
    if (this.draining) return { role: this.role, status: "idle" };
    const operation = this.processTenantInternal(tenantId, workerId, now);
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }

  beginDrain(): void {
    this.draining = true;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.active]);
  }

  private async processTenantInternal(tenantId: string, workerId: string, now: Date): Promise<WorkCycleResult> {
    const snapshot = await this.service.snapshot(workerContext(tenantId, workerId));
    const candidates = snapshot.outbox
      .filter((item) => (this.externalDispatchEnabled && (item.status === "queued" || item.status === "awaiting_approval")) || (item.status === "leased" && item.leaseExpiresAt !== undefined && new Date(item.leaseExpiresAt) <= now))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, this.maxItemsPerTenant);
    if (candidates.length === 0) return { role: this.role, status: "idle" };

    for (const candidate of candidates) {
      if (this.draining) return { role: this.role, status: "idle" };
      if (!this.externalDispatchEnabled && candidate.status !== "leased") return { role: this.role, status: "idle", workId: candidate.id };
      try {
        const result = await this.service.dispatchOutbox(workerContext(tenantId, workerId, candidate), candidate.id);
        if (["succeeded", "failed", "unknown", "cancelled"].includes(result.status)) {
          return { role: this.role, status: result.status === "succeeded" ? "succeeded" : result.status === "unknown" ? "unknown" : "failed", workId: candidate.id };
        }
        // Approval is still pending or the row changed concurrently. Keep the
        // durable fact intact and let the next cycle observe it again.
        return { role: this.role, status: "idle", workId: candidate.id };
      } catch {
        // The service has already failed closed before external side effects;
        // leave the row untouched so operators can inspect and recover it.
        return { role: this.role, status: "failed", workId: candidate.id };
      }
    }
    return { role: this.role, status: "idle" };
  }
}
