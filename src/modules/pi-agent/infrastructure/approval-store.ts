import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import { sha256, stableJson } from "@/src/modules/pi-agent/application/manifest";
import type {
  PiApproval,
  PiApprovalDecisionRecord,
  PiApprovalObjectVersions,
  PiApprovalPolicySnapshot,
  PiApprovalStatus,
  PiApprovalStore,
} from "@/src/modules/pi-agent/domain/approval-contracts";

type Row = Record<string, unknown>;

function clone<T>(value: T): T { return structuredClone(value); }
function text(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function optionalText(value: unknown): string | undefined { return value === null || value === undefined ? undefined : text(value); }
function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
  }
  return {};
}
function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
  }
  return [];
}

function policyFromRow(row: Row): PiApprovalPolicySnapshot {
  const value = jsonObject(row.policy_snapshot);
  return {
    policyVersion: Number(value.policyVersion ?? value.policy_version ?? row.policy_version ?? 1),
    riskLevel: (value.riskLevel ?? value.risk_level ?? row.risk_level) as PiApprovalPolicySnapshot["riskLevel"],
    mode: (value.mode ?? row.approval_mode ?? "single") as PiApprovalPolicySnapshot["mode"],
    requiredApprovalCount: Number(value.requiredApprovalCount ?? value.required_approval_count ?? row.required_approval_count ?? 1),
    requiredPermission: String(value.requiredPermission ?? value.required_permission ?? "pi:approval:decide"),
    separationOfDuties: Boolean(value.separationOfDuties ?? value.separation_of_duties ?? true),
    ttlMs: Number(value.ttlMs ?? value.ttl_ms ?? 0),
    disabled: Boolean(value.disabled ?? false),
  };
}

function approvalFromRow(row: Row): PiApproval {
  const runId = optionalText(row.pi_run_id);
  const toolCallId = optionalText(row.tool_call_id);
  const supersededBy = optionalText(row.superseded_by);
  const cancelledBy = optionalText(row.cancelled_by);
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    actorId: text(row.requested_by),
    sessionId: text(row.pi_session_id),
    ...(runId ? { runId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    toolName: text(row.tool_name ?? "legacy"),
    toolVersion: Number(row.tool_version ?? 1),
    profile: text(row.profile ?? "legacy"),
    riskLevel: row.risk_level as PiApproval["riskLevel"],
    preview: text(row.preview),
    inputDigest: text(row.input_digest),
    expectedObjectVersions: jsonObject(row.expected_object_versions) as PiApprovalObjectVersions,
    proposalHash: text(row.proposal_hash ?? ""),
    requiredApproverIds: jsonArray<string>(row.required_approver_ids),
    approvalMode: (row.approval_mode ?? "single") as PiApproval["approvalMode"],
    requiredApprovalCount: Number(row.required_approval_count ?? 1),
    policyVersion: Number(row.policy_version ?? 1),
    policySnapshot: policyFromRow(row),
    status: row.status as PiApprovalStatus,
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    version: Number(row.version ?? 1),
    idempotencyKey: text(row.idempotency_key ?? ""),
    ...(supersededBy ? { supersededBy } : {}),
    ...(row.supersede_reason ? { supersedeReason: text(row.supersede_reason) } : {}),
    ...(row.revalidated_at ? { revalidatedAt: new Date(String(row.revalidated_at)).toISOString() } : {}),
    revalidationStatus: (row.revalidation_status ?? "not_checked") as PiApproval["revalidationStatus"],
    ...(cancelledBy ? { cancelledBy } : {}),
    ...(row.cancelled_at ? { cancelledAt: new Date(String(row.cancelled_at)).toISOString() } : {}),
    createdAt: new Date(String(row.created_at)).toISOString(),
    ...(row.decided_at ? { decidedAt: new Date(String(row.decided_at)).toISOString() } : {}),
  };
}

function decisionFromRow(row: Row): PiApprovalDecisionRecord {
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    approvalId: text(row.approval_id),
    actorId: text(row.actor_id),
    decision: row.decision as PiApprovalDecisionRecord["decision"],
    proposalHash: text(row.proposal_hash),
    idempotencyKey: text(row.idempotency_key),
    decisionDigest: text(row.decision_digest),
    ...(row.comment_digest ? { commentDigest: text(row.comment_digest) } : {}),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export class InMemoryPiApprovalStore implements PiApprovalStore {
  private readonly approvals = new Map<string, PiApproval>();
  private readonly decisions = new Map<string, PiApprovalDecisionRecord[]>();

  private key(tenantId: string, id: string): string { return `${tenantId}:${id}`; }

  async create(approval: PiApproval): Promise<{ approval: PiApproval; created: boolean }> {
    const existing = [...this.approvals.values()].find((item) => item.tenantId === approval.tenantId && item.idempotencyKey === approval.idempotencyKey);
    if (existing) return { approval: clone(existing), created: false };
    this.approvals.set(this.key(approval.tenantId, approval.id), clone(approval));
    return { approval: clone(approval), created: true };
  }

  async get(context: RequestContext, approvalId: string): Promise<PiApproval | null> {
    const value = this.approvals.get(this.key(context.tenantId, approvalId));
    return value ? clone(value) : null;
  }

  async getByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiApproval | null> {
    const value = [...this.approvals.values()].find((item) => item.tenantId === context.tenantId && item.idempotencyKey === idempotencyKey);
    return value ? clone(value) : null;
  }

  async listForActor(context: RequestContext): Promise<PiApproval[]> {
    return [...this.approvals.values()]
      .filter((item) => item.tenantId === context.tenantId && (item.actorId === context.actorId || item.requiredApproverIds.includes(context.actorId)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async listDecisions(context: RequestContext, approvalId: string): Promise<PiApprovalDecisionRecord[]> {
    return (this.decisions.get(this.key(context.tenantId, approvalId)) ?? []).map(clone);
  }

  async recordDecision(input: { context: RequestContext; approvalId: string; actorId: string; decision: PiApprovalDecisionRecord["decision"]; proposalHash: string; idempotencyKey: string; commentDigest?: string; now: string }): Promise<{ approval: PiApproval; decision: PiApprovalDecisionRecord; created: boolean }> {
    const key = this.key(input.context.tenantId, input.approvalId);
    const approval = this.approvals.get(key);
    if (!approval) throw new Error("PI_APPROVAL_NOT_FOUND");
    const decisions = this.decisions.get(key) ?? [];
    const existingByKey = decisions.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existingByKey) return { approval: clone(approval), decision: clone(existingByKey), created: false };
    if (decisions.some((item) => item.actorId === input.actorId)) throw new Error("PI_APPROVAL_DECISION_ALREADY_RECORDED");
    if (approval.status !== "pending" || approval.proposalHash !== input.proposalHash) throw new Error("PI_APPROVAL_STATE_CONFLICT");
    const decision: PiApprovalDecisionRecord = { id: randomUUID(), tenantId: input.context.tenantId, approvalId: input.approvalId, actorId: input.actorId, decision: input.decision, proposalHash: input.proposalHash, idempotencyKey: input.idempotencyKey, decisionDigest: sha256(stableJson({ approvalId: input.approvalId, actorId: input.actorId, decision: input.decision, proposalHash: input.proposalHash, idempotencyKey: input.idempotencyKey, commentDigest: input.commentDigest ?? null, createdAt: input.now })), ...(input.commentDigest ? { commentDigest: input.commentDigest } : {}), createdAt: input.now };
    const nextStatus: PiApprovalStatus = input.decision === "reject" ? "rejected" : decisions.filter((item) => item.decision === "approve").length + 1 >= approval.requiredApprovalCount ? "approved" : "pending";
    const updated = clone({ ...approval, status: nextStatus, version: approval.version + 1, ...(nextStatus !== "pending" ? { decidedAt: input.now } : {}) });
    this.approvals.set(key, updated);
    this.decisions.set(key, [...decisions, decision]);
    return { approval: clone(updated), decision: clone(decision), created: true };
  }

  async transition(input: { context: RequestContext; approvalId: string; expectedStatus: PiApprovalStatus; nextStatus: PiApprovalStatus; now: string; patch?: { revalidatedAt?: string; revalidationStatus?: PiApproval["revalidationStatus"]; supersededBy?: string; supersedeReason?: string; cancelledBy?: string; cancelledAt?: string } }): Promise<PiApproval | null> {
    const key = this.key(input.context.tenantId, input.approvalId);
    const current = this.approvals.get(key);
    if (!current || current.status !== input.expectedStatus) return null;
    const updated = clone({ ...current, status: input.nextStatus, version: current.version + 1, ...(input.nextStatus !== "pending" && !current.decidedAt ? { decidedAt: input.now } : {}), ...input.patch });
    this.approvals.set(key, updated);
    return clone(updated);
  }
}

export class PostgresPiApprovalStore implements PiApprovalStore {
  constructor(private readonly database: TransactionalDatabase) {}

  private scoped<T>(context: RequestContext, work: (db: DatabaseExecutor) => Promise<T>): Promise<T> { return this.database.withTenant(context.tenantId, work); }

  async create(approval: PiApproval): Promise<{ approval: PiApproval; created: boolean }> {
    return this.scoped({ tenantId: approval.tenantId, actorId: approval.actorId, sessionId: approval.sessionId, channel: "system", traceId: approval.id, roles: ["system"], permissions: [], dataScopes: [{ type: "tenant" }] }, async (db) => {
      const rows = await db.query<Row>(
        `INSERT INTO pi_approvals
          (id,tenant_id,pi_session_id,pi_run_id,tool_call_id,requested_by,tool_name,tool_version,profile,risk_level,preview,input_digest,expected_object_versions,proposal_hash,required_approver_ids,approval_mode,required_approval_count,policy_version,policy_snapshot,status,expires_at,version,idempotency_key,revalidation_status,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         ON CONFLICT DO NOTHING RETURNING *`,
        [approval.id, approval.tenantId, approval.sessionId, approval.runId ?? null, approval.toolCallId ?? null, approval.actorId, approval.toolName, approval.toolVersion, approval.profile, approval.riskLevel, approval.preview, approval.inputDigest, approval.expectedObjectVersions, approval.proposalHash, approval.requiredApproverIds, approval.approvalMode, approval.requiredApprovalCount, approval.policyVersion, approval.policySnapshot, approval.status, new Date(approval.expiresAt), approval.version, approval.idempotencyKey, approval.revalidationStatus, new Date(approval.createdAt)],
      );
      if (rows[0]) return { approval: approvalFromRow(rows[0]), created: true };
      const existing = await db.query<Row>("SELECT * FROM pi_approvals WHERE tenant_id=$1 AND idempotency_key=$2", [approval.tenantId, approval.idempotencyKey]);
      if (!existing[0]) throw new Error("PI_APPROVAL_CREATE_CONFLICT");
      return { approval: approvalFromRow(existing[0]), created: false };
    });
  }

  async get(context: RequestContext, approvalId: string): Promise<PiApproval | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_approvals WHERE tenant_id=$1 AND id=$2", [context.tenantId, approvalId]);
      return rows[0] ? approvalFromRow(rows[0]) : null;
    });
  }

  async getByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiApproval | null> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_approvals WHERE tenant_id=$1 AND idempotency_key=$2", [context.tenantId, idempotencyKey]);
      return rows[0] ? approvalFromRow(rows[0]) : null;
    });
  }

  async listForActor(context: RequestContext): Promise<PiApproval[]> {
    return this.scoped(context, async (db) => {
      const rows = await db.query<Row>("SELECT * FROM pi_approvals WHERE tenant_id=$1 AND (requested_by=$2 OR required_approver_ids ? $2) ORDER BY created_at DESC", [context.tenantId, context.actorId]);
      return rows.map(approvalFromRow);
    });
  }

  async listDecisions(context: RequestContext, approvalId: string): Promise<PiApprovalDecisionRecord[]> {
    return this.scoped(context, async (db) => (await db.query<Row>("SELECT * FROM pi_approval_decisions WHERE tenant_id=$1 AND approval_id=$2 ORDER BY created_at,id", [context.tenantId, approvalId])).map(decisionFromRow));
  }

  async recordDecision(input: { context: RequestContext; approvalId: string; actorId: string; decision: PiApprovalDecisionRecord["decision"]; proposalHash: string; idempotencyKey: string; commentDigest?: string; now: string }): Promise<{ approval: PiApproval; decision: PiApprovalDecisionRecord; created: boolean }> {
    return this.scoped(input.context, async (db) => {
      const currentRows = await db.query<Row>("SELECT * FROM pi_approvals WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.context.tenantId, input.approvalId]);
      if (!currentRows[0]) throw new Error("PI_APPROVAL_NOT_FOUND");
      const current = approvalFromRow(currentRows[0]);
      const existingByKey = await db.query<Row>("SELECT * FROM pi_approval_decisions WHERE tenant_id=$1 AND idempotency_key=$2", [input.context.tenantId, input.idempotencyKey]);
      if (existingByKey[0]) return { approval: current, decision: decisionFromRow(existingByKey[0]), created: false };
      const existingByActor = await db.query<Row>("SELECT * FROM pi_approval_decisions WHERE tenant_id=$1 AND approval_id=$2 AND actor_id=$3", [input.context.tenantId, input.approvalId, input.actorId]);
      if (existingByActor[0]) throw new Error("PI_APPROVAL_DECISION_ALREADY_RECORDED");
      if (current.status !== "pending" || current.proposalHash !== input.proposalHash) throw new Error("PI_APPROVAL_STATE_CONFLICT");
      const decisionId = randomUUID();
      const decisionDigest = sha256(stableJson({ approvalId: input.approvalId, actorId: input.actorId, decision: input.decision, proposalHash: input.proposalHash, idempotencyKey: input.idempotencyKey, commentDigest: input.commentDigest ?? null, createdAt: input.now }));
      const decisionRows = await db.query<Row>(
        `INSERT INTO pi_approval_decisions(id,tenant_id,approval_id,actor_id,decision,proposal_hash,idempotency_key,decision_digest,comment_digest,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
        [decisionId, input.context.tenantId, input.approvalId, input.actorId, input.decision, input.proposalHash, input.idempotencyKey, decisionDigest, input.commentDigest ?? null, new Date(input.now)],
      );
      if (!decisionRows[0]) throw new Error("PI_APPROVAL_DECISION_CONFLICT");
      const approvedRows = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_approval_decisions WHERE tenant_id=$1 AND approval_id=$2 AND decision='approve'", [input.context.tenantId, input.approvalId]);
      const approveCount = Number(approvedRows[0]?.count ?? 0);
      const nextStatus: PiApprovalStatus = input.decision === "reject" ? "rejected" : approveCount >= current.requiredApprovalCount ? "approved" : "pending";
      const updatedRows = await db.query<Row>(
        `UPDATE pi_approvals SET status=$4,version=version+1,decided_at=CASE WHEN $4 <> 'pending' THEN $5 ELSE decided_at END
         WHERE tenant_id=$1 AND id=$2 AND version=$3 AND status='pending' RETURNING *`,
        [input.context.tenantId, input.approvalId, current.version, nextStatus, new Date(input.now)],
      );
      if (!updatedRows[0]) throw new Error("PI_APPROVAL_STATE_CONFLICT");
      return { approval: approvalFromRow(updatedRows[0]), decision: decisionFromRow(decisionRows[0]), created: true };
    });
  }

  async transition(input: { context: RequestContext; approvalId: string; expectedStatus: PiApprovalStatus; nextStatus: PiApprovalStatus; now: string; patch?: { revalidatedAt?: string; revalidationStatus?: PiApproval["revalidationStatus"]; supersededBy?: string; supersedeReason?: string; cancelledBy?: string; cancelledAt?: string } }): Promise<PiApproval | null> {
    return this.scoped(input.context, async (db) => {
      const patch = input.patch ?? {};
      const rows = await db.query<Row>(
        `UPDATE pi_approvals SET status=$4,version=version+1,
          decided_at=CASE WHEN $4 <> 'pending' AND decided_at IS NULL THEN $5 ELSE decided_at END,
          revalidated_at=COALESCE($6,revalidated_at),revalidation_status=COALESCE($7,revalidation_status),
          superseded_by=COALESCE($8,superseded_by),supersede_reason=COALESCE($9,supersede_reason),
          cancelled_by=COALESCE($10,cancelled_by),cancelled_at=COALESCE($11,cancelled_at)
         WHERE tenant_id=$1 AND id=$2 AND status=$3 RETURNING *`,
        [input.context.tenantId, input.approvalId, input.expectedStatus, input.nextStatus, new Date(input.now), patch.revalidatedAt ? new Date(patch.revalidatedAt) : null, patch.revalidationStatus ?? null, patch.supersededBy ?? null, patch.supersedeReason ?? null, patch.cancelledBy ?? null, patch.cancelledAt ? new Date(patch.cancelledAt) : null],
      );
      return rows[0] ? approvalFromRow(rows[0]) : null;
    });
  }
}
