import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type {
  PiCapacityLease,
  PiCapacityPolicy,
  PiFaultPlan,
  PiFaultTarget,
  PiKillSwitch,
  PiSecurityEvent,
  PiSecurityResilienceStore,
} from "@/src/modules/pi-agent/domain/security-resilience-contracts";

type Row = Record<string, unknown>;
function clone<T>(value: T): T { return structuredClone(value); }
function text(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function optionalText(value: unknown): string | undefined { return value === null || value === undefined ? undefined : text(value); }
function iso(value: unknown): string { return new Date(String(value)).toISOString(); }

function killSwitchFromRow(row: Row): PiKillSwitch {
  return {
    id: text(row.id), ...(row.tenant_id ? { tenantId: text(row.tenant_id) } : {}), scope: row.scope as PiKillSwitch["scope"],
    ...(optionalText(row.target_digest) ? { targetDigest: text(row.target_digest) } : {}),
    ...(optionalText(row.target_profile) ? { targetProfile: text(row.target_profile) } : {}),
    ...(optionalText(row.target_model_route_id) ? { targetModelRouteId: text(row.target_model_route_id) } : {}),
    reasonCode: text(row.reason_code), status: row.status as PiKillSwitch["status"], activatedBy: text(row.activated_by), activatedAt: iso(row.activated_at),
    ...(row.released_at ? { releasedAt: iso(row.released_at) } : {}), ...(row.release_actor_id ? { releaseActorId: text(row.release_actor_id) } : {}), version: Number(row.version), actionDigest: text(row.action_digest),
  };
}

function eventFromRow(row: Row): PiSecurityEvent {
  return { id: text(row.id), tenantId: text(row.tenant_id), ...(row.actor_id ? { actorId: text(row.actor_id) } : {}), kind: row.kind as PiSecurityEvent["kind"], severity: row.severity as PiSecurityEvent["severity"], subjectDigest: text(row.subject_digest), reasonCode: text(row.reason_code), policyVersion: Number(row.policy_version), traceId: text(row.trace_id), createdAt: iso(row.created_at) };
}

function policyFromRow(row: Row): PiCapacityPolicy {
  return { id: text(row.id), tenantId: text(row.tenant_id), scope: row.scope as PiCapacityPolicy["scope"], ...(optionalText(row.scope_id) ? { scopeId: text(row.scope_id) } : {}), version: Number(row.version), maxConcurrentRuns: Number(row.max_concurrent_runs), maxQueueDepth: Number(row.max_queue_depth), maxPromptBytes: Number(row.max_prompt_bytes), maxEventBytes: Number(row.max_event_bytes), status: row.status as PiCapacityPolicy["status"], createdAt: iso(row.created_at) };
}

function leaseFromRow(row: Row): PiCapacityLease {
  return { id: text(row.id), tenantId: text(row.tenant_id), actorId: text(row.actor_id), runId: text(row.run_id), scope: row.scope as PiCapacityLease["scope"], ...(optionalText(row.scope_id) ? { scopeId: text(row.scope_id) } : {}), policyId: text(row.policy_id), policyVersion: Number(row.policy_version), idempotencyKey: text(row.idempotency_key), status: row.status as PiCapacityLease["status"], acquiredAt: iso(row.acquired_at), ...(row.released_at ? { releasedAt: iso(row.released_at) } : {}) };
}

function faultFromRow(row: Row): PiFaultPlan {
  return { id: text(row.id), tenantId: text(row.tenant_id), target: row.target as PiFaultTarget, errorCode: text(row.error_code), remaining: Number(row.remaining), createdBy: text(row.created_by), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) };
}

export class InMemoryPiSecurityResilienceStore implements PiSecurityResilienceStore {
  private readonly killSwitches = new Map<string, PiKillSwitch>();
  private readonly events = new Map<string, PiSecurityEvent>();
  private readonly policies = new Map<string, PiCapacityPolicy>();
  private readonly leases = new Map<string, PiCapacityLease>();
  private readonly faults = new Map<string, PiFaultPlan>();

  async listKillSwitches(context: RequestContext): Promise<PiKillSwitch[]> { return [...this.killSwitches.values()].filter((item) => item.scope === "global" || !item.tenantId || item.tenantId === context.tenantId).sort((a, b) => b.activatedAt.localeCompare(a.activatedAt)).map(clone); }
  async listActiveKillSwitches(context: RequestContext): Promise<PiKillSwitch[]> { return (await this.listKillSwitches(context)).filter((item) => item.status === "active"); }
  async findKillSwitchByActionDigest(context: RequestContext, actionDigest: string): Promise<PiKillSwitch | null> { const item = [...this.killSwitches.values()].find((candidate) => candidate.actionDigest === actionDigest && (candidate.scope === "global" || !candidate.tenantId || candidate.tenantId === context.tenantId)); return item ? clone(item) : null; }
  async putKillSwitch(item: PiKillSwitch): Promise<void> { if (this.killSwitches.has(item.id)) throw new Error("PI_KILL_SWITCH_DUPLICATE"); this.killSwitches.set(item.id, clone(item)); }
  async releaseKillSwitch(context: RequestContext, id: string, releasedAt: string, actorId: string): Promise<PiKillSwitch> { const item = this.killSwitches.get(id); if (!item || (item.scope !== "global" && item.tenantId !== context.tenantId)) throw new Error("PI_KILL_SWITCH_NOT_FOUND"); if (item.status !== "active") throw new Error("PI_KILL_SWITCH_STATE_CONFLICT"); const updated = { ...item, status: "released" as const, releasedAt, releaseActorId: actorId, version: item.version + 1 }; this.killSwitches.set(id, updated); return clone(updated); }
  async appendSecurityEvent(event: PiSecurityEvent): Promise<void> { if (this.events.has(event.id)) throw new Error("PI_SECURITY_EVENT_DUPLICATE"); this.events.set(event.id, clone(event)); }
  async listSecurityEvents(context: RequestContext, limit = 100): Promise<PiSecurityEvent[]> { return [...this.events.values()].filter((item) => item.tenantId === context.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(clone); }
  async putCapacityPolicy(policy: PiCapacityPolicy): Promise<void> { if ([...this.policies.values()].some((item) => item.tenantId === policy.tenantId && item.scope === policy.scope && item.scopeId === policy.scopeId && item.version === policy.version)) throw new Error("PI_CAPACITY_POLICY_DUPLICATE"); this.policies.set(`${policy.tenantId}:${policy.id}`, clone(policy)); }
  async listCapacityPolicies(context: RequestContext): Promise<PiCapacityPolicy[]> { return [...this.policies.values()].filter((item) => item.tenantId === context.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone); }
  async findCapacityPolicy(context: RequestContext, scope: PiCapacityPolicy["scope"], scopeId?: string): Promise<PiCapacityPolicy | null> { const item = [...this.policies.values()].filter((candidate) => candidate.tenantId === context.tenantId && candidate.scope === scope && candidate.scopeId === scopeId && candidate.status === "active").sort((a, b) => b.version - a.version)[0]; return item ? clone(item) : null; }
  async countActiveCapacity(context: RequestContext, policyId: string): Promise<number> { return [...this.leases.values()].filter((item) => item.tenantId === context.tenantId && item.policyId === policyId && item.status === "active").length; }
  async findCapacityLeaseByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiCapacityLease | null> { const item = [...this.leases.values()].find((candidate) => candidate.tenantId === context.tenantId && candidate.idempotencyKey === idempotencyKey); return item ? clone(item) : null; }
  async acquireCapacity(lease: PiCapacityLease): Promise<{ lease: PiCapacityLease; created: boolean }> { const existing = [...this.leases.values()].find((item) => item.tenantId === lease.tenantId && item.idempotencyKey === lease.idempotencyKey); if (existing) return { lease: clone(existing), created: false }; this.leases.set(`${lease.tenantId}:${lease.id}`, clone(lease)); return { lease: clone(lease), created: true }; }
  async releaseCapacity(context: RequestContext, leaseId: string, releasedAt: string): Promise<PiCapacityLease> { const key = `${context.tenantId}:${leaseId}`; const item = this.leases.get(key); if (!item) throw new Error("PI_CAPACITY_LEASE_NOT_FOUND"); if (item.status !== "active") throw new Error("PI_CAPACITY_LEASE_STATE_CONFLICT"); const updated = { ...item, status: "released" as const, releasedAt }; this.leases.set(key, updated); return clone(updated); }
  async getFaultPlan(context: RequestContext, target: PiFaultTarget): Promise<PiFaultPlan | null> { const plan = this.faults.get(`${context.tenantId}:${target}`); return plan ? clone(plan) : null; }
  async putFaultPlan(plan: PiFaultPlan): Promise<void> { this.faults.set(`${plan.tenantId}:${plan.target}`, clone(plan)); }
  async clearFaultPlans(context: RequestContext): Promise<void> { for (const key of this.faults.keys()) if (key.startsWith(`${context.tenantId}:`)) this.faults.delete(key); }
}

export class PostgresPiSecurityResilienceStore implements PiSecurityResilienceStore {
  constructor(private readonly database: TransactionalDatabase) {}
  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> { return this.database.withTenant(context.tenantId, work); }
  private systemContext(tenantId: string, traceId: string): RequestContext { return { tenantId, actorId: "00000000-0000-4000-8000-000000000000", sessionId: "system", channel: "system", traceId, roles: ["system"], permissions: [], dataScopes: [{ type: "tenant" }] }; }

  async listKillSwitches(context: RequestContext): Promise<PiKillSwitch[]> { return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_kill_switches WHERE scope='global' OR tenant_id=$1 ORDER BY activated_at DESC", [context.tenantId])).map(killSwitchFromRow)); }
  async listActiveKillSwitches(context: RequestContext): Promise<PiKillSwitch[]> { return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_kill_switches WHERE status='active' AND (scope='global' OR tenant_id=$1) ORDER BY activated_at DESC", [context.tenantId])).map(killSwitchFromRow)); }
  async findKillSwitchByActionDigest(context: RequestContext, actionDigest: string): Promise<PiKillSwitch | null> { return this.scoped(context, async (db) => { const rows = await db.query<Row>("SELECT * FROM pi_kill_switches WHERE action_digest=$1 AND (scope='global' OR tenant_id=$2) ORDER BY activated_at DESC LIMIT 1", [actionDigest, context.tenantId]); return rows[0] ? killSwitchFromRow(rows[0]) : null; }); }
  async putKillSwitch(item: PiKillSwitch): Promise<void> { await this.scoped(this.systemContext(item.tenantId ?? "00000000-0000-4000-8000-000000000000", item.actionDigest), async (db) => { await db.query("INSERT INTO pi_kill_switches(id,tenant_id,scope,target_digest,target_profile,target_model_route_id,reason_code,status,activated_by,activated_at,released_at,release_actor_id,version,action_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [item.id, item.tenantId ?? null, item.scope, item.targetDigest ?? null, item.targetProfile ?? null, item.targetModelRouteId ?? null, item.reasonCode, item.status, item.activatedBy, new Date(item.activatedAt), null, null, item.version, item.actionDigest]); }); }
  async releaseKillSwitch(context: RequestContext, id: string, releasedAt: string, actorId: string): Promise<PiKillSwitch> { return this.scoped(context, async (db) => { const rows = await db.query<Row>("UPDATE pi_kill_switches SET status='released',released_at=$3,release_actor_id=$4,version=version+1 WHERE id=$1 AND (scope='global' OR tenant_id=$2) AND status='active' RETURNING *", [id, context.tenantId, new Date(releasedAt), actorId]); if (!rows[0]) throw new Error("PI_KILL_SWITCH_NOT_FOUND"); return killSwitchFromRow(rows[0]); }); }
  async appendSecurityEvent(event: PiSecurityEvent): Promise<void> { await this.scoped(this.systemContext(event.tenantId, event.traceId), async (db) => { await db.query("INSERT INTO pi_security_events(id,tenant_id,actor_id,kind,severity,subject_digest,reason_code,policy_version,trace_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [event.id, event.tenantId, event.actorId ?? null, event.kind, event.severity, event.subjectDigest, event.reasonCode, event.policyVersion, event.traceId, new Date(event.createdAt)]); }); }
  async listSecurityEvents(context: RequestContext, limit = 100): Promise<PiSecurityEvent[]> { return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_security_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2", [context.tenantId, limit])).map(eventFromRow)); }
  async putCapacityPolicy(policy: PiCapacityPolicy): Promise<void> { await this.scoped(this.systemContext(policy.tenantId, policy.id), async (db) => { await db.query("INSERT INTO pi_capacity_policies(id,tenant_id,scope,scope_id,version,max_concurrent_runs,max_queue_depth,max_prompt_bytes,max_event_bytes,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [policy.id, policy.tenantId, policy.scope, policy.scopeId ?? null, policy.version, policy.maxConcurrentRuns, policy.maxQueueDepth, policy.maxPromptBytes, policy.maxEventBytes, policy.status, new Date(policy.createdAt)]); }); }
  async listCapacityPolicies(context: RequestContext): Promise<PiCapacityPolicy[]> { return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_capacity_policies WHERE tenant_id=$1 ORDER BY created_at DESC", [context.tenantId])).map(policyFromRow)); }
  async findCapacityPolicy(context: RequestContext, scope: PiCapacityPolicy["scope"], scopeId?: string): Promise<PiCapacityPolicy | null> { return this.scoped(context, async (db) => { const rows = await db.query<Row>("SELECT * FROM pi_capacity_policies WHERE tenant_id=$1 AND scope=$2 AND scope_id IS NOT DISTINCT FROM $3 AND status='active' ORDER BY version DESC LIMIT 1", [context.tenantId, scope, scopeId ?? null]); return rows[0] ? policyFromRow(rows[0]) : null; }); }
  async countActiveCapacity(context: RequestContext, policyId: string): Promise<number> { return this.scoped(context, async (db) => { const rows = await db.query<Row>("SELECT count(*)::int AS count FROM pi_capacity_leases WHERE tenant_id=$1 AND policy_id=$2 AND status='active'", [context.tenantId, policyId]); return Number(rows[0]?.count ?? 0); }); }
  async findCapacityLeaseByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiCapacityLease | null> { return this.scoped(context, async (db) => { const rows = await db.query<Row>("SELECT * FROM pi_capacity_leases WHERE tenant_id=$1 AND idempotency_key=$2", [context.tenantId, idempotencyKey]); return rows[0] ? leaseFromRow(rows[0]) : null; }); }
  async acquireCapacity(lease: PiCapacityLease): Promise<{ lease: PiCapacityLease; created: boolean }> { return this.scoped(this.systemContext(lease.tenantId, lease.id), async (db) => { const existing = await db.query<Row>("SELECT * FROM pi_capacity_leases WHERE tenant_id=$1 AND idempotency_key=$2", [lease.tenantId, lease.idempotencyKey]); if (existing[0]) return { lease: leaseFromRow(existing[0]), created: false }; const rows = await db.query<Row>("INSERT INTO pi_capacity_leases(id,tenant_id,actor_id,run_id,scope,scope_id,policy_id,policy_version,idempotency_key,status,acquired_at,released_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING *", [lease.id, lease.tenantId, lease.actorId, lease.runId, lease.scope, lease.scopeId ?? null, lease.policyId, lease.policyVersion, lease.idempotencyKey, lease.status, new Date(lease.acquiredAt), null]); if (rows[0]) return { lease: leaseFromRow(rows[0]), created: true }; const conflict = await db.query<Row>("SELECT * FROM pi_capacity_leases WHERE tenant_id=$1 AND idempotency_key=$2", [lease.tenantId, lease.idempotencyKey]); if (!conflict[0]) throw new Error("PI_CAPACITY_LEASE_CONFLICT"); return { lease: leaseFromRow(conflict[0]), created: false }; }); }
  async releaseCapacity(context: RequestContext, leaseId: string, releasedAt: string): Promise<PiCapacityLease> { return this.scoped(context, async (db) => { const rows = await db.query<Row>("UPDATE pi_capacity_leases SET status='released',released_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='active' RETURNING *", [context.tenantId, leaseId, new Date(releasedAt)]); if (!rows[0]) throw new Error("PI_CAPACITY_LEASE_NOT_FOUND"); return leaseFromRow(rows[0]); }); }
  async getFaultPlan(context: RequestContext, target: PiFaultTarget): Promise<PiFaultPlan | null> { return this.scoped(context, async (db) => { const rows = await db.query<Row>("SELECT * FROM pi_fault_plans WHERE tenant_id=$1 AND target=$2", [context.tenantId, target]); return rows[0] ? faultFromRow(rows[0]) : null; }); }
  async putFaultPlan(plan: PiFaultPlan): Promise<void> { await this.scoped(this.systemContext(plan.tenantId, plan.id), async (db) => { await db.query("INSERT INTO pi_fault_plans(id,tenant_id,target,error_code,remaining,created_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,target) DO UPDATE SET id=EXCLUDED.id,error_code=EXCLUDED.error_code,remaining=EXCLUDED.remaining,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at", [plan.id, plan.tenantId, plan.target, plan.errorCode, plan.remaining, plan.createdBy, new Date(plan.createdAt), new Date(plan.expiresAt)]); }); }
  async clearFaultPlans(context: RequestContext): Promise<void> { await this.scoped(context, async (db) => { await db.query("DELETE FROM pi_fault_plans WHERE tenant_id=$1", [context.tenantId]); }); }
}
