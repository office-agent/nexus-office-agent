import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type { PiContextSummary, PiSessionBranch, PiSessionTreeStore } from "@/src/modules/pi-agent/domain/session-tree-contracts";

type Row = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

function branchFromRow(row: Row): PiSessionBranch {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    sessionId: String(row.pi_session_id),
    parentBranchId: row.parent_branch_id ? String(row.parent_branch_id) : undefined,
    baseEventSequence: Number(row.base_event_sequence),
    headEventSequence: Number(row.head_event_sequence),
    label: String(row.label),
    status: row.status as PiSessionBranch["status"],
    version: Number(row.version),
    idempotencyKey: String(row.idempotency_key),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function summaryFromRow(row: Row): PiContextSummary {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    sessionId: String(row.pi_session_id),
    branchId: String(row.branch_id),
    sourceStartSequence: Number(row.source_start_sequence),
    sourceEndSequence: Number(row.source_end_sequence),
    sourceEventIds: jsonArray<string>(row.source_event_ids),
    eventTypes: jsonArray<string>(row.event_types),
    summary: row.summary,
    summaryDigest: String(row.summary_digest),
    compactionVersion: Number(row.compaction_version),
    idempotencyKey: String(row.idempotency_key),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export class InMemoryPiSessionTreeStore implements PiSessionTreeStore {
  private readonly branches = new Map<string, PiSessionBranch>();
  private readonly summaries = new Map<string, PiContextSummary>();

  private branchKey(tenantId: string, branchId: string): string { return `${tenantId}:${branchId}`; }
  private summaryKey(tenantId: string, summaryId: string): string { return `${tenantId}:${summaryId}`; }

  async findBranchByIdempotency(context: RequestContext, sessionId: string, idempotencyKey: string): Promise<PiSessionBranch | null> {
    const value = [...this.branches.values()].find((branch) => branch.tenantId === context.tenantId && branch.sessionId === sessionId && branch.idempotencyKey === idempotencyKey);
    return value ? clone(value) : null;
  }

  async getBranch(context: RequestContext, sessionId: string, branchId: string): Promise<PiSessionBranch | null> {
    const value = this.branches.get(this.branchKey(context.tenantId, branchId));
    return value && value.sessionId === sessionId && value.createdBy === context.actorId ? clone(value) : null;
  }

  async listBranches(context: RequestContext, sessionId: string): Promise<PiSessionBranch[]> {
    return [...this.branches.values()]
      .filter((branch) => branch.tenantId === context.tenantId && branch.sessionId === sessionId && branch.createdBy === context.actorId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async createBranch(branch: PiSessionBranch): Promise<PiSessionBranch> {
    const key = this.branchKey(branch.tenantId, branch.id);
    if (this.branches.has(key)) throw new Error("PI_SESSION_BRANCH_DUPLICATE");
    if ([...this.branches.values()].some((item) => item.tenantId === branch.tenantId && item.sessionId === branch.sessionId && item.idempotencyKey === branch.idempotencyKey)) {
      throw new Error("PI_SESSION_BRANCH_IDEMPOTENCY_CONFLICT");
    }
    this.branches.set(key, clone(branch));
    return clone(branch);
  }

  async updateBranch(context: RequestContext, branchId: string, expectedVersion: number, patch: Partial<Pick<PiSessionBranch, "headEventSequence" | "status">>): Promise<PiSessionBranch> {
    const key = this.branchKey(context.tenantId, branchId);
    const current = this.branches.get(key);
    if (!current || current.createdBy !== context.actorId) throw new Error("PI_SESSION_BRANCH_NOT_FOUND");
    if (current.version !== expectedVersion) throw new Error("PI_SESSION_BRANCH_VERSION_CONFLICT");
    const updated = { ...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString() };
    this.branches.set(key, updated);
    return clone(updated);
  }

  async findSummaryByIdempotency(context: RequestContext, sessionId: string, branchId: string, idempotencyKey: string): Promise<PiContextSummary | null> {
    const value = [...this.summaries.values()].find((summary) => summary.tenantId === context.tenantId && summary.sessionId === sessionId && summary.branchId === branchId && summary.idempotencyKey === idempotencyKey);
    return value ? clone(value) : null;
  }

  async createSummary(summary: PiContextSummary): Promise<PiContextSummary> {
    const key = this.summaryKey(summary.tenantId, summary.id);
    if (this.summaries.has(key)) throw new Error("PI_CONTEXT_SUMMARY_DUPLICATE");
    if ([...this.summaries.values()].some((item) => item.tenantId === summary.tenantId && item.sessionId === summary.sessionId && item.branchId === summary.branchId && item.idempotencyKey === summary.idempotencyKey)) {
      throw new Error("PI_CONTEXT_SUMMARY_IDEMPOTENCY_CONFLICT");
    }
    this.summaries.set(key, clone(summary));
    return clone(summary);
  }

  async listSummaries(context: RequestContext, sessionId: string, branchId?: string): Promise<PiContextSummary[]> {
    return [...this.summaries.values()]
      .filter((summary) => summary.tenantId === context.tenantId && summary.sessionId === sessionId && summary.createdBy === context.actorId && (!branchId || summary.branchId === branchId))
      .sort((left, right) => left.sourceEndSequence - right.sourceEndSequence)
      .map(clone);
  }
}

export class PostgresPiSessionTreeStore implements PiSessionTreeStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.database.withTenant(context.tenantId, work);
  }

  async findBranchByIdempotency(context: RequestContext, sessionId: string, idempotencyKey: string): Promise<PiSessionBranch | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT b.* FROM pi_session_branches b JOIN pi_sessions s ON s.id=b.pi_session_id AND s.tenant_id=b.tenant_id
         WHERE b.tenant_id=$1 AND b.pi_session_id=$2 AND b.idempotency_key=$3 AND s.actor_id=$4`,
        [context.tenantId, sessionId, idempotencyKey, context.actorId],
      );
      return rows[0] ? branchFromRow(rows[0]) : null;
    });
  }

  async getBranch(context: RequestContext, sessionId: string, branchId: string): Promise<PiSessionBranch | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT b.* FROM pi_session_branches b JOIN pi_sessions s ON s.id=b.pi_session_id AND s.tenant_id=b.tenant_id
         WHERE b.tenant_id=$1 AND b.pi_session_id=$2 AND b.id=$3 AND s.actor_id=$4`,
        [context.tenantId, sessionId, branchId, context.actorId],
      );
      return rows[0] ? branchFromRow(rows[0]) : null;
    });
  }

  async listBranches(context: RequestContext, sessionId: string): Promise<PiSessionBranch[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT b.* FROM pi_session_branches b JOIN pi_sessions s ON s.id=b.pi_session_id AND s.tenant_id=b.tenant_id
         WHERE b.tenant_id=$1 AND b.pi_session_id=$2 AND s.actor_id=$3 ORDER BY b.created_at ASC`,
        [context.tenantId, sessionId, context.actorId],
      );
      return rows.map(branchFromRow);
    });
  }

  async createBranch(branch: PiSessionBranch): Promise<PiSessionBranch> {
    return this.database.withTenant(branch.tenantId, async (db) => {
      const rows = await db.query<Row>(
        `INSERT INTO pi_session_branches
          (id,tenant_id,pi_session_id,parent_branch_id,base_event_sequence,head_event_sequence,label,status,version,idempotency_key,created_by)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
         WHERE EXISTS (SELECT 1 FROM pi_sessions WHERE tenant_id=$2 AND id=$3 AND actor_id=$11)
         RETURNING *`,
        [branch.id, branch.tenantId, branch.sessionId, branch.parentBranchId ?? null, branch.baseEventSequence, branch.headEventSequence, branch.label, branch.status, branch.version, branch.idempotencyKey, branch.createdBy],
      );
      if (!rows[0]) throw new Error("PI_SESSION_BRANCH_CREATE_FAILED");
      return branchFromRow(rows[0]);
    });
  }

  async updateBranch(context: RequestContext, branchId: string, expectedVersion: number, patch: Partial<Pick<PiSessionBranch, "headEventSequence" | "status">>): Promise<PiSessionBranch> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `UPDATE pi_session_branches b SET
           head_event_sequence=COALESCE($3, b.head_event_sequence),
           status=COALESCE($4, b.status),
           version=b.version+1,
           updated_at=now()
         FROM pi_sessions s
         WHERE b.tenant_id=$1 AND b.id=$2 AND b.version=$5 AND b.pi_session_id=s.id AND s.tenant_id=b.tenant_id AND s.actor_id=$6
         RETURNING b.*`,
        [context.tenantId, branchId, patch.headEventSequence ?? null, patch.status ?? null, expectedVersion, context.actorId],
      );
      if (!rows[0]) throw new Error("PI_SESSION_BRANCH_VERSION_CONFLICT");
      return branchFromRow(rows[0]);
    });
  }

  async findSummaryByIdempotency(context: RequestContext, sessionId: string, branchId: string, idempotencyKey: string): Promise<PiContextSummary | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT c.* FROM pi_context_summaries c JOIN pi_sessions s ON s.id=c.pi_session_id AND s.tenant_id=c.tenant_id
         WHERE c.tenant_id=$1 AND c.pi_session_id=$2 AND c.branch_id=$3 AND c.idempotency_key=$4 AND s.actor_id=$5`,
        [context.tenantId, sessionId, branchId, idempotencyKey, context.actorId],
      );
      return rows[0] ? summaryFromRow(rows[0]) : null;
    });
  }

  async createSummary(summary: PiContextSummary): Promise<PiContextSummary> {
    return this.database.withTenant(summary.tenantId, async (db) => {
      const rows = await db.query<Row>(
        `INSERT INTO pi_context_summaries
          (id,tenant_id,pi_session_id,branch_id,source_start_sequence,source_end_sequence,source_event_ids,event_types,summary,summary_digest,compaction_version,idempotency_key,created_by)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
         WHERE EXISTS (SELECT 1 FROM pi_sessions WHERE tenant_id=$2 AND id=$3 AND actor_id=$13)
         RETURNING *`,
        [summary.id, summary.tenantId, summary.sessionId, summary.branchId, summary.sourceStartSequence, summary.sourceEndSequence, summary.sourceEventIds, summary.eventTypes, JSON.stringify(summary.summary), summary.summaryDigest, summary.compactionVersion, summary.idempotencyKey, summary.createdBy],
      );
      if (!rows[0]) throw new Error("PI_CONTEXT_SUMMARY_CREATE_FAILED");
      return summaryFromRow(rows[0]);
    });
  }

  async listSummaries(context: RequestContext, sessionId: string, branchId?: string): Promise<PiContextSummary[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>(
        `SELECT c.* FROM pi_context_summaries c JOIN pi_sessions s ON s.id=c.pi_session_id AND s.tenant_id=c.tenant_id
         WHERE c.tenant_id=$1 AND c.pi_session_id=$2 AND ($3::uuid IS NULL OR c.branch_id=$3) AND s.actor_id=$4
         ORDER BY c.source_end_sequence ASC, c.created_at ASC`,
        [context.tenantId, sessionId, branchId ?? null, context.actorId],
      );
      return rows.map(summaryFromRow);
    });
  }
}
