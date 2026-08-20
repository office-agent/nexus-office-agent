import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type {
  PiRunCommand,
  PiRunBacklogQuery,
  PiRunCommandStatus,
  PiRunEnqueueResult,
  PiRunFailure,
  PiRunLease,
  PiRunLeaseRequest,
  PiRunManifest,
  PiRunStatus,
  PiRunStore,
} from "@/src/modules/pi-agent/domain/contracts";
import { isPiRunStatusTransitionAllowed } from "@/src/modules/pi-agent/domain/run-state";

type Row = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function leaseWindow(request: PiRunLeaseRequest): { now: Date; expiresAt: Date; token: string; concurrency: number } {
  if (!Number.isInteger(request.leaseMs) || request.leaseMs <= 0) throw new Error("PI_RUN_LEASE_INVALID");
  const concurrency = request.maxTenantConcurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error("PI_RUN_CONCURRENCY_INVALID");
  const now = request.now ?? new Date();
  return { now, expiresAt: new Date(now.getTime() + request.leaseMs), token: randomUUID(), concurrency };
}

const DEFAULT_BACKLOG_STATUSES: PiRunCommandStatus[] = ["accepted", "queued", "leased", "cancel_requested"];

function backlogQuery(query?: PiRunBacklogQuery): { statuses: PiRunCommandStatus[]; limit: number } {
  const statuses = query?.statuses?.length ? [...new Set(query.statuses)] : DEFAULT_BACKLOG_STATUSES;
  const limit = query?.limit ?? 100;
  if (statuses.length === 0) throw new Error("PI_RUN_BACKLOG_STATUS_REQUIRED");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("PI_RUN_BACKLOG_LIMIT_INVALID");
  return { statuses, limit };
}

function commandFromRow(row: Row): PiRunCommand {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), sessionId: String(row.pi_session_id), runId: String(row.run_id),
    type: row.command_type as PiRunCommand["type"], payload: jsonValue(row.payload) as PiRunCommand["payload"], idempotencyKey: String(row.idempotency_key),
    status: row.status as PiRunCommand["status"], attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts), availableAt: iso(row.available_at),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}), ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_digest ? { lastErrorDigest: String(row.last_error_digest) } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function manifestFromRow(row: Row): PiRunManifest {
  return jsonValue(row.manifest) as PiRunManifest;
}

function toLease(command: PiRunCommand, reclaimedFromExpiredLease = false): PiRunLease {
  if (command.status !== "leased" || !command.leaseOwner || !command.leaseToken || !command.leaseExpiresAt) throw new Error("PI_RUN_LEASE_INVALID");
  return {
    ...clone(command),
    ...(reclaimedFromExpiredLease ? { reclaimedFromExpiredLease: true } : {}),
  } as PiRunLease;
}

function hasLiveLease(command: PiRunCommand | undefined, lease: PiRunLease, now: Date): boolean {
  return Boolean(
    command
      && command.status === "leased"
      && command.runId === lease.runId
      && command.leaseOwner === lease.leaseOwner
      && command.leaseToken === lease.leaseToken
      && command.leaseExpiresAt
      && new Date(command.leaseExpiresAt) > now,
  );
}

function clearLease(command: PiRunCommand, status: PiRunCommandStatus, now: Date, failure?: PiRunFailure): PiRunCommand {
  return {
    ...command,
    status,
    ...(failure ? { lastErrorCode: failure.code, lastErrorDigest: failure.digest } : {}),
    leaseOwner: undefined,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now.toISOString(),
  };
}

function isCancellationCommand(command: PiRunCommand): boolean {
  return command.type === "cancel" || command.type === "interrupt";
}

function newCancelCommand(context: RequestContext, manifest: PiRunManifest, reason: string, idempotencyKey: string, type: "cancel" | "interrupt" = "cancel"): PiRunCommand {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, sessionId: manifest.sessionId, runId: manifest.runId,
    type, payload: { reason: reason.slice(0, 500) }, idempotencyKey, status: "accepted", attempts: 0, maxAttempts: 3,
    availableAt: now, createdAt: now, updatedAt: now,
  };
}

export class InMemoryPiRunStore implements PiRunStore {
  private readonly manifests = new Map<string, PiRunManifest>();
  private readonly runStatuses = new Map<string, PiRunStatus>();
  private readonly commands = new Map<string, PiRunCommand>();
  private readonly idempotency = new Map<string, string>();

  async createRun(manifest: PiRunManifest, command: PiRunCommand): Promise<PiRunEnqueueResult> {
    if (manifest.tenantId !== command.tenantId || manifest.actorId !== command.actorId || manifest.sessionId !== command.sessionId || manifest.runId !== command.runId) {
      throw new Error("PI_RUN_CONTRACT_MISMATCH");
    }
    const idempotencyKey = `${command.tenantId}:${command.idempotencyKey}`;
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId) return { command: clone(this.commands.get(existingId)!), created: false };
    const manifestKey = `${manifest.tenantId}:${manifest.runId}`;
    if (this.manifests.has(manifestKey)) throw new Error("PI_RUN_MANIFEST_EXISTS");
    this.manifests.set(manifestKey, clone(manifest));
    this.runStatuses.set(manifestKey, "queued");
    this.commands.set(`${command.tenantId}:${command.id}`, clone(command));
    this.idempotency.set(idempotencyKey, `${command.tenantId}:${command.id}`);
    return { command: clone(command), created: true };
  }

  async createManifest(manifest: PiRunManifest): Promise<void> {
    if (this.manifests.has(`${manifest.tenantId}:${manifest.runId}`)) throw new Error("PI_RUN_MANIFEST_EXISTS");
    this.manifests.set(`${manifest.tenantId}:${manifest.runId}`, clone(manifest));
    this.runStatuses.set(`${manifest.tenantId}:${manifest.runId}`, "queued");
  }

  async getManifest(context: RequestContext, runId: string): Promise<PiRunManifest | null> {
    const value = this.manifests.get(`${context.tenantId}:${runId}`);
    return value && value.actorId === context.actorId ? clone(value) : null;
  }

  async getRunStatus(context: RequestContext, runId: string): Promise<PiRunStatus | null> {
    const key = `${context.tenantId}:${runId}`;
    const manifest = this.manifests.get(key);
    return manifest && manifest.actorId === context.actorId ? this.runStatuses.get(key) ?? null : null;
  }

  async enqueue(command: PiRunCommand): Promise<PiRunEnqueueResult> {
    const key = `${command.tenantId}:${command.idempotencyKey}`;
    const existingId = this.idempotency.get(key);
    if (existingId) return { command: clone(this.commands.get(existingId)!), created: false };
    this.commands.set(`${command.tenantId}:${command.id}`, clone(command));
    this.idempotency.set(key, `${command.tenantId}:${command.id}`);
    return { command: clone(command), created: true };
  }

  async getCommand(context: RequestContext, commandId: string): Promise<PiRunCommand | null> {
    const command = this.commands.get(`${context.tenantId}:${commandId}`);
    return command && command.actorId === context.actorId ? clone(command) : null;
  }

  async updateRunStatus(tenantId: string, runId: string, status: PiRunStatus): Promise<boolean> {
    const key = `${tenantId}:${runId}`;
    const current = this.runStatuses.get(key);
    if (!current || !isPiRunStatusTransitionAllowed(current, status)) return false;
    this.runStatuses.set(key, status);
    return true;
  }

  async updateRunStatusForLease(lease: PiRunLease, status: PiRunStatus, now = new Date()): Promise<boolean> {
    const command = this.commands.get(`${lease.tenantId}:${lease.id}`);
    if (!hasLiveLease(command, lease, now)) return false;
    return this.updateRunStatus(lease.tenantId, lease.runId, status);
  }

  async isLeaseActive(lease: PiRunLease, now = new Date()): Promise<boolean> {
    return hasLiveLease(this.commands.get(`${lease.tenantId}:${lease.id}`), lease, now);
  }

  async claim(tenantId: string, request: PiRunLeaseRequest): Promise<PiRunLease | null> {
    const { now, expiresAt, token, concurrency } = leaseWindow(request);
    const candidates = [...this.commands.values()]
      .filter((command) => command.tenantId === tenantId && (command.status === "accepted" || command.status === "queued" || (command.status === "leased" && command.leaseExpiresAt && new Date(command.leaseExpiresAt) <= now)))
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const command = candidates[0];
    if (!command || new Date(command.availableAt) > now) return null;
    const activeCount = [...this.commands.values()].filter((item) => item.tenantId === tenantId && item.status === "leased" && item.leaseExpiresAt && new Date(item.leaseExpiresAt) > now).length;
    if (activeCount >= concurrency && !isCancellationCommand(command)) return null;
    const reclaimedFromExpiredLease = command.status === "leased" && Boolean(command.leaseExpiresAt && new Date(command.leaseExpiresAt) <= now);
    const updated: PiRunCommand & { reclaimedFromExpiredLease?: boolean } = { ...command, status: "leased", attempts: command.attempts + 1, leaseOwner: request.workerId, leaseToken: token, leaseExpiresAt: expiresAt.toISOString(), updatedAt: now.toISOString(), ...(reclaimedFromExpiredLease ? { reclaimedFromExpiredLease: true } : {}) };
    this.commands.set(`${tenantId}:${command.id}`, updated);
    return toLease(updated, reclaimedFromExpiredLease);
  }

  async renew(lease: PiRunLease, workerId: string, leaseMs: number, now = new Date()): Promise<boolean> {
    const current = this.commands.get(`${lease.tenantId}:${lease.id}`);
    if (!current || !hasLiveLease(current, { ...lease, leaseOwner: workerId }, now)) return false;
    this.commands.set(`${lease.tenantId}:${lease.id}`, { ...current, leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(), updatedAt: now.toISOString() });
    return true;
  }

  async release(lease: PiRunLease, availableAt: Date, now = new Date()): Promise<boolean> {
    const current = this.commands.get(`${lease.tenantId}:${lease.id}`);
    if (!hasLiveLease(current, lease, now)) return false;
    this.commands.set(`${lease.tenantId}:${lease.id}`, { ...clearLease(current!, "queued", now), availableAt: availableAt.toISOString() });
    return true;
  }

  private async finalizeLease(lease: PiRunLease, runStatus: PiRunStatus, commandStatus: "acknowledged" | "dead_lettered", failureValue?: PiRunFailure, now = new Date()): Promise<boolean> {
    const current = this.commands.get(`${lease.tenantId}:${lease.id}`);
    if (!hasLiveLease(current, lease, now)) return false;
    const currentRunStatus = this.runStatuses.get(`${lease.tenantId}:${lease.runId}`);
    if (!currentRunStatus || !isPiRunStatusTransitionAllowed(currentRunStatus, runStatus)) return false;
    this.runStatuses.set(`${lease.tenantId}:${lease.runId}`, runStatus);
    this.commands.set(`${lease.tenantId}:${lease.id}`, clearLease(current!, commandStatus, now, failureValue));
    return true;
  }

  async complete(lease: PiRunLease, now = new Date()): Promise<boolean> {
    return this.finalizeLease(lease, "completed", "acknowledged", undefined, now);
  }

  async fail(lease: PiRunLease, failureValue: PiRunFailure, now = new Date()): Promise<boolean> {
    return this.finalizeLease(lease, "failed", "dead_lettered", failureValue, now);
  }

  async deadLetter(lease: PiRunLease, failureValue: PiRunFailure, now = new Date()): Promise<boolean> {
    return this.finalizeLease(lease, "failed", "dead_lettered", failureValue, now);
  }

  async acknowledge(lease: PiRunLease, status: "acknowledged" | "cancelled" | "unknown" | "dead_lettered", now = new Date()): Promise<boolean> {
    const current = this.commands.get(`${lease.tenantId}:${lease.id}`);
    if (!hasLiveLease(current, lease, now)) return false;
    this.commands.set(`${lease.tenantId}:${lease.id}`, clearLease(current!, status, now));
    return true;
  }

  async requeue(lease: PiRunLease, failure: PiRunFailure, availableAt: Date, now = new Date()): Promise<"queued" | "dead_lettered" | null> {
    const current = this.commands.get(`${lease.tenantId}:${lease.id}`);
    if (!hasLiveLease(current, lease, now)) return null;
    const live = current!;
    const status = live.attempts >= live.maxAttempts ? "dead_lettered" : "queued";
    this.commands.set(`${lease.tenantId}:${lease.id}`, { ...clearLease(live, status, now, failure), availableAt: status === "queued" ? availableAt.toISOString() : live.availableAt });
    return status;
  }

  async markUnknown(lease: PiRunLease, failure: PiRunFailure, now = new Date()): Promise<boolean> {
    const current = this.commands.get(`${lease.tenantId}:${lease.id}`);
    if (!hasLiveLease(current, lease, now)) return false;
    this.commands.set(`${lease.tenantId}:${lease.id}`, clearLease(current!, "unknown", now, failure));
    return true;
  }

  async requestCancel(context: RequestContext, runId: string, reason: string, idempotencyKey: string, type: "cancel" | "interrupt" = "cancel"): Promise<PiRunEnqueueResult> {
    const manifest = await this.getManifest(context, runId);
    if (!manifest) throw new Error("PI_RUN_NOT_FOUND");
    return this.enqueue(newCancelCommand(context, manifest, reason, idempotencyKey, type));
  }

  async listCommands(context: RequestContext, sessionId: string): Promise<PiRunCommand[]> {
    return [...this.commands.values()].filter((command) => command.tenantId === context.tenantId && command.actorId === context.actorId && command.sessionId === sessionId).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone);
  }

  async listBacklog(tenantId: string, query?: PiRunBacklogQuery): Promise<PiRunCommand[]> {
    const { statuses, limit } = backlogQuery(query);
    return [...this.commands.values()]
      .filter((command) => command.tenantId === tenantId && statuses.includes(command.status))
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clone);
  }
}

export class PostgresPiRunStore implements PiRunStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.database.withTenant(context.tenantId, work);
  }

  private finalizeLease(
    lease: PiRunLease,
    runStatus: PiRunStatus,
    commandStatus: "acknowledged" | "dead_lettered",
    failureValue?: PiRunFailure,
    now = new Date(),
  ): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (db) => {
      const current = await db.query<{ run_status: PiRunStatus }>(
        `SELECT manifest.run_status
         FROM pi_run_manifests AS manifest
         JOIN pi_run_commands AS command ON command.run_id=manifest.run_id AND command.tenant_id=manifest.tenant_id
         WHERE manifest.tenant_id=$1 AND manifest.run_id=$2 AND command.id=$3
           AND command.status='leased' AND command.lease_owner=$5 AND command.lease_token=$6
           AND command.lease_expires_at>$4
         FOR UPDATE OF manifest, command`,
        [lease.tenantId, lease.runId, lease.id, now, lease.leaseOwner, lease.leaseToken],
      );
      const currentStatus = current[0]?.run_status;
      if (!currentStatus || !isPiRunStatusTransitionAllowed(currentStatus, runStatus)) return false;

      const runRows = await db.query<{ run_id: string }>(
        `UPDATE pi_run_manifests
         SET run_status=$3
         WHERE tenant_id=$1 AND run_id=$2 AND run_status=$4
         RETURNING run_id::text`,
        [lease.tenantId, lease.runId, runStatus, currentStatus],
      );
      if (runRows.length !== 1) return false;

      const commandRows = await db.query<{ id: string }>(
        `UPDATE pi_run_commands
         SET status=$4,last_error_code=$5,last_error_digest=$6,
             lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$9
         WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND status='leased'
           AND lease_owner=$7 AND lease_token=$8 AND lease_expires_at>$9
         RETURNING id::text`,
        [lease.tenantId, lease.id, lease.runId, commandStatus, failureValue?.code ?? null, failureValue?.digest ?? null, lease.leaseOwner, lease.leaseToken, now],
      );
      if (commandRows.length !== 1) throw new Error("PI_RUN_TERMINAL_COMMIT_INCOMPLETE");
      return true;
    });
  }

  async createRun(manifest: PiRunManifest, command: PiRunCommand): Promise<PiRunEnqueueResult> {
    if (manifest.tenantId !== command.tenantId || manifest.actorId !== command.actorId || manifest.sessionId !== command.sessionId || manifest.runId !== command.runId) {
      throw new Error("PI_RUN_CONTRACT_MISMATCH");
    }
    return this.scoped({ tenantId: manifest.tenantId, actorId: manifest.actorId, sessionId: manifest.sessionId, channel: "system", traceId: manifest.traceId, roles: [], permissions: [], dataScopes: [] }, async (db) => {
      const existing = await db.query<Row>("SELECT * FROM pi_run_commands WHERE tenant_id=$1 AND idempotency_key=$2 AND actor_id=$3", [command.tenantId, command.idempotencyKey, command.actorId]);
      if (existing[0]) return { command: commandFromRow(existing[0]), created: false };
      const manifestRows = await db.query<Row>(
        `INSERT INTO pi_run_manifests(run_id,tenant_id,actor_id,pi_session_id,schema_version,manifest,manifest_digest,controller_signature,prompt_digest,run_status,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11) ON CONFLICT(run_id) DO NOTHING RETURNING run_id::text`,
        [manifest.runId, manifest.tenantId, manifest.actorId, manifest.sessionId, manifest.schemaVersion, manifest, manifest.manifestDigest, manifest.controllerSignature, manifest.promptDigest, new Date(manifest.createdAt), new Date(manifest.expiresAt)],
      );
      if (!manifestRows[0]) throw new Error("PI_RUN_MANIFEST_EXISTS");
      const inserted = await db.query<Row>(
        `INSERT INTO pi_run_commands(id,tenant_id,actor_id,pi_session_id,run_id,command_type,payload,idempotency_key,status,attempts,max_attempts,available_at,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'accepted',$9,$10,$11,$12,$12)
         ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING *`,
        [command.id, command.tenantId, command.actorId, command.sessionId, command.runId, command.type, command.payload, command.idempotencyKey, command.attempts, command.maxAttempts, new Date(command.availableAt), new Date(command.createdAt)],
      );
      if (inserted[0]) return { command: commandFromRow(inserted[0]), created: true };
      await db.query("DELETE FROM pi_run_manifests WHERE tenant_id=$1 AND run_id=$2", [manifest.tenantId, manifest.runId]);
      const duplicate = await db.query<Row>("SELECT * FROM pi_run_commands WHERE tenant_id=$1 AND idempotency_key=$2 AND actor_id=$3", [command.tenantId, command.idempotencyKey, command.actorId]);
      if (!duplicate[0]) throw new Error("PI_RUN_IDEMPOTENCY_CONFLICT");
      return { command: commandFromRow(duplicate[0]), created: false };
    });
  }

  async createManifest(manifest: PiRunManifest): Promise<void> {
    await this.scoped({ tenantId: manifest.tenantId, actorId: manifest.actorId, sessionId: "system", channel: "system", traceId: manifest.traceId, roles: [], permissions: [], dataScopes: [] }, async (db) => {
      await db.query(
        `INSERT INTO pi_run_manifests(run_id,tenant_id,actor_id,pi_session_id,schema_version,manifest,manifest_digest,controller_signature,prompt_digest,run_status,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11)`,
        [manifest.runId, manifest.tenantId, manifest.actorId, manifest.sessionId, manifest.schemaVersion, manifest, manifest.manifestDigest, manifest.controllerSignature, manifest.promptDigest, new Date(manifest.createdAt), new Date(manifest.expiresAt)],
      );
    });
  }

  async getManifest(context: RequestContext, runId: string): Promise<PiRunManifest | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT manifest FROM pi_run_manifests WHERE tenant_id=$1 AND run_id=$2 AND actor_id=$3", [context.tenantId, runId, context.actorId]);
      return rows[0] ? manifestFromRow(rows[0]) : null;
    });
  }

  async getRunStatus(context: RequestContext, runId: string): Promise<PiRunStatus | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<{ run_status: PiRunStatus }>("SELECT run_status FROM pi_run_manifests WHERE tenant_id=$1 AND run_id=$2 AND actor_id=$3", [context.tenantId, runId, context.actorId]);
      return rows[0]?.run_status ?? null;
    });
  }

  async enqueue(command: PiRunCommand): Promise<PiRunEnqueueResult> {
    return this.scoped({ tenantId: command.tenantId, actorId: command.actorId, sessionId: command.sessionId, channel: "system", traceId: command.runId, roles: [], permissions: [], dataScopes: [] }, async (db) => {
      const rows = await db.query<Row>(
        `INSERT INTO pi_run_commands(id,tenant_id,actor_id,pi_session_id,run_id,command_type,payload,idempotency_key,status,attempts,max_attempts,available_at,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'accepted',$9,$10,$11,$12,$12)
         ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING *`,
        [command.id, command.tenantId, command.actorId, command.sessionId, command.runId, command.type, command.payload, command.idempotencyKey, command.attempts, command.maxAttempts, new Date(command.availableAt), new Date(command.createdAt)],
      );
      if (rows[0]) return { command: commandFromRow(rows[0]), created: true };
      const existing = await db.query<Row>("SELECT * FROM pi_run_commands WHERE tenant_id=$1 AND idempotency_key=$2 AND actor_id=$3", [command.tenantId, command.idempotencyKey, command.actorId]);
      if (!existing[0]) throw new Error("PI_RUN_IDEMPOTENCY_CONFLICT");
      return { command: commandFromRow(existing[0]), created: false };
    });
  }

  async getCommand(context: RequestContext, commandId: string): Promise<PiRunCommand | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_run_commands WHERE tenant_id=$1 AND id=$2 AND actor_id=$3", [context.tenantId, commandId, context.actorId]);
      return rows[0] ? commandFromRow(rows[0]) : null;
    });
  }

  async updateRunStatus(tenantId: string, runId: string, status: PiRunStatus): Promise<boolean> {
    return this.database.withTenant(tenantId, async (db) => {
      const current = await db.query<{ run_status: PiRunStatus }>("SELECT run_status FROM pi_run_manifests WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE", [tenantId, runId]);
      if (!current[0] || !isPiRunStatusTransitionAllowed(current[0].run_status, status)) return false;
      const rows = await db.query<{ run_id: string }>("UPDATE pi_run_manifests SET run_status=$3 WHERE tenant_id=$1 AND run_id=$2 AND run_status=$4 RETURNING run_id::text", [tenantId, runId, status, current[0].run_status]);
      return rows.length === 1;
    });
  }

  async updateRunStatusForLease(lease: PiRunLease, status: PiRunStatus, now = new Date()): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (db) => {
      const current = await db.query<{ run_status: PiRunStatus }>(
        `SELECT manifest.run_status
         FROM pi_run_manifests AS manifest
         JOIN pi_run_commands AS command ON command.run_id=manifest.run_id AND command.tenant_id=manifest.tenant_id
         WHERE manifest.tenant_id=$1 AND manifest.run_id=$2 AND command.id=$3
           AND command.status='leased' AND command.lease_owner=$5 AND command.lease_token=$6
           AND command.lease_expires_at>$4
         FOR UPDATE OF manifest`,
        [lease.tenantId, lease.runId, lease.id, now, lease.leaseOwner, lease.leaseToken],
      );
      if (!current[0] || !isPiRunStatusTransitionAllowed(current[0].run_status, status)) return false;
      const rows = await db.query<{ run_id: string }>(
        `UPDATE pi_run_manifests AS manifest
         SET run_status=$4
         WHERE manifest.tenant_id=$1 AND manifest.run_id=$2
           AND manifest.run_status=$8
           AND EXISTS (
             SELECT 1 FROM pi_run_commands AS command
             WHERE command.tenant_id=$1 AND command.id=$3 AND command.run_id=manifest.run_id
               AND command.status='leased' AND command.lease_owner=$6 AND command.lease_token=$7
               AND command.lease_expires_at>$5
           )
         RETURNING manifest.run_id::text`,
        [lease.tenantId, lease.runId, lease.id, status, now, lease.leaseOwner, lease.leaseToken, current[0].run_status],
      );
      return rows.length === 1;
    });
  }

  async isLeaseActive(lease: PiRunLease, now = new Date()): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (db) => {
      const rows = await db.query<{ id: string }>(
        `SELECT id::text FROM pi_run_commands
         WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND status='leased'
           AND lease_owner=$4 AND lease_token=$5 AND lease_expires_at>$6`,
        [lease.tenantId, lease.id, lease.runId, lease.leaseOwner, lease.leaseToken, now],
      );
      return rows.length === 1;
    });
  }

  async claim(tenantId: string, request: PiRunLeaseRequest): Promise<PiRunLease | null> {
    const { now, expiresAt, token, concurrency } = leaseWindow(request);
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query<Row>(
        `WITH tenant_slot AS MATERIALIZED (SELECT id FROM tenants WHERE id=$1 FOR UPDATE), candidate AS (
           SELECT work.id, (work.status='leased' AND work.lease_expires_at <= $2) AS reclaimed_from_expired_lease
           FROM pi_run_commands work JOIN tenant_slot ON tenant_slot.id=work.tenant_id
           WHERE work.tenant_id=$1
             AND ((work.command_type IN ('cancel','interrupt')) OR (SELECT count(*) FROM pi_run_commands active WHERE active.tenant_id=$1 AND active.status='leased' AND active.lease_expires_at>$2) < $6)
             AND ((work.status IN ('accepted','queued') AND work.available_at <= $2) OR (work.status='leased' AND work.lease_expires_at <= $2))
             ORDER BY work.available_at,work.created_at,work.id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE pi_run_commands AS work SET status='leased',attempts=work.attempts+1,lease_owner=$3,lease_token=$4,leased_at=$2,lease_expires_at=$5,updated_at=$2
         FROM candidate WHERE work.id=candidate.id RETURNING work.*,candidate.reclaimed_from_expired_lease`,
        [tenantId, now, request.workerId, token, expiresAt, concurrency],
      );
      return rows[0] ? toLease(commandFromRow(rows[0]), rows[0].reclaimed_from_expired_lease === true) : null;
    });
  }

  async renew(lease: PiRunLease, workerId: string, leaseMs: number, now = new Date()): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (db) => {
      const rows = await db.query<{ id: string }>(
        "UPDATE pi_run_commands SET lease_expires_at=$6,updated_at=$5 WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND status='leased' AND lease_token=$4 AND lease_owner=$7 AND lease_expires_at>$5 RETURNING id::text",
        [lease.tenantId, lease.id, lease.runId, lease.leaseToken, now, new Date(now.getTime() + leaseMs), workerId],
      );
      return rows.length === 1;
    });
  }

  async release(lease: PiRunLease, availableAt: Date, now = new Date()): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (db) => {
      const rows = await db.query<{ id: string }>(
        `UPDATE pi_run_commands
         SET status='queued',available_at=$4,lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$7
         WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND status='leased'
           AND lease_owner=$5 AND lease_token=$6 AND lease_expires_at>$7
         RETURNING id::text`,
        [lease.tenantId, lease.id, lease.runId, availableAt, lease.leaseOwner, lease.leaseToken, now],
      );
      return rows.length === 1;
    });
  }

  async complete(lease: PiRunLease, now = new Date()): Promise<boolean> {
    return this.finalizeLease(lease, "completed", "acknowledged", undefined, now);
  }

  async fail(lease: PiRunLease, failureValue: PiRunFailure, now = new Date()): Promise<boolean> {
    return this.finalizeLease(lease, "failed", "dead_lettered", failureValue, now);
  }

  async deadLetter(lease: PiRunLease, failureValue: PiRunFailure, now = new Date()): Promise<boolean> {
    return this.finalizeLease(lease, "failed", "dead_lettered", failureValue, now);
  }

  async acknowledge(lease: PiRunLease, status: "acknowledged" | "cancelled" | "unknown" | "dead_lettered", now = new Date()): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (db) => {
      const rows = await db.query<{ id: string }>(
        "UPDATE pi_run_commands SET status=$5,lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$6 WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND status='leased' AND lease_token=$4 AND lease_expires_at>$6 RETURNING id::text",
        [lease.tenantId, lease.id, lease.runId, lease.leaseToken, status, now],
      );
      return rows.length === 1;
    });
  }

  async requeue(lease: PiRunLease, failure: PiRunFailure, availableAt: Date, now = new Date()): Promise<"queued" | "dead_lettered" | null> {
    return this.database.withTenant(lease.tenantId, async (db) => {
      const rows = await db.query<{ status: "queued" | "dead_lettered" }>(
        `UPDATE pi_run_commands SET status=CASE WHEN attempts>=max_attempts THEN 'dead_lettered' ELSE 'queued' END,
         available_at=CASE WHEN attempts>=max_attempts THEN available_at ELSE $5 END,last_error_code=$6,last_error_digest=$7,
         lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$8
         WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND status='leased' AND lease_token=$4 AND lease_expires_at>$8 RETURNING status`,
        [lease.tenantId, lease.id, lease.runId, lease.leaseToken, availableAt, failure.code, failure.digest, now],
      );
      return rows[0]?.status ?? null;
    });
  }

  async markUnknown(lease: PiRunLease, failure: PiRunFailure, now = new Date()): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (db) => {
      const rows = await db.query<{ id: string }>(
        "UPDATE pi_run_commands SET status='unknown',last_error_code=$5,last_error_digest=$6,lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$7 WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND status='leased' AND lease_token=$4 AND lease_expires_at>$7 RETURNING id::text",
        [lease.tenantId, lease.id, lease.runId, lease.leaseToken, failure.code, failure.digest, now],
      );
      return rows.length === 1;
    });
  }

  async requestCancel(context: RequestContext, runId: string, reason: string, idempotencyKey: string, type: "cancel" | "interrupt" = "cancel"): Promise<PiRunEnqueueResult> {
    const manifest = await this.getManifest(context, runId);
    if (!manifest) throw new Error("PI_RUN_NOT_FOUND");
    return this.enqueue(newCancelCommand(context, manifest, reason, idempotencyKey, type));
  }

  async listCommands(context: RequestContext, sessionId: string): Promise<PiRunCommand[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_run_commands WHERE tenant_id=$1 AND pi_session_id=$2 AND actor_id=$3 ORDER BY created_at ASC", [context.tenantId, sessionId, context.actorId]);
      return rows.map(commandFromRow);
    });
  }

  async listBacklog(tenantId: string, query?: PiRunBacklogQuery): Promise<PiRunCommand[]> {
    const { statuses, limit } = backlogQuery(query);
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query<Row>(
        `SELECT * FROM pi_run_commands
         WHERE tenant_id=$1 AND status = ANY($2::text[])
         ORDER BY available_at ASC, created_at ASC, id ASC
         LIMIT $3`,
        [tenantId, statuses, limit],
      );
      return rows.map(commandFromRow);
    });
  }
}
