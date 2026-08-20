import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import type { PiQuotaAdmission, PiQuotaPolicy, PiQuotaReservation, PiQuotaStore, PiQuotaUsage } from "@/src/modules/pi-agent/domain/quota-contracts";

function scopeKey(policy: PiQuotaPolicy): string { return `${policy.scope}:${policy.scopeId ?? "*"}`; }
function safeUsage(value: Partial<PiQuotaUsage>): PiQuotaUsage { return { concurrentRuns: value.concurrentRuns ?? 0, tokens: value.tokens ?? 0, costMicros: value.costMicros ?? 0, storageBytes: value.storageBytes ?? 0, toolCalls: value.toolCalls ?? 0 }; }
function positiveUsage(value: PiQuotaUsage): boolean { return Object.values(value).every((item) => Number.isInteger(item) && item >= 0); }

export class PiQuotaService {
  constructor(private readonly store: PiQuotaStore) {}

  async publishPolicy(context: RequestContext, input: Omit<PiQuotaPolicy, "id" | "tenantId" | "createdAt">): Promise<PiQuotaPolicy> {
    assertPiPermission(context, "pi:quota:admin");
    if (!input.version || !positiveUsage({ concurrentRuns: input.maxConcurrentRuns, tokens: input.maxTokens, costMicros: input.maxCostMicros, storageBytes: input.maxStorageBytes, toolCalls: input.maxToolCalls })) throw new Error("PI_QUOTA_POLICY_INVALID");
    if (input.scope === "tenant" && input.scopeId) throw new Error("PI_QUOTA_SCOPE_INVALID");
    if (input.scope !== "tenant" && !input.scopeId) throw new Error("PI_QUOTA_SCOPE_INVALID");
    const policy: PiQuotaPolicy = { id: randomUUID(), tenantId: context.tenantId, ...input, createdAt: new Date().toISOString() };
    await this.store.putPolicy(policy);
    return policy;
  }

  async listPolicies(context: RequestContext): Promise<PiQuotaPolicy[]> { assertPiPermission(context, "pi:quota:read"); return this.store.listPolicies(context); }

  async checkAdmission(context: RequestContext, policyId: string, requested: PiQuotaUsage): Promise<PiQuotaAdmission> {
    const policy = await this.store.getPolicy(context, policyId);
    if (!policy) return { allowed: false, usage: safeUsage({}), requested, reasonCode: "policy_not_found" };
    if (policy.status !== "active") return { allowed: false, policy, usage: safeUsage({}), requested, reasonCode: "policy_revoked" };
    const usage = await this.store.summarize(context, policy);
    const allowed = usage.concurrentRuns + requested.concurrentRuns <= policy.maxConcurrentRuns && usage.tokens + requested.tokens <= policy.maxTokens && usage.costMicros + requested.costMicros <= policy.maxCostMicros && usage.storageBytes + requested.storageBytes <= policy.maxStorageBytes && usage.toolCalls + requested.toolCalls <= policy.maxToolCalls;
    return { allowed, policy, usage, requested, ...(allowed ? {} : { reasonCode: "quota_exceeded" as const }) };
  }

  async reserve(context: RequestContext, input: { policyId: string; idempotencyKey: string; requested: PiQuotaUsage; runId?: string }): Promise<PiQuotaReservation> {
    assertPiPermission(context, "pi:quota:admin");
    if (!input.idempotencyKey || input.idempotencyKey.length > 256 || !positiveUsage(input.requested)) throw new Error("PI_QUOTA_RESERVATION_INVALID");
    const existing = await this.store.getReservationByIdempotency(context, input.idempotencyKey);
    if (existing) return existing;
    const admission = await this.checkAdmission(context, input.policyId, input.requested);
    if (!admission.policy) throw new Error("PI_QUOTA_POLICY_NOT_FOUND");
    if (!admission.allowed) throw new Error("PI_QUOTA_EXCEEDED");
    const reservation: PiQuotaReservation = { id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, ...(input.runId ? { runId: input.runId } : {}), scope: admission.policy.scope, ...(admission.policy.scopeId ? { scopeId: admission.policy.scopeId } : {}), policyId: admission.policy.id, policyVersion: admission.policy.version, idempotencyKey: input.idempotencyKey, reserved: input.requested, consumed: safeUsage({}), status: "active", createdAt: new Date().toISOString() };
    return (await this.store.createReservation(reservation)).reservation;
  }

  async consume(context: RequestContext, reservationId: string, consumed: PiQuotaUsage): Promise<PiQuotaReservation> {
    assertPiPermission(context, "pi:quota:admin");
    if (!positiveUsage(consumed)) throw new Error("PI_QUOTA_USAGE_INVALID");
    const reservation = await this.store.getReservation(context, reservationId);
    if (!reservation) throw new Error("PI_QUOTA_RESERVATION_NOT_FOUND");
    if (reservation.status !== "active") throw new Error("PI_QUOTA_RESERVATION_STATE_CONFLICT");
    const exceedsReserved = Object.entries(consumed).some(([key, value]) => value > reservation.reserved[key as keyof PiQuotaUsage]);
    if (exceedsReserved) throw new Error("PI_QUOTA_USAGE_EXCEEDS_RESERVATION");
    return this.store.updateReservation(context, reservationId, { consumed, status: "consumed" });
  }

  async release(context: RequestContext, reservationId: string): Promise<PiQuotaReservation> {
    assertPiPermission(context, "pi:quota:admin");
    const reservation = await this.store.getReservation(context, reservationId);
    if (!reservation) throw new Error("PI_QUOTA_RESERVATION_NOT_FOUND");
    if (reservation.status !== "active") throw new Error("PI_QUOTA_RESERVATION_STATE_CONFLICT");
    return this.store.updateReservation(context, reservationId, { status: "released", releasedAt: new Date().toISOString() });
  }

  async summary(context: RequestContext): Promise<Array<{ policy: PiQuotaPolicy; usage: PiQuotaUsage; scopeKey: string }>> {
    assertPiPermission(context, "pi:quota:read");
    const policies = await this.store.listPolicies(context);
    return Promise.all(policies.map(async (policy) => ({ policy, usage: await this.store.summarize(context, policy), scopeKey: scopeKey(policy) })));
  }
}
