import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { sha256, stableJson } from "@/src/modules/pi-agent/application/manifest";
import type { PiProfileId, PiRiskLevel } from "@/src/modules/pi-agent/domain/contracts";
import type {
  PiApproval,
  PiApprovalApproverDirectory,
  PiApprovalDecision,
  PiApprovalDecisionRecord,
  PiApprovalEvent,
  PiApprovalEventSink,
  PiApprovalExecutionPermit,
  PiApprovalObjectVersionReader,
  PiApprovalObjectVersions,
  PiApprovalPolicySnapshot,
  PiApprovalStatus,
  PiApprovalStore,
} from "@/src/modules/pi-agent/domain/approval-contracts";
import { classifyUntrustedText, redactedSensitivePlaceholder } from "@/src/platform/security/data-classification";

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const RISK_RANK: Record<PiRiskLevel, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

function clone<T>(value: T): T { return structuredClone(value); }

function hasPermission(context: RequestContext, permission: string): boolean {
  const [resource, action] = permission.split(":");
  return context.permissions.some((item) => item === "*" || item === permission || item === `${resource}:*` || item === `*:${action}`);
}

function requireId(value: string, code: string): string {
  if (!ID.test(value.trim())) throw new Error(code);
  return value.trim();
}

function normalizeObjectVersions(value: PiApprovalObjectVersions): PiApprovalObjectVersions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PI_APPROVAL_OBJECT_VERSIONS_INVALID");
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error("PI_APPROVAL_OBJECT_VERSIONS_INVALID");
  const normalized: PiApprovalObjectVersions = {};
  for (const [key, version] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    requireId(key, "PI_APPROVAL_OBJECT_VERSION_KEY_INVALID");
    if ((typeof version !== "string" && typeof version !== "number") || (typeof version === "number" && !Number.isFinite(version)) || String(version).length > 200) {
      throw new Error("PI_APPROVAL_OBJECT_VERSION_INVALID");
    }
    normalized[key] = version;
  }
  return normalized;
}

function normalizeDigest(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!DIGEST.test(normalized)) throw new Error(code);
  return normalized;
}

function normalizeRisk(value: PiRiskLevel): PiRiskLevel {
  if (!/^R[0-4]$/.test(value)) throw new Error("PI_APPROVAL_RISK_INVALID");
  return value;
}

function assertApprovalStatus(status: PiApprovalStatus, expected: PiApprovalStatus): void {
  if (status !== expected) throw new Error(`PI_APPROVAL_STATE_CONFLICT:${status}`);
}

export type PiApprovalCreateInput = {
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  toolName: string;
  toolVersion: number;
  profile: PiProfileId | string;
  riskLevel: PiRiskLevel;
  preview: string;
  inputDigest: string;
  expectedObjectVersions: PiApprovalObjectVersions;
  idempotencyKey: string;
  now?: Date;
};

export type PiApprovalDecisionInput = {
  proposalHash: string;
  idempotencyKey: string;
  comment?: string;
  now?: Date;
};

export function computeProposalHash(input: {
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  toolName: string;
  toolVersion: number;
  profile: string;
  riskLevel: PiRiskLevel;
  inputDigest: string;
  expectedObjectVersions: PiApprovalObjectVersions;
  requiredApproverIds: string[];
  policySnapshot: PiApprovalPolicySnapshot;
  expiresAt: string;
}): string {
  return sha256(stableJson({
    tenantId: input.tenantId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    toolCallId: input.toolCallId ?? null,
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    profile: input.profile,
    riskLevel: input.riskLevel,
    inputDigest: input.inputDigest,
    expectedObjectVersions: normalizeObjectVersions(input.expectedObjectVersions),
    requiredApproverIds: [...new Set(input.requiredApproverIds)].sort(),
    policySnapshot: input.policySnapshot,
    expiresAt: input.expiresAt,
  }));
}

export type ApprovalPolicyResolverOptions = {
  policyVersion?: number;
  ttlMs?: Partial<Record<PiRiskLevel, number>>;
};

export class ApprovalPolicyResolver {
  private readonly policyVersion: number;
  private readonly ttlMs: Record<PiRiskLevel, number>;

  constructor(private readonly directory: PiApprovalApproverDirectory, options: ApprovalPolicyResolverOptions = {}) {
    this.policyVersion = options.policyVersion ?? 1;
    if (!Number.isInteger(this.policyVersion) || this.policyVersion < 1) throw new Error("PI_APPROVAL_POLICY_INVALID");
    this.ttlMs = {
      R0: options.ttlMs?.R0 ?? 5 * 60_000,
      R1: options.ttlMs?.R1 ?? 5 * 60_000,
      R2: options.ttlMs?.R2 ?? 10 * 60_000,
      R3: options.ttlMs?.R3 ?? 5 * 60_000,
      R4: options.ttlMs?.R4 ?? 0,
    };
    if (Object.values(this.ttlMs).some((value) => !Number.isInteger(value) || value < 0 || value > 24 * 60 * 60_000)) throw new Error("PI_APPROVAL_POLICY_INVALID");
  }

  resolve(input: { riskLevel: PiRiskLevel }): PiApprovalPolicySnapshot {
    const riskLevel = normalizeRisk(input.riskLevel);
    if (riskLevel === "R4") {
      return { policyVersion: this.policyVersion, riskLevel, mode: "all", requiredApprovalCount: 0, requiredPermission: "pi:approval:decide:r4", separationOfDuties: true, ttlMs: 0, disabled: true };
    }
    if (RISK_RANK[riskLevel] < 2) {
      return { policyVersion: this.policyVersion, riskLevel, mode: "single", requiredApprovalCount: 0, requiredPermission: "pi:approval:decide", separationOfDuties: false, ttlMs: this.ttlMs[riskLevel], disabled: false };
    }
    if (riskLevel === "R2") {
      return { policyVersion: this.policyVersion, riskLevel, mode: "single", requiredApprovalCount: 1, requiredPermission: "pi:approval:decide:r2", separationOfDuties: true, ttlMs: this.ttlMs[riskLevel], disabled: false };
    }
    return { policyVersion: this.policyVersion, riskLevel, mode: "dual", requiredApprovalCount: 2, requiredPermission: "pi:approval:decide:r3", separationOfDuties: true, ttlMs: this.ttlMs[riskLevel], disabled: false };
  }

  async selectApprovers(context: RequestContext, input: { policy: PiApprovalPolicySnapshot; requesterId: string }): Promise<string[]> {
    if (input.policy.disabled) throw new Error("PI_R4_DISABLED");
    if (input.policy.requiredApprovalCount < 1) return [];
    const candidates = [...new Set(await this.directory.listEligibleApprovers({ tenantId: context.tenantId, permission: input.policy.requiredPermission, excludeActorId: input.requesterId, traceId: context.traceId }))]
      .filter((actorId) => actorId && actorId !== input.requesterId)
      .sort();
    if (candidates.length < input.policy.requiredApprovalCount) throw new Error("PI_APPROVER_UNAVAILABLE");
    return candidates.slice(0, input.policy.requiredApprovalCount);
  }
}

export class StaticPiApprovalApproverDirectory implements PiApprovalApproverDirectory {
  constructor(private readonly actorIds: string[]) {}

  async listEligibleApprovers(input: { tenantId: string; permission: string; excludeActorId: string; traceId: string }): Promise<string[]> {
    void input;
    return [...this.actorIds];
  }
}

export class FailClosedPiApprovalApproverDirectory implements PiApprovalApproverDirectory {
  async listEligibleApprovers(): Promise<string[]> { throw new Error("PI_APPROVER_DIRECTORY_UNAVAILABLE"); }
}

export class InMemoryPiApprovalEventSink implements PiApprovalEventSink {
  readonly events: PiApprovalEvent[] = [];

  async append(event: PiApprovalEvent): Promise<void> { this.events.push(clone(event)); }
}

export class FailClosedPiApprovalEventSink implements PiApprovalEventSink {
  async append(): Promise<void> { throw new Error("PI_APPROVAL_EVENT_SINK_UNAVAILABLE"); }
}

export class StaticPiApprovalObjectVersionReader implements PiApprovalObjectVersionReader {
  constructor(private readonly versions: PiApprovalObjectVersions) {}

  async read(): Promise<PiApprovalObjectVersions> {
    return normalizeObjectVersions(this.versions);
  }
}

export class FailClosedPiApprovalObjectVersionReader implements PiApprovalObjectVersionReader {
  async read(): Promise<PiApprovalObjectVersions> { throw new Error("PI_APPROVAL_REVALIDATION_UNAVAILABLE"); }
}

export class PiApprovalService {
  constructor(
    private readonly store: PiApprovalStore,
    private readonly policy: ApprovalPolicyResolver,
    private readonly events: PiApprovalEventSink = new FailClosedPiApprovalEventSink(),
    private readonly objectVersions: PiApprovalObjectVersionReader = new FailClosedPiApprovalObjectVersionReader(),
  ) {}

  computeProposalHash(input: Parameters<typeof computeProposalHash>[0]): string { return computeProposalHash(input); }

  async createProposal(context: RequestContext, input: PiApprovalCreateInput): Promise<{ approval: PiApproval; created: boolean }> {
    assertPiPermission(context, "pi:approval:create");
    const sessionId = requireId(input.sessionId, "PI_APPROVAL_SESSION_INVALID");
    const toolName = requireId(input.toolName, "PI_APPROVAL_TOOL_INVALID");
    const profile = requireId(String(input.profile), "PI_APPROVAL_PROFILE_INVALID");
    if (!Number.isInteger(input.toolVersion) || input.toolVersion < 1) throw new Error("PI_APPROVAL_TOOL_VERSION_INVALID");
    const riskLevel = normalizeRisk(input.riskLevel);
    const inputDigest = normalizeDigest(input.inputDigest, "PI_APPROVAL_INPUT_DIGEST_INVALID");
    const idempotencyKey = requireId(input.idempotencyKey, "PI_IDEMPOTENCY_KEY_INVALID");
    const existing = await this.store.getByIdempotency(context, idempotencyKey);
    if (existing) {
      if (existing.actorId !== context.actorId || existing.inputDigest !== inputDigest || existing.toolName !== toolName || existing.riskLevel !== riskLevel) throw new Error("PI_IDEMPOTENCY_CONFLICT");
      return { approval: existing, created: false };
    }
    const policy = this.policy.resolve({ riskLevel });
    if (policy.disabled) throw new Error("PI_R4_DISABLED");
    if (policy.requiredApprovalCount < 1) throw new Error("PI_APPROVAL_NOT_REQUIRED");
    const expectedObjectVersions = normalizeObjectVersions(input.expectedObjectVersions);
    const rawPreview = String(input.preview ?? "").trim();
    if (rawPreview.length < 1 || rawPreview.length > 20_000) throw new Error("PI_APPROVAL_PREVIEW_INVALID");
    const preview = classifyUntrustedText(rawPreview) === "restricted" ? redactedSensitivePlaceholder() : rawPreview;
    const now = input.now ?? new Date();
    if (Number.isNaN(now.getTime())) throw new Error("PI_APPROVAL_TIME_INVALID");
    const expiresAt = new Date(now.getTime() + policy.ttlMs).toISOString();
    const requiredApproverIds = await this.policy.selectApprovers(context, { policy, requesterId: context.actorId });
    const approval: PiApproval = {
      id: randomUUID(),
      tenantId: context.tenantId,
      actorId: context.actorId,
      sessionId,
      ...(input.runId ? { runId: requireId(input.runId, "PI_APPROVAL_RUN_INVALID") } : {}),
      ...(input.toolCallId ? { toolCallId: requireId(input.toolCallId, "PI_APPROVAL_TOOL_CALL_INVALID") } : {}),
      toolName,
      toolVersion: input.toolVersion,
      profile,
      riskLevel,
      preview,
      inputDigest,
      expectedObjectVersions,
      proposalHash: computeProposalHash({ tenantId: context.tenantId, actorId: context.actorId, sessionId, runId: input.runId, toolCallId: input.toolCallId, toolName, toolVersion: input.toolVersion, profile, riskLevel, inputDigest, expectedObjectVersions, requiredApproverIds, policySnapshot: policy, expiresAt }),
      requiredApproverIds,
      approvalMode: policy.mode,
      requiredApprovalCount: policy.requiredApprovalCount,
      policyVersion: policy.policyVersion,
      policySnapshot: policy,
      status: "pending",
      expiresAt,
      version: 1,
      idempotencyKey,
      revalidationStatus: "not_checked",
      createdAt: now.toISOString(),
    };
    const created = await this.store.create(approval);
    if (!created.created) {
      if (created.approval.actorId !== context.actorId || created.approval.proposalHash !== approval.proposalHash) throw new Error("PI_IDEMPOTENCY_CONFLICT");
      return created;
    }
    await this.emit(context, approval, "pi.tool.requested", { toolName, riskLevel, proposalHash: approval.proposalHash });
    await this.emit(context, approval, "pi.tool.approval_required", { requiredApproverIds, requiredApprovalCount: policy.requiredApprovalCount, approvalMode: policy.mode, expiresAt });
    return created;
  }

  async selectApprovers(context: RequestContext, approvalId: string): Promise<string[]> {
    const approval = await this.requireApproval(context, approvalId);
    return this.policy.selectApprovers(context, { policy: approval.policySnapshot, requesterId: approval.actorId });
  }

  async recordDecision(context: RequestContext, approvalId: string, input: PiApprovalDecisionInput, decision: PiApprovalDecision = "approve"): Promise<{ approval: PiApproval; decision: PiApprovalDecisionRecord; created: boolean }> {
    const approval = await this.requireApproval(context, approvalId);
    const now = input.now ?? new Date();
    const proposalHash = normalizeDigest(input.proposalHash, "PI_APPROVAL_PROPOSAL_HASH_INVALID");
    const priorDecisions = await this.store.listDecisions(context, approvalId);
    const priorByIdempotency = priorDecisions.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (priorByIdempotency) {
      if (priorByIdempotency.proposalHash !== proposalHash || priorByIdempotency.decision !== decision) throw new Error("PI_IDEMPOTENCY_CONFLICT");
      return { approval, decision: priorByIdempotency, created: false };
    }
    if (approval.status === "pending" && new Date(approval.expiresAt).getTime() <= now.getTime()) {
      await this.expire(context, approvalId, now);
      throw new Error("PI_APPROVAL_EXPIRED");
    }
    assertApprovalStatus(approval.status, "pending");
    if (proposalHash !== approval.proposalHash) throw new Error("PI_APPROVAL_HASH_MISMATCH");
    requireId(input.idempotencyKey, "PI_IDEMPOTENCY_KEY_INVALID");
    if (!approval.requiredApproverIds.includes(context.actorId)) throw new Error("PI_APPROVER_FORBIDDEN");
    if (approval.policySnapshot.separationOfDuties && context.actorId === approval.actorId) throw new Error("SEPARATION_OF_DUTIES_REQUIRED");
    if (!hasPermission(context, approval.policySnapshot.requiredPermission) && !hasPermission(context, "pi:approval:decide")) throw new Error("PI_PERMISSION_DENIED");
    const comment = input.comment?.trim() ?? "";
    if (decision === "reject" && comment.length < 1) throw new Error("PI_APPROVAL_REJECTION_COMMENT_REQUIRED");
    const result = await this.store.recordDecision({ context, approvalId, actorId: context.actorId, decision, proposalHash: approval.proposalHash, idempotencyKey: input.idempotencyKey, commentDigest: comment ? sha256(comment) : undefined, now: now.toISOString() });
    if (!result.created && result.decision.decision !== decision) throw new Error("PI_IDEMPOTENCY_CONFLICT");
    if (result.created) await this.emit(context, result.approval, decision === "reject" ? "pi.tool.denied" : "pi.tool.approval_required", { decision, decisionId: result.decision.id, proposalHash: result.decision.proposalHash, status: result.approval.status });
    return result;
  }

  async reject(context: RequestContext, approvalId: string, input: PiApprovalDecisionInput): Promise<{ approval: PiApproval; decision: PiApprovalDecisionRecord; created: boolean }> {
    return this.recordDecision(context, approvalId, input, "reject");
  }

  async expire(context: RequestContext, approvalId: string, now = new Date()): Promise<PiApproval | null> {
    const approval = await this.requireApproval(context, approvalId);
    if (approval.status !== "pending" || new Date(approval.expiresAt).getTime() > now.getTime()) return approval;
    const updated = await this.store.transition({ context, approvalId, expectedStatus: "pending", nextStatus: "expired", now: now.toISOString() });
    if (updated) await this.emit(context, updated, "pi.tool.denied", { reason: "expired", proposalHash: updated.proposalHash });
    return updated ?? approval;
  }

  async cancel(context: RequestContext, approvalId: string, now = new Date()): Promise<PiApproval> {
    const approval = await this.requireApproval(context, approvalId);
    if (context.actorId !== approval.actorId && !hasPermission(context, "pi:approval:cancel") && !hasPermission(context, "pi:approval:admin")) throw new Error("PI_APPROVAL_CANCEL_FORBIDDEN");
    if (approval.status !== "pending") return approval;
    const updated = await this.store.transition({ context, approvalId, expectedStatus: "pending", nextStatus: "cancelled", now: now.toISOString(), patch: { cancelledBy: context.actorId, cancelledAt: now.toISOString() } });
    if (!updated) throw new Error("PI_APPROVAL_STATE_CONFLICT");
    await this.emit(context, updated, "pi.tool.denied", { reason: "cancelled", proposalHash: updated.proposalHash });
    return updated;
  }

  async revalidate(context: RequestContext, approvalId: string, now = new Date(), objectVersions: PiApprovalObjectVersionReader = this.objectVersions): Promise<{ valid: boolean; approval: PiApproval; reason?: string }> {
    let approval = await this.requireApproval(context, approvalId);
    if (approval.status !== "approved") throw new Error(`PI_APPROVAL_NOT_APPROVED:${approval.status}`);
    if (new Date(approval.expiresAt).getTime() <= now.getTime()) {
      const expired = await this.store.transition({ context, approvalId, expectedStatus: "approved", nextStatus: "expired", now: now.toISOString(), patch: { revalidationStatus: "failed", revalidatedAt: now.toISOString() } });
      throw new Error(expired ? "PI_APPROVAL_EXPIRED" : "PI_APPROVAL_STATE_CONFLICT");
    }
    const currentPolicy = this.policy.resolve({ riskLevel: approval.riskLevel });
    let reason: string | undefined;
    if (currentPolicy.policyVersion !== approval.policyVersion || stableJson(currentPolicy) !== stableJson(approval.policySnapshot)) reason = "PI_APPROVAL_POLICY_CHANGED";
    if (!reason) {
      const currentVersions = await objectVersions.read(context, approval);
      if (stableJson(normalizeObjectVersions(currentVersions)) !== stableJson(approval.expectedObjectVersions)) reason = "PI_APPROVAL_OBJECT_VERSION_CHANGED";
    }
    if (reason) {
      const superseded = await this.store.transition({ context, approvalId, expectedStatus: "approved", nextStatus: "superseded", now: now.toISOString(), patch: { revalidationStatus: "failed", revalidatedAt: now.toISOString(), supersedeReason: reason } });
      if (!superseded) throw new Error("PI_APPROVAL_STATE_CONFLICT");
      approval = superseded;
      await this.emit(context, approval, "pi.tool.denied", { reason, proposalHash: approval.proposalHash });
      return { valid: false, approval, reason };
    }
    const passed = await this.store.transition({ context, approvalId, expectedStatus: "approved", nextStatus: "approved", now: now.toISOString(), patch: { revalidationStatus: "passed", revalidatedAt: now.toISOString() } });
    if (!passed) throw new Error("PI_APPROVAL_STATE_CONFLICT");
    return { valid: true, approval: passed };
  }

  async resumeToolCall(context: RequestContext, approvalId: string, now = new Date(), objectVersions: PiApprovalObjectVersionReader = this.objectVersions): Promise<PiApprovalExecutionPermit> {
    const approval = await this.requireApproval(context, approvalId);
    if (context.actorId !== approval.actorId && !hasPermission(context, "pi:approval:resume")) throw new Error("PI_APPROVAL_RESUME_FORBIDDEN");
    const result = await this.revalidate(context, approvalId, now, objectVersions);
    if (!result.valid) throw new Error("PI_APPROVAL_REVALIDATION_FAILED");
    const permit: PiApprovalExecutionPermit = {
      approvalId: result.approval.id,
      tenantId: result.approval.tenantId,
      requestedBy: result.approval.actorId,
      sessionId: result.approval.sessionId,
      ...(result.approval.runId ? { runId: result.approval.runId } : {}),
      ...(result.approval.toolCallId ? { toolCallId: result.approval.toolCallId } : {}),
      toolName: result.approval.toolName,
      toolVersion: result.approval.toolVersion,
      profile: result.approval.profile,
      riskLevel: result.approval.riskLevel,
      proposalHash: result.approval.proposalHash,
      expectedObjectVersions: clone(result.approval.expectedObjectVersions),
      policyVersion: result.approval.policyVersion,
      issuedAt: now.toISOString(),
      expiresAt: result.approval.expiresAt,
    };
    await this.emit(context, result.approval, "pi.tool.started", { proposalHash: permit.proposalHash, policyVersion: permit.policyVersion });
    return permit;
  }

  async get(context: RequestContext, approvalId: string): Promise<PiApproval> { return this.requireApproval(context, approvalId); }
  async list(context: RequestContext): Promise<PiApproval[]> { assertPiPermission(context, "pi:approval:read"); return this.store.listForActor(context); }
  async decisions(context: RequestContext, approvalId: string): Promise<PiApprovalDecisionRecord[]> { await this.requireApproval(context, approvalId); return this.store.listDecisions(context, approvalId); }

  private async requireApproval(context: RequestContext, approvalId: string): Promise<PiApproval> {
    const approval = await this.store.get(context, requireId(approvalId, "PI_APPROVAL_ID_INVALID"));
    if (!approval || (approval.actorId !== context.actorId && !approval.requiredApproverIds.includes(context.actorId) && !hasPermission(context, "pi:approval:admin"))) throw new Error("PI_APPROVAL_NOT_FOUND");
    return approval;
  }

  private async emit(context: RequestContext, approval: PiApproval, eventType: PiApprovalEvent["eventType"], payload: Record<string, unknown>): Promise<void> {
    await this.events.append({ eventType, tenantId: context.tenantId, actorId: context.actorId, sessionId: approval.sessionId, approvalId: approval.id, traceId: context.traceId, payload });
  }
}
