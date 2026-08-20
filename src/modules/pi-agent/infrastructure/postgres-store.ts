import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type { PiCheckpoint, PiSession, PiSessionEvent, PiSessionStore } from "@/src/modules/pi-agent/domain/contracts";

type PiSessionRow = Record<string, unknown>;

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
  }
  return [];
}

function sessionResourceSnapshot(row: PiSessionRow): PiSession["resourceSnapshot"] {
  const value = row.resource_snapshot as PiSession["resourceSnapshot"];
  if (!value) return undefined;
  if (value.registryVersion === "legacy" && value.skillDigests.length === 0 && value.packageDigests.length === 0 && value.extensionDigests.length === 0) return undefined;
  return value;
}

function sessionFromRow(row: PiSessionRow): PiSession {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), workspaceId: String(row.workspace_id),
    repositoryId: row.repository_id ? String(row.repository_id) : undefined, baseRef: row.base_ref ? String(row.base_ref) : undefined, baseCommit: row.base_commit ? String(row.base_commit) : undefined,
    profile: row.profile as PiSession["profile"], profileVersion: Number(row.profile_version), status: row.status as PiSession["status"],
    modelPolicy: String(row.model_policy), sandboxProfile: String(row.sandbox_profile), networkPolicy: row.network_policy as PiSession["networkPolicy"],
    policyVersion: Number(row.policy_version), skillDigests: jsonArray<string>(row.skill_digests), mcpServerDigests: jsonArray<string>(row.mcp_server_digests), mcpBindingIds: jsonArray<string>(row.mcp_binding_ids), mcpBindings: jsonArray<PiSession["mcpBindings"][number]>(row.mcp_bindings), resourceSnapshot: sessionResourceSnapshot(row),
    sandboxRunId: String(row.sandbox_run_id), traceId: String(row.trace_id), lastEventSequence: Number(row.last_event_sequence),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function eventFromRow(row: PiSessionRow): PiSessionEvent {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), sessionId: String(row.pi_session_id), branchId: row.branch_id ? String(row.branch_id) : undefined, sequence: Number(row.sequence),
    type: String(row.event_type), payload: row.payload, traceId: String(row.trace_id), createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function checkpointFromRow(row: PiSessionRow): PiCheckpoint {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), sessionId: String(row.pi_session_id), label: String(row.label),
    gitCommitSha: row.git_commit_sha ? String(row.git_commit_sha) : undefined, diffDigest: String(row.diff_digest), snapshot: row.snapshot,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export class PostgresPiSessionStore implements PiSessionStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.database.withTenant(context.tenantId, work);
  }

  async createSession(session: PiSession): Promise<void> {
    await this.scoped({ tenantId: session.tenantId, actorId: session.actorId, sessionId: "system", channel: "system", traceId: session.traceId, roles: [], permissions: [], dataScopes: [] }, async (db) => {
      await db.query(
        `INSERT INTO pi_sessions
          (id, tenant_id, actor_id, workspace_id, repository_id, base_ref, base_commit, profile, profile_version, status, model_policy,
           sandbox_profile, network_policy, policy_version, skill_digests, mcp_server_digests, resource_snapshot, mcp_binding_ids, mcp_bindings, sandbox_run_id, trace_id, last_event_sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,0)`,
        [session.id, session.tenantId, session.actorId, session.workspaceId, session.repositoryId ?? null, session.baseRef ?? "HEAD", session.baseCommit ?? null, session.profile,
          session.profileVersion, session.status, session.modelPolicy, session.sandboxProfile, session.networkPolicy, session.policyVersion,
          session.skillDigests, session.mcpServerDigests, session.resourceSnapshot ?? { schemaVersion: 1, skillDigests: [], packageDigests: [], extensionDigests: [], policyVersion: 1, registryVersion: "legacy", resolvedAt: session.createdAt }, session.mcpBindingIds, session.mcpBindings, session.sandboxRunId, session.traceId],
      );
    });
  }

  async getSession(context: RequestContext, sessionId: string): Promise<PiSession | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<PiSessionRow>("SELECT * FROM pi_sessions WHERE tenant_id=$1 AND id=$2 AND actor_id=$3", [context.tenantId, sessionId, context.actorId]);
      return rows[0] ? sessionFromRow(rows[0]) : null;
    });
  }

  async listSessions(context: RequestContext): Promise<PiSession[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<PiSessionRow>("SELECT * FROM pi_sessions WHERE tenant_id=$1 AND actor_id=$2 ORDER BY created_at DESC", [context.tenantId, context.actorId]);
      return rows.map(sessionFromRow);
    });
  }

  async updateSession(context: RequestContext, sessionId: string, patch: Partial<Pick<PiSession, "status" | "lastEventSequence" | "updatedAt">>): Promise<PiSession> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<PiSessionRow>(
        `UPDATE pi_sessions SET status=COALESCE($3,status), last_event_sequence=COALESCE($4,last_event_sequence), updated_at=COALESCE($5,now())
         WHERE tenant_id=$1 AND id=$2 AND actor_id=$6 RETURNING *`,
        [context.tenantId, sessionId, patch.status ?? null, patch.lastEventSequence ?? null, patch.updatedAt ? new Date(patch.updatedAt) : null, context.actorId],
      );
      if (!rows[0]) throw new Error("PI_SESSION_NOT_FOUND");
      return sessionFromRow(rows[0]);
    });
  }

  async appendEvent(context: RequestContext, sessionId: string, event: Omit<PiSessionEvent, "id" | "sequence" | "createdAt" | "tenantId" | "sessionId">): Promise<PiSessionEvent> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<PiSessionRow>(
        `WITH locked AS (SELECT id FROM pi_sessions WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 FOR UPDATE),
         next_event AS (SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM pi_session_events WHERE tenant_id=$1 AND pi_session_id=$2)
         INSERT INTO pi_session_events (id, tenant_id, pi_session_id, branch_id, sequence, event_type, payload, trace_id)
         SELECT $4,$1,$2,$8,next_event.sequence,$5,$6,$7 FROM locked,next_event RETURNING *`,
        [context.tenantId, sessionId, context.actorId, randomUUID(), event.type, JSON.stringify(event.payload), event.traceId, event.branchId ?? null],
      );
      if (!rows[0]) throw new Error("PI_SESSION_NOT_FOUND");
      await db.query("UPDATE pi_sessions SET last_event_sequence=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, sessionId, Number(rows[0].sequence)]);
      return eventFromRow(rows[0]);
    });
  }

  async getEvents(context: RequestContext, sessionId: string, afterSequence: number, limit: number): Promise<PiSessionEvent[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<PiSessionRow>(
        "SELECT * FROM pi_session_events WHERE tenant_id=$1 AND pi_session_id=$2 AND sequence>$3 ORDER BY sequence ASC LIMIT $4",
        [context.tenantId, sessionId, Math.max(afterSequence, 0), Math.min(Math.max(limit, 1), 500)],
      );
      return rows.map(eventFromRow);
    });
  }

  async createCheckpoint(context: RequestContext, checkpoint: PiCheckpoint): Promise<void> {
    await this.scoped(context, async (db) => {
      await db.query(
        "INSERT INTO pi_checkpoints (id,tenant_id,pi_session_id,label,git_commit_sha,diff_digest,snapshot) SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS (SELECT 1 FROM pi_sessions WHERE tenant_id=$2 AND id=$3 AND actor_id=$8)",
        [checkpoint.id, context.tenantId, checkpoint.sessionId, checkpoint.label, checkpoint.gitCommitSha ?? null, checkpoint.diffDigest, JSON.stringify(checkpoint.snapshot), context.actorId],
      );
    });
  }

  async listCheckpoints(context: RequestContext, sessionId: string): Promise<PiCheckpoint[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<PiSessionRow>("SELECT c.* FROM pi_checkpoints c JOIN pi_sessions s ON s.id=c.pi_session_id AND s.tenant_id=c.tenant_id WHERE c.tenant_id=$1 AND c.pi_session_id=$2 AND s.actor_id=$3 ORDER BY c.created_at DESC", [context.tenantId, sessionId, context.actorId]);
      return rows.map(checkpointFromRow);
    });
  }
}
