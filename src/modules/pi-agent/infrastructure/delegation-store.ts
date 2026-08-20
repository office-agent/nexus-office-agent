import type { RequestContext, DataScope } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type { PiDelegation, PiChildRunStatus } from "@/src/modules/pi-agent/domain/delegation-contracts";
import type { PiDelegationBudget } from "@/src/modules/pi-agent/domain/profile-contracts";
import type { PiDelegationStore } from "@/src/modules/pi-agent/domain/delegation-contracts";

type Row = Record<string, unknown>;

function clone<T>(value: T): T { return structuredClone(value); }

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value && typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value as T | undefined) ?? fallback;
}

function delegationFromRow(row: Row): PiDelegation {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    parentSessionId: String(row.parent_session_id),
    parentBranchId: row.parent_branch_id ? String(row.parent_branch_id) : undefined,
    childSessionId: row.child_session_id ? String(row.child_session_id) : undefined,
    parentRunId: row.parent_run_id ? String(row.parent_run_id) : undefined,
    childRunId: row.child_run_id ? String(row.child_run_id) : undefined,
    profileId: row.profile_id as PiDelegation["profileId"],
    profileVersion: Number(row.profile_version),
    profileDigest: String(row.profile_digest),
    depth: Number(row.depth),
    status: row.status as PiChildRunStatus,
    budget: jsonValue<PiDelegationBudget>(row.budget, { maxDurationMs: 0, maxOutputBytes: 0, maxTokens: 0, maxChildRuns: 0 }),
    allowedTools: jsonValue<string[]>(row.allowed_tools, []),
    dataScopes: jsonValue<DataScope[]>(row.data_scopes, []),
    idempotencyKey: String(row.idempotency_key),
    version: Number(row.version),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export class InMemoryPiDelegationStore implements PiDelegationStore {
  private readonly records = new Map<string, PiDelegation>();

  async findByIdempotency(context: RequestContext, parentSessionId: string, idempotencyKey: string): Promise<PiDelegation | null> {
    const result = [...this.records.values()].find((item) => item.tenantId === context.tenantId && item.parentSessionId === parentSessionId && item.idempotencyKey === idempotencyKey);
    return result ? clone(result) : null;
  }

  async get(context: RequestContext, delegationId: string): Promise<PiDelegation | null> {
    const result = this.records.get(`${context.tenantId}:${delegationId}`);
    return result && result.createdBy === context.actorId ? clone(result) : null;
  }

  async getByChildSession(context: RequestContext, childSessionId: string): Promise<PiDelegation | null> {
    const result = [...this.records.values()].find((item) => item.tenantId === context.tenantId && item.childSessionId === childSessionId);
    return result ? clone(result) : null;
  }

  async listByParent(context: RequestContext, parentSessionId: string): Promise<PiDelegation[]> {
    return [...this.records.values()].filter((item) => item.tenantId === context.tenantId && item.parentSessionId === parentSessionId && item.createdBy === context.actorId).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone);
  }

  async countActiveByParent(context: RequestContext, parentSessionId: string): Promise<number> {
    return (await this.listByParent(context, parentSessionId)).filter((item) => ["admitted", "queued", "running"].includes(item.status)).length;
  }

  async create(delegation: PiDelegation): Promise<PiDelegation> {
    const key = `${delegation.tenantId}:${delegation.id}`;
    if (this.records.has(key)) throw new Error("PI_DELEGATION_DUPLICATE");
    if ([...this.records.values()].some((item) => item.tenantId === delegation.tenantId && item.parentSessionId === delegation.parentSessionId && item.idempotencyKey === delegation.idempotencyKey)) throw new Error("PI_DELEGATION_IDEMPOTENCY_CONFLICT");
    if (delegation.childSessionId && [...this.records.values()].some((item) => item.tenantId === delegation.tenantId && item.childSessionId === delegation.childSessionId)) throw new Error("PI_DELEGATION_CHILD_DUPLICATE");
    this.records.set(key, clone(delegation));
    return clone(delegation);
  }

  async update(context: RequestContext, delegationId: string, expectedVersion: number, patch: Partial<Pick<PiDelegation, "childSessionId" | "childRunId" | "status" | "version">>): Promise<PiDelegation> {
    const key = `${context.tenantId}:${delegationId}`;
    const current = this.records.get(key);
    if (!current || current.createdBy !== context.actorId) throw new Error("PI_DELEGATION_NOT_FOUND");
    if (current.version !== expectedVersion) throw new Error("PI_DELEGATION_VERSION_CONFLICT");
    const updated = { ...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString() };
    this.records.set(key, updated);
    return clone(updated);
  }
}

export class PostgresPiDelegationStore implements PiDelegationStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> { return this.database.withTenant(context.tenantId, work); }

  async findByIdempotency(context: RequestContext, parentSessionId: string, idempotencyKey: string): Promise<PiDelegation | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT d.* FROM pi_agent_delegations d JOIN pi_sessions p ON p.id=d.parent_session_id AND p.tenant_id=d.tenant_id
         WHERE d.tenant_id=$1 AND d.parent_session_id=$2 AND d.idempotency_key=$3 AND p.actor_id=$4`,
        [context.tenantId, parentSessionId, idempotencyKey, context.actorId],
      );
      return rows[0] ? delegationFromRow(rows[0]) : null;
    });
  }

  async get(context: RequestContext, delegationId: string): Promise<PiDelegation | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT d.* FROM pi_agent_delegations d JOIN pi_sessions p ON p.id=d.parent_session_id AND p.tenant_id=d.tenant_id
         WHERE d.tenant_id=$1 AND d.id=$2 AND p.actor_id=$3`,
        [context.tenantId, delegationId, context.actorId],
      );
      return rows[0] ? delegationFromRow(rows[0]) : null;
    });
  }

  async getByChildSession(context: RequestContext, childSessionId: string): Promise<PiDelegation | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT d.* FROM pi_agent_delegations d JOIN pi_sessions p ON p.id=d.parent_session_id AND p.tenant_id=d.tenant_id
         WHERE d.tenant_id=$1 AND d.child_session_id=$2 AND p.actor_id=$3`,
        [context.tenantId, childSessionId, context.actorId],
      );
      return rows[0] ? delegationFromRow(rows[0]) : null;
    });
  }

  async listByParent(context: RequestContext, parentSessionId: string): Promise<PiDelegation[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT d.* FROM pi_agent_delegations d JOIN pi_sessions p ON p.id=d.parent_session_id AND p.tenant_id=d.tenant_id
         WHERE d.tenant_id=$1 AND d.parent_session_id=$2 AND p.actor_id=$3 ORDER BY d.created_at ASC`,
        [context.tenantId, parentSessionId, context.actorId],
      );
      return rows.map(delegationFromRow);
    });
  }

  async countActiveByParent(context: RequestContext, parentSessionId: string): Promise<number> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pi_agent_delegations d JOIN pi_sessions p ON p.id=d.parent_session_id AND p.tenant_id=d.tenant_id
         WHERE d.tenant_id=$1 AND d.parent_session_id=$2 AND p.actor_id=$3 AND d.status IN ('admitted','queued','running')`,
        [context.tenantId, parentSessionId, context.actorId],
      );
      return Number(rows[0]?.count ?? 0);
    });
  }

  async create(delegation: PiDelegation): Promise<PiDelegation> {
    return this.database.withTenant(delegation.tenantId, async (db) => {
      const rows = await db.query<Row>(
        `INSERT INTO pi_agent_delegations
          (id,tenant_id,parent_session_id,parent_branch_id,child_session_id,parent_run_id,child_run_id,profile_id,profile_version,profile_digest,depth,status,budget,allowed_tools,data_scopes,idempotency_key,version,created_by)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
         WHERE EXISTS (SELECT 1 FROM pi_sessions WHERE tenant_id=$2 AND id=$3 AND actor_id=$18)
         RETURNING *`,
        [delegation.id, delegation.tenantId, delegation.parentSessionId, delegation.parentBranchId ?? null, delegation.childSessionId ?? null, delegation.parentRunId ?? null, delegation.childRunId ?? null, delegation.profileId, delegation.profileVersion, delegation.profileDigest, delegation.depth, delegation.status, delegation.budget, delegation.allowedTools, delegation.dataScopes, delegation.idempotencyKey, delegation.version, delegation.createdBy],
      );
      if (!rows[0]) throw new Error("PI_DELEGATION_CREATE_FAILED");
      return delegationFromRow(rows[0]);
    });
  }

  async update(context: RequestContext, delegationId: string, expectedVersion: number, patch: Partial<Pick<PiDelegation, "childSessionId" | "childRunId" | "status" | "version">>): Promise<PiDelegation> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `UPDATE pi_agent_delegations d SET child_session_id=COALESCE($3,d.child_session_id), child_run_id=COALESCE($4,d.child_run_id), status=COALESCE($5,d.status), version=d.version+1, updated_at=now()
         FROM pi_sessions p
         WHERE d.tenant_id=$1 AND d.id=$2 AND d.version=$6 AND p.id=d.parent_session_id AND p.tenant_id=d.tenant_id AND p.actor_id=$7
         RETURNING d.*`,
        [context.tenantId, delegationId, patch.childSessionId ?? null, patch.childRunId ?? null, patch.status ?? null, expectedVersion, context.actorId],
      );
      if (!rows[0]) throw new Error("PI_DELEGATION_VERSION_CONFLICT");
      return delegationFromRow(rows[0]);
    });
  }
}

