export type OrganizationChangeType = "transfer" | "departure";
export type OrganizationChangeStatus = "submitted" | "approved" | "completed" | "cancelled";

export type OrganizationChangeCase = {
  id: string;
  tenantId: string;
  subjectUserId: string;
  changeType: OrganizationChangeType;
  effectiveAt: string;
  fromOrgUnitId?: string;
  toOrgUnitId?: string;
  successorUserId?: string;
  reason: string;
  status: OrganizationChangeStatus;
  requestedBy: string;
  approvedBy?: string;
  executedAt?: string;
  version: number;
};

export type HandoffResourceType = "objective" | "project" | "task" | "risk" | "issue" | "action_item" | "approval" | "responsibility";

export type WorkHandoff = {
  id: string;
  tenantId: string;
  organizationChangeId: string;
  resourceType: HandoffResourceType;
  resourceId: string;
  fromUserId: string;
  toUserId: string;
  status: "transferred" | "accepted" | "failed";
  evidenceRef: string;
  transferredAt: string;
  acceptedAt?: string;
  version: number;
};

export type ProjectBaseline = {
  name: string;
  description: string;
  businessValue: string;
  acceptanceCriteria: string;
  resourcePlan: Record<string, unknown>;
  startsAt: string;
  targetEndAt: string;
  budget?: number;
  currency?: string;
  baselineVersion: number;
  projectVersion: number;
};

export type ProjectChangeType = "scope" | "schedule" | "budget" | "resource" | "quality";
export type ProjectChangeStatus = "submitted" | "approved" | "rejected" | "applied" | "cancelled" | "compensated";

export type ProjectChangeRequest = {
  id: string;
  tenantId: string;
  projectId: string;
  changeType: ProjectChangeType;
  baselineBefore: ProjectBaseline;
  proposedBaseline: Partial<Omit<ProjectBaseline, "baselineVersion" | "projectVersion">>;
  reason: string;
  impactAssessment: string;
  requestedBy: string;
  approvedBy?: string;
  status: ProjectChangeStatus;
  appliedProjectVersion?: number;
  version: number;
};

export type UnresolvedClosureItem = {
  resourceType: "task" | "issue" | "action_item" | "risk";
  resourceId: string;
  handoffOwnerId: string;
  evidenceRef: string;
};

export type ProjectClosureReview = {
  id: string;
  tenantId: string;
  projectId: string;
  deliveryAcceptanceRef: string;
  unresolvedItems: UnresolvedClosureItem[];
  retrospectiveRef: string;
  ownerId: string;
  status: "ready" | "approved" | "completed";
  approvedBy?: string;
  completedAt?: string;
  version: number;
};

export type AttentionSource = {
  projectId: string;
  sourceType: "milestone" | "task" | "risk" | "action_item" | "budget";
  sourceId: string;
  ownerId: string;
  reasonCode: "milestone_overdue" | "milestone_at_risk" | "critical_task_blocked" | "risk_exposure" | "action_overdue" | "budget_variance";
  severity: "watch" | "at_risk" | "critical";
  details: Record<string, unknown>;
};

export type ManagementAttentionItem = AttentionSource & {
  id: string;
  tenantId: string;
  status: "open" | "acknowledged" | "resolved";
  detectedAt: string;
  resolvedAt?: string;
  dedupeKey: string;
  version: number;
};

export type CompensationPlan = {
  id: string;
  tenantId: string;
  sourceOperationType: "project_change";
  sourceOperationId: string;
  resourceType: "project";
  resourceId: string;
  inversePayload: ProjectBaseline;
  expectedResourceVersion: number;
  riskLevel: 3;
  status: "ready" | "executed" | "expired" | "failed";
  expiresAt: string;
  executedBy?: string;
  executedAt?: string;
  version: number;
};

export function approveOrganizationChange(item: OrganizationChangeCase, actorId: string, expectedVersion: number): OrganizationChangeCase {
  if (item.version !== expectedVersion) throw new Error("ORGANIZATION_CHANGE_VERSION_CONFLICT");
  if (item.status !== "submitted") throw new Error(`ORGANIZATION_CHANGE_CANNOT_APPROVE:${item.status}`);
  if (item.requestedBy === actorId) throw new Error("SEPARATION_OF_DUTIES_REQUIRED");
  return { ...item, approvedBy: actorId, status: "approved", version: item.version + 1 };
}

export function completeOrganizationChange(item: OrganizationChangeCase, now = new Date()): OrganizationChangeCase {
  if (item.status !== "approved" || !item.approvedBy) throw new Error(`ORGANIZATION_CHANGE_CANNOT_EXECUTE:${item.status}`);
  if (new Date(item.effectiveAt).getTime() > now.getTime()) throw new Error("ORGANIZATION_CHANGE_NOT_EFFECTIVE");
  return { ...item, status: "completed", executedAt: now.toISOString(), version: item.version + 1 };
}

export function approveProjectChange(item: ProjectChangeRequest, actorId: string, expectedVersion: number): ProjectChangeRequest {
  if (item.version !== expectedVersion) throw new Error("PROJECT_CHANGE_VERSION_CONFLICT");
  if (item.status !== "submitted") throw new Error(`PROJECT_CHANGE_CANNOT_APPROVE:${item.status}`);
  if (item.requestedBy === actorId) throw new Error("SEPARATION_OF_DUTIES_REQUIRED");
  return { ...item, approvedBy: actorId, status: "approved", version: item.version + 1 };
}

export function appliedBaseline(change: ProjectChangeRequest): ProjectBaseline {
  if (change.status !== "approved" || !change.approvedBy) throw new Error(`PROJECT_CHANGE_CANNOT_APPLY:${change.status}`);
  return {
    ...change.baselineBefore,
    ...change.proposedBaseline,
    baselineVersion: change.baselineBefore.baselineVersion + 1,
    projectVersion: change.baselineBefore.projectVersion + 1,
  };
}

export function validateClosureReview(review: ProjectClosureReview): void {
  if (!review.deliveryAcceptanceRef.trim()) throw new Error("PROJECT_DELIVERY_ACCEPTANCE_REQUIRED");
  if (!review.retrospectiveRef.trim()) throw new Error("PROJECT_RETROSPECTIVE_REQUIRED");
  for (const item of review.unresolvedItems) {
    if (!item.resourceId || !item.handoffOwnerId || !item.evidenceRef.trim()) throw new Error("PROJECT_UNRESOLVED_HANDOFF_REQUIRED");
  }
  const keys = review.unresolvedItems.map((item) => `${item.resourceType}:${item.resourceId}`);
  if (new Set(keys).size !== keys.length) throw new Error("PROJECT_UNRESOLVED_HANDOFF_DUPLICATE");
}

export function approveClosureReview(review: ProjectClosureReview, actorId: string, expectedVersion: number): ProjectClosureReview {
  validateClosureReview(review);
  if (review.version !== expectedVersion) throw new Error("PROJECT_CLOSURE_VERSION_CONFLICT");
  if (review.status !== "ready") throw new Error(`PROJECT_CLOSURE_CANNOT_APPROVE:${review.status}`);
  if (review.ownerId === actorId) throw new Error("SEPARATION_OF_DUTIES_REQUIRED");
  return { ...review, status: "approved", approvedBy: actorId, version: review.version + 1 };
}

export function attentionDedupeKey(source: AttentionSource): string {
  return `${source.projectId}:${source.sourceType}:${source.sourceId}:${source.reasonCode}`;
}

export function createCompensationPlan(change: ProjectChangeRequest, now = new Date()): CompensationPlan {
  if (change.status !== "applied" || !change.appliedProjectVersion) throw new Error("PROJECT_CHANGE_NOT_APPLIED");
  return {
    id: crypto.randomUUID(), tenantId: change.tenantId, sourceOperationType: "project_change", sourceOperationId: change.id,
    resourceType: "project", resourceId: change.projectId, inversePayload: change.baselineBefore,
    expectedResourceVersion: change.appliedProjectVersion, riskLevel: 3, status: "ready",
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), version: 1,
  };
}

export function executeCompensation(plan: CompensationPlan, actorId: string, expectedVersion: number, now = new Date()): CompensationPlan {
  if (plan.version !== expectedVersion) throw new Error("COMPENSATION_VERSION_CONFLICT");
  if (plan.status !== "ready") throw new Error(`COMPENSATION_CANNOT_EXECUTE:${plan.status}`);
  if (new Date(plan.expiresAt).getTime() <= now.getTime()) throw new Error("COMPENSATION_EXPIRED");
  return { ...plan, status: "executed", executedBy: actorId, executedAt: now.toISOString(), version: plan.version + 1 };
}
