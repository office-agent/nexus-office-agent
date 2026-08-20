import { resolveAgentJobTransition, type AgentJobResolutionView, type AgentStore, type AgentToolCall, type AgentToolJobView, type QueuedAgentToolJob } from "@/src/modules/agent/application/store";
import { sha256, type AgentRun, type Citation } from "@/src/modules/agent/domain/agent-run";
import type { AgentConfirmation, AgentProposal } from "@/src/modules/agent/domain/proposal";
import type { SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import type { AgentJobControlInput, AgentToolJobInput } from "@/src/platform/workers/contracts";

type Row = Record<string, unknown>;
const stringValue = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalString = (value: unknown) => value === null || value === undefined ? undefined : stringValue(value);
function sqlJson(value: unknown): SqlPrimitive {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return value as Record<string, unknown>;
  return String(value);
}

function mapRun(row: Row): AgentRun {
  const input = (row.input_payload || {}) as { message?: string; contextRefs?: string[]; sessionId?: string; autonomy?: AgentRun["autonomy"]; conversationId?: string };
  return {
    id: stringValue(row.id), tenantId: stringValue(row.tenant_id), actorId: stringValue(row.actor_id),
    sessionId: input.sessionId || "unknown", channel: row.channel as AgentRun["channel"], traceId: stringValue(row.trace_id),
    clientRequestId: optionalString(row.client_request_id), conversationId: input.conversationId, agentProfile: stringValue(row.agent_profile),
    profileVersion: Number(row.profile_version), modelPolicy: stringValue(row.model_policy), autonomy: input.autonomy || "L2",
    riskLevel: Number(row.risk_level) as AgentRun["riskLevel"], status: row.status as AgentRun["status"],
    message: input.message || "", contextRefs: input.contextRefs || [], inputDigest: stringValue(row.input_digest),
    output: (row.output_payload || undefined) as AgentRun["output"], usage: (row.usage || {}) as AgentRun["usage"],
    failureCategory: optionalString(row.failure_category), startedAt: optionalString(row.started_at),
    completedAt: optionalString(row.completed_at), createdAt: stringValue(row.created_at),
  };
}

function mapProposal(row: Row): AgentProposal {
  return {
    id: stringValue(row.id), tenantId: stringValue(row.tenant_id), agentRunId: stringValue(row.agent_run_id),
    actorId: stringValue(row.actor_id), toolId: stringValue(row.tool_id), toolVersion: Number(row.tool_version),
    riskLevel: Number(row.risk_level) as AgentProposal["riskLevel"], input: row.input_payload,
    inputDigest: stringValue(row.input_digest), preview: stringValue(row.preview),
    expectedVersions: (row.expected_versions || {}) as Record<string, number>, proposalHash: stringValue(row.proposal_hash),
    status: row.status as AgentProposal["status"], expiresAt: stringValue(row.expires_at),
    result: row.result_payload ?? undefined, createdAt: stringValue(row.created_at), executedAt: optionalString(row.executed_at),
  };
}

function mapResolution(row: Row | undefined): AgentJobResolutionView | undefined {
  if (!row) return undefined;
  return {
    requestId: stringValue(row.request_id), action: row.action as AgentJobResolutionView["action"],
    reason: stringValue(row.reason), evidenceDigest: optionalString(row.evidence_digest),
    evidenceSummary: optionalString(row.evidence_summary), resolvedBy: stringValue(row.resolved_by),
    previousStatus: row.previous_status as AgentJobResolutionView["previousStatus"],
    nextStatus: row.next_status as AgentJobResolutionView["nextStatus"], createdAt: stringValue(row.created_at),
  };
}

function mapToolJob(row: Row, resolution?: Row): AgentToolJobView {
  return {
    id: stringValue(row.id), tenantId: stringValue(row.tenant_id), proposalId: stringValue(row.proposal_id),
    agentRunId: stringValue(row.agent_run_id), actorId: stringValue(row.actor_id), status: row.status as AgentToolJobView["status"],
    attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts), result: row.result_payload ?? undefined,
    errorCode: optionalString(row.last_error_code), unknownReason: optionalString(row.unknown_reason),
    resolution: mapResolution(resolution), createdAt: stringValue(row.created_at), updatedAt: stringValue(row.updated_at),
  };
}

export class PostgresAgentStore implements AgentStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async saveRun(run: AgentRun): Promise<void> {
    await this.database.withTenant(run.tenantId, (executor) => executor.query(
      `INSERT INTO agent_runs(id,tenant_id,actor_id,channel,trace_id,agent_profile,profile_version,model_policy,risk_level,status,input_digest,output_digest,usage,started_at,completed_at,client_request_id,input_payload,output_payload,failure_category)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT(id) DO UPDATE SET risk_level=EXCLUDED.risk_level,status=EXCLUDED.status,output_digest=EXCLUDED.output_digest,usage=EXCLUDED.usage,started_at=EXCLUDED.started_at,completed_at=EXCLUDED.completed_at,output_payload=EXCLUDED.output_payload,failure_category=EXCLUDED.failure_category`,
      [run.id,run.tenantId,run.actorId,run.channel,run.traceId,run.agentProfile,run.profileVersion,run.modelPolicy,run.riskLevel,run.status,run.inputDigest,run.output ? sha256(JSON.stringify(run.output)) : null,run.usage,run.startedAt ?? null,run.completedAt ?? null,run.clientRequestId ?? null,{ message: run.message, contextRefs: run.contextRefs, sessionId: run.sessionId, autonomy: run.autonomy, conversationId: run.conversationId },run.output ?? null,run.failureCategory ?? null],
    ).then(() => undefined));
  }

  async getRun(tenantId: string, id: string): Promise<AgentRun | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapRun(rows[0]) : null;
    });
  }

  async getRunByClientRequest(tenantId: string, actorId: string, clientRequestId: string): Promise<AgentRun | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM agent_runs WHERE tenant_id=$1 AND actor_id=$2 AND client_request_id=$3", [tenantId,actorId,clientRequestId]);
      return rows[0] ? mapRun(rows[0]) : null;
    });
  }

  async saveCitations(tenantId: string, runId: string, citations: Citation[]): Promise<void> {
    await this.database.withTenant(tenantId, async (executor) => {
      await executor.query("DELETE FROM agent_citations WHERE tenant_id=$1 AND agent_run_id=$2", [tenantId,runId]);
      await executor.query("DELETE FROM agent_context_refs WHERE tenant_id=$1 AND agent_run_id=$2", [tenantId,runId]);
      for (const [ordinal, item] of citations.entries()) {
        await executor.query(
          "INSERT INTO agent_citations(id,tenant_id,agent_run_id,object_type,object_id,object_version,label,excerpt,classification,retrieved_at,ordinal) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [item.id,tenantId,runId,item.objectType,item.objectId,item.objectVersion ?? null,item.label,item.excerpt,item.classification,item.retrievedAt,ordinal],
        );
        await executor.query(
          "INSERT INTO agent_context_refs(id,tenant_id,agent_run_id,object_type,object_id,object_version,classification,excerpt_digest,retrieved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [crypto.randomUUID(),tenantId,runId,item.objectType,item.objectId,item.objectVersion ?? null,item.classification,sha256(item.excerpt),item.retrievedAt],
        );
      }
    });
  }

  async saveProposal(proposal: AgentProposal): Promise<void> {
    await this.database.withTenant(proposal.tenantId, (executor) => executor.query(
      `INSERT INTO agent_proposals(id,tenant_id,agent_run_id,actor_id,tool_id,tool_version,risk_level,input_payload,input_digest,preview,expected_versions,proposal_hash,status,expires_at,result_payload,created_at,executed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,result_payload=EXCLUDED.result_payload,executed_at=EXCLUDED.executed_at`,
      [proposal.id,proposal.tenantId,proposal.agentRunId,proposal.actorId,proposal.toolId,proposal.toolVersion,proposal.riskLevel,sqlJson(proposal.input),proposal.inputDigest,proposal.preview,proposal.expectedVersions,proposal.proposalHash,proposal.status,proposal.expiresAt,sqlJson(proposal.result),proposal.createdAt,proposal.executedAt ?? null],
    ).then(() => undefined));
  }

  async getProposal(tenantId: string, id: string): Promise<AgentProposal | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM agent_proposals WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapProposal(rows[0]) : null;
    });
  }

  async claimProposalConfirmation(proposal: AgentProposal): Promise<boolean> {
    return this.database.withTenant(proposal.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        "UPDATE agent_proposals SET status='confirmed' WHERE tenant_id=$1 AND id=$2 AND status='pending' RETURNING id::text",
        [proposal.tenantId, proposal.id],
      );
      return rows.length === 1;
    });
  }

  async saveConfirmation(confirmation: AgentConfirmation): Promise<void> {
    await this.database.withTenant(confirmation.tenantId, (executor) => executor.query(
      `INSERT INTO confirmations(id,tenant_id,agent_run_id,requested_by,proposal_hash,risk_level,status,expires_at,decided_at,decided_by,proposal_id,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(id) DO NOTHING`,
      [confirmation.id,confirmation.tenantId,confirmation.agentRunId,confirmation.requestedBy,confirmation.proposalHash,confirmation.riskLevel,confirmation.status,confirmation.expiresAt,confirmation.decidedAt ?? null,confirmation.decidedBy ?? null,confirmation.proposalId,confirmation.createdAt],
    ).then(() => undefined));
  }

  async saveToolCall(call: AgentToolCall): Promise<void> {
    await this.database.withTenant(call.tenantId, (executor) => executor.query(
      `INSERT INTO tool_calls(id,tenant_id,agent_run_id,confirmation_id,tool_id,tool_version,risk_level,idempotency_key,input_digest,output_digest,status,error_category,started_at,completed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT(id) DO UPDATE SET output_digest=EXCLUDED.output_digest,status=EXCLUDED.status,error_category=EXCLUDED.error_category,completed_at=EXCLUDED.completed_at`,
      [call.id,call.tenantId,call.agentRunId,call.confirmationId ?? null,call.toolId,call.toolVersion,call.riskLevel,call.idempotencyKey,call.inputDigest,call.outputDigest ?? null,call.status,call.errorCategory ?? null,call.startedAt ?? null,call.completedAt ?? null],
    ).then(() => undefined));
  }

  async queueConfirmedProposal(input: { proposal: AgentProposal; confirmation: AgentConfirmation; toolCall: AgentToolCall; job: AgentToolJobInput }): Promise<{ job: QueuedAgentToolJob; created: boolean }> {
    return this.database.withTenant(input.proposal.tenantId, async (executor) => {
      const claimed = await executor.query<{ id: string }>(
        "UPDATE agent_proposals SET status='queued' WHERE tenant_id=$1 AND id=$2 AND status='pending' RETURNING id::text",
        [input.proposal.tenantId, input.proposal.id],
      );
      if (claimed.length === 0) {
        const existing = await executor.query<{ id: string; status: QueuedAgentToolJob["status"] }>(
          "SELECT id::text,status FROM agent_tool_jobs WHERE tenant_id=$1 AND proposal_id=$2",
          [input.proposal.tenantId,input.proposal.id],
        );
        if (existing[0]) return { job: { id: existing[0].id, tenantId: input.proposal.tenantId, proposalId: input.proposal.id, status: existing[0].status }, created: false };
        throw new Error("PROPOSAL_CONFIRMATION_CONFLICT");
      }
      await executor.query(
        `INSERT INTO confirmations(id,tenant_id,agent_run_id,requested_by,proposal_hash,risk_level,status,expires_at,decided_at,decided_by,proposal_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [input.confirmation.id,input.confirmation.tenantId,input.confirmation.agentRunId,input.confirmation.requestedBy,input.confirmation.proposalHash,input.confirmation.riskLevel,input.confirmation.status,input.confirmation.expiresAt,input.confirmation.decidedAt ?? null,input.confirmation.decidedBy ?? null,input.confirmation.proposalId,input.confirmation.createdAt],
      );
      await executor.query(
        `INSERT INTO tool_calls(id,tenant_id,agent_run_id,confirmation_id,tool_id,tool_version,risk_level,idempotency_key,input_digest,status,started_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',NULL)`,
        [input.toolCall.id,input.toolCall.tenantId,input.toolCall.agentRunId,input.toolCall.confirmationId ?? input.confirmation.id,input.toolCall.toolId,input.toolCall.toolVersion,input.toolCall.riskLevel,input.toolCall.idempotencyKey,input.toolCall.inputDigest],
      );
      await executor.query(
        `INSERT INTO agent_tool_jobs(
           id,tenant_id,agent_run_id,proposal_id,confirmation_id,tool_call_id,actor_id,session_id,channel,connection_id,trace_id,
           tool_id,tool_version,policy_version,risk_level,input_payload,input_digest,idempotency_key,expected_versions,status,max_attempts,available_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'queued',$20,$21)`,
        [input.job.id,input.job.tenantId,input.job.agentRunId,input.job.proposalId,input.job.confirmationId,input.job.toolCallId,input.job.actorId,input.job.sessionId ?? null,input.job.channel,input.job.connectionId ?? null,input.job.traceId,input.job.toolId,input.job.toolVersion,input.job.policyVersion,input.job.riskLevel,sqlJson(input.job.inputPayload),input.job.inputDigest,input.job.idempotencyKey,sqlJson(input.job.expectedVersions),input.job.maxAttempts,input.job.availableAt ?? new Date().toISOString()],
      );
      await executor.query(
        `UPDATE agent_runs SET status='queued',output_payload=COALESCE(output_payload,'{}'::jsonb) || $3::jsonb,completed_at=NULL
         WHERE tenant_id=$1 AND id=$2`,
        [input.proposal.tenantId,input.proposal.agentRunId,{ kind: "task_status", content: "已确认，任务已进入安全执行队列。", proposalId: input.proposal.id }],
      );
      return { job: { id: input.job.id, tenantId: input.job.tenantId, proposalId: input.job.proposalId, status: "queued" }, created: true };
    });
  }

  async getToolJobByProposal(tenantId: string, proposalId: string): Promise<QueuedAgentToolJob | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<{ id: string; status: QueuedAgentToolJob["status"] }>(
        "SELECT id::text,status FROM agent_tool_jobs WHERE tenant_id=$1 AND proposal_id=$2",
        [tenantId,proposalId],
      );
      return rows[0] ? { id: rows[0].id, tenantId, proposalId, status: rows[0].status } : null;
    });
  }

  async getToolJob(tenantId: string, id: string): Promise<AgentToolJobView | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<Row>("SELECT * FROM agent_tool_jobs WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      const row = rows[0];
      if (!row) return null;
      const resolutions = await executor.query<Row>(
        "SELECT * FROM agent_job_resolutions WHERE tenant_id=$1 AND agent_tool_job_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
        [tenantId,id],
      );
      return mapToolJob(row, resolutions[0]);
    });
  }

  async controlToolJob(tenantId: string, id: string, resolvedBy: string, input: AgentJobControlInput): Promise<{ job: AgentToolJobView; created: boolean }> {
    return this.database.withTenant(tenantId, async (executor) => {
      const prior = await executor.query<Row>(
        "SELECT * FROM agent_job_resolutions WHERE tenant_id=$1 AND agent_tool_job_id=$2 AND request_id=$3",
        [tenantId,id,input.requestId],
      );
      if (prior[0]) {
        if (prior[0].action !== input.action) throw new Error("AGENT_JOB_RESOLUTION_CONFLICT");
        const repeated = await executor.query<Row>("SELECT * FROM agent_tool_jobs WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
        if (!repeated[0]) throw new Error("AGENT_JOB_NOT_FOUND");
        return { job: mapToolJob(repeated[0], prior[0]), created: false };
      }
      if (input.action !== "cancel" && !/^[0-9a-f]{64}$/.test(input.evidenceDigest ?? "")) {
        throw new Error("AGENT_JOB_EVIDENCE_REQUIRED");
      }
      const rows = await executor.query<Row>(
        "SELECT * FROM agent_tool_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId,id],
      );
      const job = rows[0];
      if (!job) throw new Error("AGENT_JOB_NOT_FOUND");
      const previousStatus = job.status as AgentToolJobView["status"];
      const nextStatus = resolveAgentJobTransition(previousStatus, input.action);
      const now = new Date();
      const resolutionId = crypto.randomUUID();
      await executor.query(
        `INSERT INTO agent_job_resolutions(
           id,tenant_id,agent_tool_job_id,request_id,resolved_by,action,previous_status,next_status,reason,evidence_digest,evidence_summary,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [resolutionId,tenantId,id,input.requestId,resolvedBy,input.action,previousStatus,nextStatus,input.reason,input.evidenceDigest ?? null,input.evidenceSummary ?? null,now],
      );
      const manualResult = input.action === "mark_succeeded"
        ? { manuallyVerified: true, evidenceDigest: input.evidenceDigest, evidenceSummary: input.evidenceSummary }
        : null;
      const updated = await executor.query<Row>(
        `UPDATE agent_tool_jobs SET
           status=$3,
           available_at=CASE WHEN $4='retry' THEN $5 ELSE available_at END,
           max_attempts=CASE WHEN $4='retry' THEN GREATEST(max_attempts,attempts+1) ELSE max_attempts END,
           result_payload=CASE WHEN $4='mark_succeeded' THEN $6::jsonb ELSE result_payload END,
           result_digest=CASE WHEN $4='mark_succeeded' THEN $7 ELSE result_digest END,
           last_error_code=CASE WHEN $4='retry' THEN NULL WHEN $4='mark_failed' THEN 'MANUALLY_VERIFIED_FAILED' ELSE last_error_code END,
           last_error_digest=CASE WHEN $4='retry' THEN NULL ELSE last_error_digest END,
           unknown_reason=CASE WHEN $4='retry' THEN NULL ELSE unknown_reason END,
           completed_at=CASE WHEN $4='retry' THEN NULL ELSE $5 END,
           dead_lettered_at=CASE WHEN $4='retry' THEN NULL ELSE dead_lettered_at END,
           updated_at=$5
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId,id,nextStatus,input.action,now,manualResult ? sqlJson(manualResult) : null,input.evidenceDigest ?? null],
      );
      const relatedStatus = input.action === "retry" ? "queued" : nextStatus;
      const completedAt = input.action === "retry" ? null : now;
      await executor.query(
        `UPDATE tool_calls SET status=$3,completed_at=$4,
           output_digest=CASE WHEN $3='succeeded' THEN $5 ELSE output_digest END,
           error_category=CASE WHEN $3='queued' THEN NULL WHEN $3='failed' THEN 'MANUALLY_VERIFIED_FAILED' ELSE error_category END
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId,stringValue(job.tool_call_id),relatedStatus,completedAt,input.evidenceDigest ?? null],
      );
      const proposalStatus = nextStatus === "succeeded" ? "executed" : nextStatus === "compensated" ? "cancelled" : relatedStatus;
      await executor.query(
        `UPDATE agent_proposals SET status=$3,
           result_payload=CASE WHEN $3='executed' THEN $4::jsonb ELSE result_payload END,
           executed_at=CASE WHEN $3='executed' THEN $5::timestamptz ELSE NULL END
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId,stringValue(job.proposal_id),proposalStatus,manualResult ? sqlJson(manualResult) : null,now],
      );
      const runStatus = nextStatus === "compensated" ? "cancelled" : relatedStatus;
      const content = input.action === "retry"
        ? "经人工核验未执行，任务已授权单次重放。"
        : input.action === "record_compensated"
          ? "原执行结果已完成补偿并由人工核验。"
          : `任务已由人工核验并处置为 ${nextStatus}。`;
      await executor.query(
        `UPDATE agent_runs SET status=$3,completed_at=$4,
           failure_category=CASE WHEN $3 IN ('queued','succeeded','cancelled') THEN NULL WHEN $3='failed' THEN 'MANUALLY_VERIFIED_FAILED' ELSE failure_category END,
           output_payload=COALESCE(output_payload,'{}'::jsonb) || $5::jsonb
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId,stringValue(job.agent_run_id),runStatus,completedAt,{ kind: "task_status", content, proposalId: stringValue(job.proposal_id) }],
      );
      return { job: mapToolJob(updated[0], {
        id: resolutionId, tenant_id: tenantId, agent_tool_job_id: id, request_id: input.requestId,
        resolved_by: resolvedBy, action: input.action, previous_status: previousStatus, next_status: nextStatus,
        reason: input.reason, evidence_digest: input.evidenceDigest ?? null, evidence_summary: input.evidenceSummary ?? null,
        created_at: now,
      }), created: true };
    });
  }
}
