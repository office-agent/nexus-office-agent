import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type {
  PiSandboxRunRecord,
  PiSandboxRunStore,
  PiSandboxStatus,
} from "@/src/modules/pi-agent/domain/contracts";

type SandboxRunRow = Record<string, unknown>;

const TRANSITIONS: Record<PiSandboxStatus, PiSandboxStatus[]> = {
  provisioning: ["running", "terminating", "failed", "unknown"],
  running: ["terminating", "completed", "failed", "unknown"],
  terminating: ["destroyed", "failed", "unknown"],
  completed: ["terminating", "destroyed", "failed", "unknown"],
  failed: ["terminating", "destroyed", "unknown"],
  destroyed: [],
  unknown: ["terminating", "destroyed"],
};

function now(): string {
  return new Date().toISOString();
}

function assertTransition(from: PiSandboxStatus, to: PiSandboxStatus): void {
  if (from !== to && !TRANSITIONS[from].includes(to)) throw new Error("PI_SANDBOX_STATE_CONFLICT");
}

function recordFromRow(row: SandboxRunRow): PiSandboxRunRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    sessionId: String(row.pi_session_id),
    runId: String(row.pi_run_id),
    workspaceId: String(row.workspace_id),
    profile: row.profile as PiSandboxRunRecord["profile"],
    provider: row.provider as PiSandboxRunRecord["provider"],
    providerSandboxId: row.provider_sandbox_id ? String(row.provider_sandbox_id) : undefined,
    imageDigest: row.image_digest ? String(row.image_digest) : undefined,
    networkPolicy: row.network_policy as PiSandboxRunRecord["networkPolicy"],
    networkPolicySpec: row.network_policy_spec as PiSandboxRunRecord["networkPolicySpec"],
    networkPolicyDigest: String(row.network_policy_digest),
    limits: row.resource_limits as PiSandboxRunRecord["limits"],
    status: row.status as PiSandboxStatus,
    usage: row.usage ? row.usage as PiSandboxRunRecord["usage"] : undefined,
    failureCode: row.failure_code ? String(row.failure_code) : undefined,
    terminationReason: row.termination_reason ? String(row.termination_reason) : undefined,
    destroyVerified: Boolean(row.destroy_verified),
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : undefined,
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : undefined,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export class InMemoryPiSandboxRunStore implements PiSandboxRunStore {
  private readonly records = new Map<string, PiSandboxRunRecord>();

  async create(record: PiSandboxRunRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error("PI_SANDBOX_RUN_DUPLICATE");
    this.records.set(record.id, structuredClone(record));
  }

  async get(context: RequestContext, sandboxRunId: string): Promise<PiSandboxRunRecord | null> {
    const record = this.records.get(sandboxRunId);
    if (!record || record.tenantId !== context.tenantId || record.actorId !== context.actorId) return null;
    return structuredClone(record);
  }

  async getByRun(context: RequestContext, runId: string): Promise<PiSandboxRunRecord | null> {
    return [...this.records.values()]
      .filter((record) => record.tenantId === context.tenantId && record.actorId === context.actorId && record.runId === runId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => structuredClone(record))[0] ?? null;
  }

  async transition(
    context: RequestContext,
    sandboxRunId: string,
    status: PiSandboxStatus,
    patch: Partial<Pick<PiSandboxRunRecord, "providerSandboxId" | "usage" | "failureCode" | "terminationReason" | "destroyVerified" | "startedAt" | "completedAt" | "updatedAt">> = {},
  ): Promise<PiSandboxRunRecord> {
    const record = await this.get(context, sandboxRunId);
    if (!record) throw new Error("PI_SANDBOX_RUN_NOT_FOUND");
    assertTransition(record.status, status);
    const updated = { ...record, ...patch, status, updatedAt: patch.updatedAt ?? now() };
    this.records.set(sandboxRunId, structuredClone(updated));
    return structuredClone(updated);
  }

  async list(context: RequestContext, sessionId: string): Promise<PiSandboxRunRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.tenantId === context.tenantId && record.actorId === context.actorId && record.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => structuredClone(record));
  }
}

export class PostgresPiSandboxRunStore implements PiSandboxRunStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.database.withTenant(context.tenantId, work);
  }

  async create(record: PiSandboxRunRecord): Promise<void> {
    const context: RequestContext = {
      tenantId: record.tenantId,
      actorId: record.actorId,
      sessionId: record.sessionId,
      channel: "system",
      traceId: record.id,
      roles: ["pi-runner"],
      permissions: [],
      dataScopes: [{ type: "tenant" }],
    };
    await this.scoped(context, async (db) => {
      await db.query(
        `INSERT INTO sandbox_runs
          (id,tenant_id,actor_id,pi_session_id,pi_run_id,workspace_id,profile,provider,provider_sandbox_id,image_digest,
           network_policy,network_policy_digest,network_policy_spec,resource_limits,status,resource_quota,usage,
           destroy_verified,failure_code,termination_reason,started_at,completed_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$14,$16,$17,$18,$19,$20,$21,now(),now())`,
        [record.id, record.tenantId, record.actorId, record.sessionId, record.runId, record.workspaceId, record.profile,
          record.provider, record.providerSandboxId ?? null, record.imageDigest ?? null, record.networkPolicy,
          record.networkPolicyDigest, JSON.stringify(record.networkPolicySpec), JSON.stringify(record.limits), record.status,
          record.usage ? JSON.stringify(record.usage) : null, record.destroyVerified, record.failureCode ?? null,
          record.terminationReason ?? null, record.startedAt ? new Date(record.startedAt) : null, record.completedAt ? new Date(record.completedAt) : null],
      );
    });
  }

  async get(context: RequestContext, sandboxRunId: string): Promise<PiSandboxRunRecord | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<SandboxRunRow>(
        "SELECT * FROM sandbox_runs WHERE tenant_id=$1 AND actor_id=$2 AND id=$3",
        [context.tenantId, context.actorId, sandboxRunId],
      );
      return rows[0] ? recordFromRow(rows[0]) : null;
    });
  }

  async getByRun(context: RequestContext, runId: string): Promise<PiSandboxRunRecord | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<SandboxRunRow>(
        "SELECT * FROM sandbox_runs WHERE tenant_id=$1 AND actor_id=$2 AND pi_run_id=$3 ORDER BY created_at DESC LIMIT 1",
        [context.tenantId, context.actorId, runId],
      );
      return rows[0] ? recordFromRow(rows[0]) : null;
    });
  }

  async transition(
    context: RequestContext,
    sandboxRunId: string,
    status: PiSandboxStatus,
    patch: Partial<Pick<PiSandboxRunRecord, "providerSandboxId" | "usage" | "failureCode" | "terminationReason" | "destroyVerified" | "startedAt" | "completedAt" | "updatedAt">> = {},
  ): Promise<PiSandboxRunRecord> {
    return this.scoped(context, async (db) => {
      const current = await db.query<SandboxRunRow>(
        "SELECT * FROM sandbox_runs WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 FOR UPDATE",
        [context.tenantId, context.actorId, sandboxRunId],
      );
      if (!current[0]) throw new Error("PI_SANDBOX_RUN_NOT_FOUND");
      const record = recordFromRow(current[0]);
      assertTransition(record.status, status);
      const rows = await db.query<SandboxRunRow>(
        `UPDATE sandbox_runs
         SET status=$4,
             provider_sandbox_id=COALESCE($5,provider_sandbox_id),
             usage=COALESCE($6,usage),
             failure_code=COALESCE($7,failure_code),
             termination_reason=COALESCE($8,termination_reason),
             destroy_verified=COALESCE($9,destroy_verified),
             started_at=COALESCE($10,started_at),
             completed_at=COALESCE($11,completed_at),
             updated_at=COALESCE($12,now())
         WHERE tenant_id=$1 AND actor_id=$2 AND id=$3
         RETURNING *`,
        [context.tenantId, context.actorId, sandboxRunId, status, patch.providerSandboxId ?? null,
          patch.usage ? JSON.stringify(patch.usage) : null, patch.failureCode ?? null, patch.terminationReason ?? null,
          patch.destroyVerified ?? null, patch.startedAt ? new Date(patch.startedAt) : null,
          patch.completedAt ? new Date(patch.completedAt) : null, patch.updatedAt ? new Date(patch.updatedAt) : null],
      );
      return recordFromRow(rows[0]);
    });
  }

  async list(context: RequestContext, sessionId: string): Promise<PiSandboxRunRecord[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<SandboxRunRow>(
        "SELECT * FROM sandbox_runs WHERE tenant_id=$1 AND actor_id=$2 AND pi_session_id=$3 ORDER BY created_at DESC",
        [context.tenantId, context.actorId, sessionId],
      );
      return rows.map(recordFromRow);
    });
  }
}
