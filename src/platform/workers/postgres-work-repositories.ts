import { randomUUID } from "node:crypto";
import { unifiedEventSchema } from "@/src/modules/events/domain/event-envelope";
import type { SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import type {
  AgentToolJobInput,
  AgentToolJobLease,
  InboxLease,
  LeaseRequest,
  OutboxLease,
  RetryDisposition,
  WorkerRole,
  WorkFailure,
} from "@/src/platform/workers/contracts";

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function jsonValue(value: Record<string, unknown>): SqlPrimitive {
  return value;
}

function leaseWindow(request: LeaseRequest): { now: Date; expiresAt: Date; token: string } {
  if (!Number.isFinite(request.leaseMs) || request.leaseMs <= 0) throw new Error("LEASE_DURATION_INVALID");
  const now = request.now ?? new Date();
  return { now, expiresAt: new Date(now.getTime() + request.leaseMs), token: randomUUID() };
}

function tenantConcurrency(request: LeaseRequest): number {
  const limit = request.maxTenantConcurrency ?? 1;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("TENANT_CONCURRENCY_INVALID");
  return limit;
}

function mapInbox(row: Row): InboxLease {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    leaseToken: String(row.lease_token),
    leaseExpiresAt: iso(row.lease_expires_at),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    event: unifiedEventSchema.parse(row.event_envelope),
  };
}

function mapOutbox(row: Row): OutboxLease {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    leaseToken: String(row.lease_token),
    leaseExpiresAt: iso(row.lease_expires_at),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    eventType: String(row.event_type),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    aggregateVersion: Number(row.aggregate_version),
    payload: row.payload as Record<string, unknown>,
    traceId: String(row.trace_id),
    occurredAt: iso(row.occurred_at),
  };
}

function mapAgentJob(row: Row): AgentToolJobLease {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    agentRunId: String(row.agent_run_id),
    proposalId: String(row.proposal_id),
    confirmationId: String(row.confirmation_id),
    toolCallId: String(row.tool_call_id),
    actorId: String(row.actor_id),
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    channel: row.channel as AgentToolJobLease["channel"],
    ...(row.connection_id ? { connectionId: String(row.connection_id) } : {}),
    traceId: String(row.trace_id),
    toolId: String(row.tool_id),
    toolVersion: Number(row.tool_version),
    policyVersion: Number(row.policy_version),
    riskLevel: Number(row.risk_level) as AgentToolJobLease["riskLevel"],
    inputPayload: row.input_payload as Record<string, unknown>,
    inputDigest: String(row.input_digest),
    idempotencyKey: String(row.idempotency_key),
    expectedVersions: row.expected_versions as Record<string, number>,
    maxAttempts: Number(row.max_attempts),
    availableAt: iso(row.available_at),
    leaseToken: String(row.lease_token),
    leaseExpiresAt: iso(row.lease_expires_at),
    attempts: Number(row.attempts),
    status: "executing",
  };
}

export class PostgresTenantDirectory {
  constructor(private readonly database: TransactionalDatabase) {}

  async listActiveTenantIds(): Promise<string[]> {
    const rows = await this.database.query<{ id: string }>(
      "SELECT id::text FROM tenants WHERE status='active' ORDER BY id",
    );
    return rows.map(({ id }) => id);
  }
}

export class PostgresInboxWorkRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async claim(tenantId: string, request: LeaseRequest): Promise<InboxLease | null> {
    const lease = leaseWindow(request);
    const concurrency = tenantConcurrency(request);
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query(
        `WITH tenant_slot AS MATERIALIZED (
           SELECT id FROM tenants WHERE id=$1 FOR UPDATE
         ), candidate AS (
           SELECT work.id FROM inbox_events work JOIN tenant_slot ON tenant_slot.id=work.tenant_id
           WHERE work.tenant_id=$1
             AND (SELECT count(*) FROM inbox_events active WHERE active.tenant_id=$1 AND active.status='processing' AND active.lease_expires_at>$2) < $6
             AND (
             (status IN ('received','retry_scheduled') AND COALESCE(next_attempt_at,available_at) <= $2)
             OR (status='processing' AND lease_expires_at <= $2)
           )
           ORDER BY COALESCE(work.next_attempt_at,work.available_at), work.received_at, work.id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE inbox_events AS work SET
           status='processing', attempts=work.attempts+1, lease_owner=$3, lease_token=$4,
           leased_at=$2, lease_expires_at=$5, updated_at=$2
         FROM candidate WHERE work.id=candidate.id
         RETURNING work.*`,
        [tenantId, lease.now, request.workerId, lease.token, lease.expiresAt, concurrency],
      );
      return rows[0] ? mapInbox(rows[0]) : null;
    });
  }

  async renew(lease: InboxLease, workerId: string, leaseMs: number, now = new Date()): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + leaseMs);
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE inbox_events SET lease_expires_at=$5,updated_at=$4
         WHERE tenant_id=$1 AND id=$2 AND status='processing' AND lease_token=$3 AND lease_owner=$6 AND lease_expires_at>$4
         RETURNING id::text`,
        [lease.tenantId, lease.id, lease.leaseToken, now, expiresAt, workerId],
      );
      return rows.length === 1;
    });
  }

  async complete(lease: InboxLease, resultDigest?: string, now = new Date()): Promise<boolean> {
    return this.finish(lease, "processed", now, resultDigest);
  }

  async fail(lease: InboxLease, failure: WorkFailure, now = new Date()): Promise<boolean> {
    return this.finish(lease, "failed", now, undefined, failure);
  }

  async unknown(lease: InboxLease, failure: WorkFailure, now = new Date()): Promise<boolean> {
    return this.finish(lease, "unknown", now, undefined, failure);
  }

  async retry(lease: InboxLease, failure: WorkFailure, availableAt: Date, now = new Date()): Promise<RetryDisposition | null> {
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ status: RetryDisposition }>(
        `UPDATE inbox_events SET
           status=CASE WHEN attempts>=max_attempts THEN 'dead_letter' ELSE 'retry_scheduled' END,
           next_attempt_at=CASE WHEN attempts>=max_attempts THEN NULL ELSE $4::timestamptz END,
           dead_lettered_at=CASE WHEN attempts>=max_attempts THEN $5::timestamptz ELSE NULL END,
           last_error_code=$6,last_error_digest=$7,last_error_category='retryable',
           lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$5
         WHERE tenant_id=$1 AND id=$2 AND status='processing' AND lease_token=$3
         RETURNING status`,
        [lease.tenantId, lease.id, lease.leaseToken, availableAt, now, failure.code, failure.digest],
      );
      return rows[0]?.status ?? null;
    });
  }

  private async finish(
    lease: InboxLease,
    status: "processed" | "failed" | "unknown",
    now: Date,
    resultDigest?: string,
    failure?: WorkFailure,
  ): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE inbox_events SET status=$4,processed_at=CASE WHEN $4='processed' THEN $5 ELSE processed_at END,
           result_digest=$6,last_error_code=$7,last_error_digest=$8,
           last_error_category=CASE WHEN $4='failed' THEN 'non_retryable' WHEN $4='unknown' THEN 'unknown' ELSE NULL END,
           lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$5
         WHERE tenant_id=$1 AND id=$2 AND status='processing' AND lease_token=$3 RETURNING id::text`,
        [lease.tenantId, lease.id, lease.leaseToken, status, now, resultDigest ?? null, failure?.code ?? null, failure?.digest ?? null],
      );
      return rows.length === 1;
    });
  }
}

export class PostgresOutboxWorkRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async claim(tenantId: string, request: LeaseRequest): Promise<OutboxLease | null> {
    const lease = leaseWindow(request);
    const concurrency = tenantConcurrency(request);
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query(
        `WITH tenant_slot AS MATERIALIZED (
           SELECT id FROM tenants WHERE id=$1 FOR UPDATE
         ), candidate AS (
           SELECT work.id FROM outbox_events work JOIN tenant_slot ON tenant_slot.id=work.tenant_id
           WHERE work.tenant_id=$1
             AND (SELECT count(*) FROM outbox_events active WHERE active.tenant_id=$1 AND active.status='processing' AND active.lease_expires_at>$2) < $6
             AND (
             (status IN ('pending','retry_scheduled') AND available_at <= $2)
             OR (status='processing' AND lease_expires_at <= $2)
           )
           ORDER BY work.available_at,work.occurred_at,work.id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE outbox_events AS work SET
           status='processing',attempts=work.attempts+1,lease_owner=$3,lease_token=$4,
           leased_at=$2,lease_expires_at=$5,updated_at=$2
         FROM candidate WHERE work.id=candidate.id RETURNING work.*`,
        [tenantId, lease.now, request.workerId, lease.token, lease.expiresAt, concurrency],
      );
      return rows[0] ? mapOutbox(rows[0]) : null;
    });
  }

  async publish(lease: OutboxLease, publisherInstanceId: string, now = new Date()): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (executor) => {
      await executor.query(
        `INSERT INTO domain_event_publications(
           id,tenant_id,outbox_event_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload,trace_id,publisher_instance_id,published_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(tenant_id,outbox_event_id) DO NOTHING`,
        [randomUUID(), lease.tenantId, lease.id, lease.eventType, lease.aggregateType, lease.aggregateId, lease.aggregateVersion, jsonValue(lease.payload), lease.traceId, publisherInstanceId, now],
      );
      const rows = await executor.query<{ id: string }>(
        `UPDATE outbox_events SET status='published',published_at=COALESCE(published_at,$4),result_digest=$5,
           last_error_code=NULL,last_error_digest=NULL,last_error_category=NULL,
           lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$4
         WHERE tenant_id=$1 AND id=$2 AND status='processing' AND lease_token=$3 RETURNING id::text`,
        [lease.tenantId, lease.id, lease.leaseToken, now, lease.id],
      );
      if (rows.length !== 1) throw new Error("OUTBOX_LEASE_LOST");
      return true;
    });
  }

  async renew(lease: OutboxLease, workerId: string, leaseMs: number, now = new Date()): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + leaseMs);
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE outbox_events SET lease_expires_at=$5,updated_at=$4
         WHERE tenant_id=$1 AND id=$2 AND status='processing' AND lease_token=$3 AND lease_owner=$6 AND lease_expires_at>$4
         RETURNING id::text`,
        [lease.tenantId, lease.id, lease.leaseToken, now, expiresAt, workerId],
      );
      return rows.length === 1;
    });
  }

  async retry(lease: OutboxLease, failure: WorkFailure, availableAt: Date, now = new Date()): Promise<RetryDisposition | null> {
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ status: RetryDisposition }>(
        `UPDATE outbox_events SET
           status=CASE WHEN attempts>=max_attempts THEN 'dead_letter' ELSE 'retry_scheduled' END,
           available_at=CASE WHEN attempts>=max_attempts THEN available_at ELSE $4::timestamptz END,
           dead_lettered_at=CASE WHEN attempts>=max_attempts THEN $5::timestamptz ELSE NULL END,
           last_error_code=$6,last_error_digest=$7,last_error_category='retryable',
           lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$5
         WHERE tenant_id=$1 AND id=$2 AND status='processing' AND lease_token=$3 RETURNING status`,
        [lease.tenantId, lease.id, lease.leaseToken, availableAt, now, failure.code, failure.digest],
      );
      return rows[0]?.status ?? null;
    });
  }

  async fail(lease: OutboxLease, failure: WorkFailure, status: "failed" | "unknown" = "failed", now = new Date()): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE outbox_events SET status=$4,last_error_code=$5,last_error_digest=$6,
           last_error_category=CASE WHEN $4='unknown' THEN 'unknown' ELSE 'non_retryable' END,
           lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$7
         WHERE tenant_id=$1 AND id=$2 AND status='processing' AND lease_token=$3 RETURNING id::text`,
        [lease.tenantId, lease.id, lease.leaseToken, status, failure.code, failure.digest, now],
      );
      return rows.length === 1;
    });
  }
}

export class PostgresAgentJobRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async enqueue(job: AgentToolJobInput): Promise<{ id: string; created: boolean }> {
    return this.database.withTenant(job.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `INSERT INTO agent_tool_jobs(
           id,tenant_id,agent_run_id,proposal_id,confirmation_id,tool_call_id,actor_id,session_id,channel,connection_id,trace_id,
           tool_id,tool_version,policy_version,risk_level,input_payload,input_digest,idempotency_key,expected_versions,status,max_attempts,available_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'queued',$20,$21)
         ON CONFLICT(tenant_id,proposal_id) DO NOTHING RETURNING id::text`,
        [job.id,job.tenantId,job.agentRunId,job.proposalId,job.confirmationId,job.toolCallId,job.actorId,job.sessionId ?? null,job.channel,job.connectionId ?? null,job.traceId,job.toolId,job.toolVersion,job.policyVersion,job.riskLevel,jsonValue(job.inputPayload),job.inputDigest,job.idempotencyKey,jsonValue(job.expectedVersions),job.maxAttempts,job.availableAt ?? new Date().toISOString()],
      );
      if (rows[0]) return { id: rows[0].id, created: true };
      const existing = await executor.query<{ id: string }>(
        "SELECT id::text FROM agent_tool_jobs WHERE tenant_id=$1 AND proposal_id=$2",
        [job.tenantId, job.proposalId],
      );
      if (!existing[0]) throw new Error("AGENT_JOB_IDEMPOTENCY_CONFLICT");
      return { id: existing[0].id, created: false };
    });
  }

  async claim(tenantId: string, request: LeaseRequest): Promise<AgentToolJobLease | null> {
    const lease = leaseWindow(request);
    const concurrency = tenantConcurrency(request);
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query(
        `WITH tenant_slot AS MATERIALIZED (
           SELECT id FROM tenants WHERE id=$1 FOR UPDATE
         ), candidate AS (
           SELECT work.id FROM agent_tool_jobs work JOIN tenant_slot ON tenant_slot.id=work.tenant_id
           WHERE work.tenant_id=$1
             AND (SELECT count(*) FROM agent_tool_jobs active WHERE active.tenant_id=$1 AND active.status='executing' AND active.lease_expires_at>$2) < $6
             AND (
             (status IN ('queued','retry_scheduled') AND available_at <= $2)
             OR (status='executing' AND lease_expires_at <= $2)
           )
           ORDER BY work.available_at,work.created_at,work.id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE agent_tool_jobs AS work SET status='executing',attempts=work.attempts+1,
           lease_owner=$3,lease_token=$4,leased_at=$2,lease_expires_at=$5,
           started_at=COALESCE(started_at,$2),updated_at=$2
         FROM candidate WHERE work.id=candidate.id RETURNING work.*`,
        [tenantId, lease.now, request.workerId, lease.token, lease.expiresAt, concurrency],
      );
      if (!rows[0]) return null;
      const job = mapAgentJob(rows[0]);
      await executor.query(
        "UPDATE tool_calls SET status='executing',started_at=COALESCE(started_at,$3),completed_at=NULL WHERE tenant_id=$1 AND id=$2",
        [tenantId,job.toolCallId,lease.now],
      );
      await executor.query("UPDATE agent_proposals SET status='executing' WHERE tenant_id=$1 AND id=$2", [tenantId,job.proposalId]);
      await executor.query("UPDATE agent_runs SET status='executing',completed_at=NULL WHERE tenant_id=$1 AND id=$2", [tenantId,job.agentRunId]);
      return job;
    });
  }

  async renew(lease: AgentToolJobLease, workerId: string, leaseMs: number, now = new Date()): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + leaseMs);
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE agent_tool_jobs SET lease_expires_at=$5,updated_at=$4
         WHERE tenant_id=$1 AND id=$2 AND status='executing' AND lease_token=$3 AND lease_owner=$6 AND lease_expires_at>$4
         RETURNING id::text`,
        [lease.tenantId, lease.id, lease.leaseToken, now, expiresAt, workerId],
      );
      return rows.length === 1;
    });
  }

  async succeed(lease: AgentToolJobLease, result: Record<string, unknown>, resultDigest: string, now = new Date()): Promise<boolean> {
    return this.finish(lease, "succeeded", now, result, resultDigest);
  }

  async fail(lease: AgentToolJobLease, failure: WorkFailure, now = new Date()): Promise<boolean> {
    return this.finish(lease, "failed", now, undefined, undefined, failure);
  }

  async unknown(lease: AgentToolJobLease, failure: WorkFailure, reason: string, now = new Date()): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE agent_tool_jobs SET status='unknown',unknown_reason=$4,last_error_code=$5,last_error_digest=$6,
           lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,completed_at=$7,updated_at=$7
         WHERE tenant_id=$1 AND id=$2 AND status='executing' AND lease_token=$3 RETURNING id::text`,
        [lease.tenantId, lease.id, lease.leaseToken, reason, failure.code, failure.digest, now],
      );
      if (rows.length !== 1) return false;
      await executor.query("UPDATE tool_calls SET status='unknown',error_category=$3,completed_at=$4 WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.toolCallId,failure.code,now]);
      await executor.query("UPDATE agent_proposals SET status='unknown' WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.proposalId]);
      await executor.query(
        `UPDATE agent_runs SET status='unknown',failure_category=$3,completed_at=$4,
           output_payload=COALESCE(output_payload,'{}'::jsonb) || $5::jsonb WHERE tenant_id=$1 AND id=$2`,
        [lease.tenantId,lease.agentRunId,failure.code,now,{ kind: "task_status", content: "执行结果暂时无法确认，已停止自动重试并等待人工核对。", proposalId: lease.proposalId }],
      );
      return true;
    });
  }

  async retry(lease: AgentToolJobLease, failure: WorkFailure, availableAt: Date, now = new Date()): Promise<RetryDisposition | null> {
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ status: RetryDisposition }>(
        `UPDATE agent_tool_jobs SET
           status=CASE WHEN attempts>=max_attempts THEN 'dead_letter' ELSE 'retry_scheduled' END,
           available_at=CASE WHEN attempts>=max_attempts THEN available_at ELSE $4::timestamptz END,
           dead_lettered_at=CASE WHEN attempts>=max_attempts THEN $5::timestamptz ELSE NULL END,
           completed_at=CASE WHEN attempts>=max_attempts THEN $5::timestamptz ELSE NULL END,
           last_error_code=$6,last_error_digest=$7,
           lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=$5
         WHERE tenant_id=$1 AND id=$2 AND status='executing' AND lease_token=$3 RETURNING status`,
        [lease.tenantId, lease.id, lease.leaseToken, availableAt, now, failure.code, failure.digest],
      );
      const status = rows[0]?.status ?? null;
      if (!status) return null;
      const queued = status === "retry_scheduled";
      await executor.query("UPDATE tool_calls SET status=$3,error_category=$4,completed_at=CASE WHEN $3='dead_letter' THEN $5::timestamptz ELSE NULL END WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.toolCallId,queued ? "queued" : "dead_letter",failure.code,now]);
      await executor.query("UPDATE agent_proposals SET status=$3 WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.proposalId,queued ? "queued" : "failed"]);
      await executor.query("UPDATE agent_runs SET status=$3,failure_category=$4,completed_at=CASE WHEN $3='failed' THEN $5::timestamptz ELSE NULL END WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.agentRunId,queued ? "queued" : "failed",failure.code,now]);
      return status;
    });
  }

  private async finish(
    lease: AgentToolJobLease,
    status: "succeeded" | "failed",
    now: Date,
    result?: Record<string, unknown>,
    resultDigest?: string,
    failure?: WorkFailure,
  ): Promise<boolean> {
    return this.database.withTenant(lease.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE agent_tool_jobs SET status=$4,result_payload=$5,result_digest=$6,last_error_code=$7,last_error_digest=$8,
           lease_owner=NULL,lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,completed_at=$9,updated_at=$9
         WHERE tenant_id=$1 AND id=$2 AND status='executing' AND lease_token=$3 RETURNING id::text`,
        [lease.tenantId, lease.id, lease.leaseToken, status, result ? jsonValue(result) : null, resultDigest ?? null, failure?.code ?? null, failure?.digest ?? null, now],
      );
      if (rows.length !== 1) return false;
      if (status === "succeeded") {
        await executor.query("UPDATE tool_calls SET status='succeeded',output_digest=$3,error_category=NULL,completed_at=$4 WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.toolCallId,resultDigest ?? null,now]);
        await executor.query("UPDATE agent_proposals SET status='executed',result_payload=$3,executed_at=$4 WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.proposalId,result ? jsonValue(result) : null,now]);
        await executor.query(
          `UPDATE agent_runs SET status='succeeded',failure_category=NULL,completed_at=$3,
             output_payload=COALESCE(output_payload,'{}'::jsonb) || $4::jsonb WHERE tenant_id=$1 AND id=$2`,
          [lease.tenantId,lease.agentRunId,now,{ kind: "execution", content: "已按确认内容执行，结果已写入业务事实和审计链路。", proposalId: lease.proposalId }],
        );
      } else {
        await executor.query("UPDATE tool_calls SET status='failed',error_category=$3,completed_at=$4 WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.toolCallId,failure?.code ?? "TOOL_FAILED",now]);
        await executor.query("UPDATE agent_proposals SET status='failed' WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.proposalId]);
        await executor.query("UPDATE agent_runs SET status='failed',failure_category=$3,completed_at=$4 WHERE tenant_id=$1 AND id=$2", [lease.tenantId,lease.agentRunId,failure?.code ?? "TOOL_FAILED",now]);
      }
      return true;
    });
  }
}

export class PostgresWorkerHeartbeatRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async beat(input: { role: WorkerRole; instanceId: string; releaseVersion: string; capabilities: Record<string, unknown>; startedAt: Date; now?: Date; draining?: boolean }): Promise<void> {
    const now = input.now ?? new Date();
    await this.database.query(
      `INSERT INTO worker_heartbeats(role,instance_id,release_version,capabilities,started_at,last_seen_at,draining)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(role,instance_id) DO UPDATE SET release_version=EXCLUDED.release_version,capabilities=EXCLUDED.capabilities,
         last_seen_at=EXCLUDED.last_seen_at,draining=EXCLUDED.draining`,
      [input.role,input.instanceId,input.releaseVersion,jsonValue(input.capabilities),input.startedAt,now,input.draining ?? false],
    );
  }

  async freshRoles(input: { roles: WorkerRole[]; releaseVersion: string; now?: Date; maximumAgeMs: number }): Promise<WorkerRole[]> {
    const now = input.now ?? new Date();
    const threshold = new Date(now.getTime() - input.maximumAgeMs);
    const rows = await this.database.query<{ role: WorkerRole }>(
      `SELECT DISTINCT role FROM worker_heartbeats
       WHERE role = ANY($1::text[]) AND release_version=$2 AND last_seen_at>=$3 AND draining=false
       ORDER BY role`,
      [input.roles, input.releaseVersion, threshold],
    );
    return rows.map(({ role }) => role);
  }

  async remove(role: WorkerRole, instanceId: string): Promise<void> {
    await this.database.query("DELETE FROM worker_heartbeats WHERE role=$1 AND instance_id=$2", [role, instanceId]);
  }
}
