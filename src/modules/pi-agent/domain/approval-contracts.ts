import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiProfileId, PiRiskLevel } from "@/src/modules/pi-agent/domain/contracts";

export type PiApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "superseded";
export type PiApprovalDecision = "approve" | "reject";
export type PiApprovalMode = "single" | "dual" | "all";
export type PiApprovalVersion = string | number;
export type PiApprovalObjectVersions = Record<string, PiApprovalVersion>;

export type PiApprovalPolicySnapshot = {
  policyVersion: number;
  riskLevel: PiRiskLevel;
  mode: PiApprovalMode;
  requiredApprovalCount: number;
  requiredPermission: string;
  separationOfDuties: boolean;
  ttlMs: number;
  disabled: boolean;
};

export type PiApproval = {
  id: string;
  tenantId: string;
  actorId: string;
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
  proposalHash: string;
  requiredApproverIds: string[];
  approvalMode: PiApprovalMode;
  requiredApprovalCount: number;
  policyVersion: number;
  policySnapshot: PiApprovalPolicySnapshot;
  status: PiApprovalStatus;
  expiresAt: string;
  version: number;
  idempotencyKey: string;
  supersededBy?: string;
  supersedeReason?: string;
  revalidatedAt?: string;
  revalidationStatus: "not_checked" | "passed" | "failed";
  cancelledBy?: string;
  cancelledAt?: string;
  createdAt: string;
  decidedAt?: string;
};

export type PiApprovalDecisionRecord = {
  id: string;
  tenantId: string;
  approvalId: string;
  actorId: string;
  decision: PiApprovalDecision;
  proposalHash: string;
  idempotencyKey: string;
  decisionDigest: string;
  commentDigest?: string;
  createdAt: string;
};

export type PiApprovalExecutionPermit = {
  approvalId: string;
  tenantId: string;
  requestedBy: string;
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  toolName: string;
  toolVersion: number;
  profile: PiProfileId | string;
  riskLevel: PiRiskLevel;
  proposalHash: string;
  expectedObjectVersions: PiApprovalObjectVersions;
  policyVersion: number;
  issuedAt: string;
  expiresAt: string;
};

export type PiApprovalEventType =
  | "pi.tool.requested"
  | "pi.tool.approval_required"
  | "pi.tool.started"
  | "pi.tool.completed"
  | "pi.tool.denied";

export type PiApprovalEvent = {
  eventType: PiApprovalEventType;
  tenantId: string;
  actorId: string;
  sessionId: string;
  approvalId: string;
  traceId: string;
  payload: Record<string, unknown>;
};

export interface PiApprovalStore {
  create(approval: PiApproval): Promise<{ approval: PiApproval; created: boolean }>;
  get(context: RequestContext, approvalId: string): Promise<PiApproval | null>;
  getByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiApproval | null>;
  listForActor(context: RequestContext): Promise<PiApproval[]>;
  listDecisions(context: RequestContext, approvalId: string): Promise<PiApprovalDecisionRecord[]>;
  recordDecision(input: {
    context: RequestContext;
    approvalId: string;
    actorId: string;
    decision: PiApprovalDecision;
    proposalHash: string;
    idempotencyKey: string;
    commentDigest?: string;
    now: string;
  }): Promise<{ approval: PiApproval; decision: PiApprovalDecisionRecord; created: boolean }>;
  transition(input: {
    context: RequestContext;
    approvalId: string;
    expectedStatus: PiApprovalStatus;
    nextStatus: PiApprovalStatus;
    now: string;
    patch?: { revalidatedAt?: string; revalidationStatus?: "not_checked" | "passed" | "failed"; supersededBy?: string; supersedeReason?: string; cancelledBy?: string; cancelledAt?: string };
  }): Promise<PiApproval | null>;
}

export interface PiApprovalEventSink {
  append(event: PiApprovalEvent): Promise<void>;
}

export interface PiApprovalApproverDirectory {
  listEligibleApprovers(input: { tenantId: string; permission: string; excludeActorId: string; traceId: string }): Promise<string[]>;
}

export interface PiApprovalObjectVersionReader {
  read(context: RequestContext, approval: PiApproval): Promise<PiApprovalObjectVersions>;
}
