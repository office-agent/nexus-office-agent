import { randomUUID } from "node:crypto";
import { evaluateAccess, type Action } from "@/src/modules/authorization/domain/policy";
import type { EventStore } from "@/src/modules/events/application/event-store";
import { createDomainEvent } from "@/src/modules/events/domain/event-envelope";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { EnterpriseGovernanceRepository, GovernedObjectiveRecord, GovernedProjectRecord } from "@/src/modules/enterprise-governance/application/contracts";
import {
  appliedBaseline,
  approveClosureReview,
  approveOrganizationChange,
  approveProjectChange,
  attentionDedupeKey,
  completeOrganizationChange,
  createCompensationPlan,
  executeCompensation,
  validateClosureReview,
  type ManagementAttentionItem,
  type OrganizationChangeCase,
  type ProjectChangeRequest,
  type ProjectClosureReview,
} from "@/src/modules/enterprise-governance/domain/governance";

function requirePolicy(context: RequestContext, action: Action, type: string, id: string, ownerId?: string): void {
  const result = evaluateAccess({ context, action, resource: { tenantId: context.tenantId, type, id, ownerId } });
  if (!result.allowed) throw new Error(`POLICY_DENIED:${result.reason}`);
}

export class EnterpriseGovernanceService {
  constructor(private readonly repository: EnterpriseGovernanceRepository, private readonly events: EventStore) {}

  async workspace(context: RequestContext) {
    requirePolicy(context, "read", "enterprise_governance", "workspace");
    return this.repository.getWorkspace(context.tenantId);
  }

  async createInitiative(context: RequestContext, input: {
    objective: Omit<GovernedObjectiveRecord, "id" | "tenantId" | "status" | "version">;
    project: Pick<GovernedProjectRecord, "code" | "name" | "description" | "ownerId" | "businessValue" | "acceptanceCriteria" | "resourcePlan" | "priority" | "startsAt" | "targetEndAt" | "budget" | "currency">;
  }) {
    requirePolicy(context, "create", "objective", "new", input.objective.ownerId);
    requirePolicy(context, "create", "project", "new", input.project.ownerId);
    const objective: GovernedObjectiveRecord = { ...input.objective, id: randomUUID(), tenantId: context.tenantId, status: "proposed", version: 1 };
    const project: GovernedProjectRecord = {
      ...input.project, id: randomUUID(), tenantId: context.tenantId, status: "proposed", health: "unknown", baselineVersion: 1, projectVersion: 1,
    };
    if (!(await this.repository.createInitiative(objective, project))) throw new Error("PROJECT_CODE_CONFLICT");
    await this.emit(context, "initiative.proposed", "project", project.id, project.projectVersion, {
      objectiveId: objective.id, projectCode: project.code, ownerId: project.ownerId, businessValue: project.businessValue,
    });
    return { objective, project };
  }

  async createOrganizationChange(context: RequestContext, input: Omit<OrganizationChangeCase, "id" | "tenantId" | "status" | "requestedBy" | "version">) {
    requirePolicy(context, "create", "organization_change", input.subjectUserId);
    const item: OrganizationChangeCase = { ...input, id: randomUUID(), tenantId: context.tenantId, status: "submitted", requestedBy: context.actorId, version: 1 };
    if (!(await this.repository.saveOrganizationChange(item))) throw new Error("ORGANIZATION_CHANGE_VERSION_CONFLICT");
    await this.emit(context, "organization_change.submitted", "organization_change", item.id, item.version, { subjectUserId: item.subjectUserId, changeType: item.changeType });
    return item;
  }

  async approveOrganizationChange(context: RequestContext, id: string, expectedVersion: number) {
    const current = await this.repository.getOrganizationChange(context.tenantId, id);
    if (!current) throw new Error("ORGANIZATION_CHANGE_NOT_FOUND");
    requirePolicy(context, "approve", "organization_change", id);
    const approved = approveOrganizationChange(current, context.actorId, expectedVersion);
    if (!(await this.repository.saveOrganizationChange(approved, expectedVersion))) throw new Error("ORGANIZATION_CHANGE_VERSION_CONFLICT");
    await this.emit(context, "organization_change.approved", "organization_change", id, approved.version, { subjectUserId: approved.subjectUserId });
    return approved;
  }

  async executeOrganizationChange(context: RequestContext, id: string, expectedVersion: number, now = new Date()) {
    const current = await this.repository.getOrganizationChange(context.tenantId, id);
    if (!current) throw new Error("ORGANIZATION_CHANGE_NOT_FOUND");
    requirePolicy(context, "execute", "organization_change", id);
    if (current.version !== expectedVersion) throw new Error("ORGANIZATION_CHANGE_VERSION_CONFLICT");
    const completed = completeOrganizationChange(current, now);
    const handoffs = await this.repository.executeOrganizationChange(completed);
    await this.emit(context, "organization_change.completed", "organization_change", id, completed.version, { subjectUserId: completed.subjectUserId, handoffIds: handoffs.map((item) => item.id) });
    return { change: completed, handoffs };
  }

  async createProjectChange(context: RequestContext, input: Pick<ProjectChangeRequest, "projectId" | "changeType" | "proposedBaseline" | "reason" | "impactAssessment">) {
    const project = await this.repository.getProject(context.tenantId, input.projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    requirePolicy(context, "update", "project_change", input.projectId, project.ownerId);
    const item: ProjectChangeRequest = {
      ...input, id: randomUUID(), tenantId: context.tenantId,
      baselineBefore: {
        name: project.name, description: project.description, businessValue: project.businessValue, acceptanceCriteria: project.acceptanceCriteria,
        resourcePlan: project.resourcePlan, startsAt: project.startsAt, targetEndAt: project.targetEndAt, budget: project.budget, currency: project.currency,
        baselineVersion: project.baselineVersion, projectVersion: project.projectVersion,
      },
      requestedBy: context.actorId, status: "submitted", version: 1,
    };
    if (!(await this.repository.saveProjectChange(item))) throw new Error("PROJECT_CHANGE_VERSION_CONFLICT");
    await this.emit(context, "project_change.submitted", "project_change", item.id, item.version, { projectId: item.projectId, changeType: item.changeType });
    return item;
  }

  async approveProjectChange(context: RequestContext, id: string, expectedVersion: number) {
    const current = await this.repository.getProjectChange(context.tenantId, id);
    if (!current) throw new Error("PROJECT_CHANGE_NOT_FOUND");
    requirePolicy(context, "approve", "project_change", id);
    const approved = approveProjectChange(current, context.actorId, expectedVersion);
    if (!(await this.repository.saveProjectChange(approved, expectedVersion))) throw new Error("PROJECT_CHANGE_VERSION_CONFLICT");
    await this.emit(context, "project_change.approved", "project_change", id, approved.version, { projectId: approved.projectId });
    return approved;
  }

  async applyProjectChange(context: RequestContext, id: string, expectedVersion: number, now = new Date()) {
    const current = await this.repository.getProjectChange(context.tenantId, id);
    if (!current) throw new Error("PROJECT_CHANGE_NOT_FOUND");
    requirePolicy(context, "execute", "project_change", id);
    if (current.version !== expectedVersion) throw new Error("PROJECT_CHANGE_VERSION_CONFLICT");
    const baseline = appliedBaseline(current);
    const applied: ProjectChangeRequest = { ...current, status: "applied", appliedProjectVersion: baseline.projectVersion, version: current.version + 1 };
    const compensation = createCompensationPlan(applied, now);
    if (!(await this.repository.applyProjectChange(applied, baseline, compensation))) throw new Error("PROJECT_VERSION_CONFLICT");
    await this.emit(context, "project_change.applied", "project_change", id, applied.version, { projectId: applied.projectId, compensationId: compensation.id });
    return { change: applied, baseline, compensation };
  }

  async saveClosureReview(context: RequestContext, projectId: string, input: Pick<ProjectClosureReview, "deliveryAcceptanceRef" | "unresolvedItems" | "retrospectiveRef">) {
    const project = await this.repository.getProject(context.tenantId, projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    requirePolicy(context, "update", "project_closure", projectId, project.ownerId);
    const current = await this.repository.getClosureReview(context.tenantId, projectId);
    const item: ProjectClosureReview = {
      ...input, id: current?.id ?? randomUUID(), tenantId: context.tenantId, projectId, ownerId: context.actorId,
      status: "ready", version: (current?.version ?? 0) + 1,
    };
    validateClosureReview(item);
    if (!(await this.repository.saveClosureReview(item, current?.version))) throw new Error("PROJECT_CLOSURE_VERSION_CONFLICT");
    await this.emit(context, "project_closure.ready", "project_closure", item.id, item.version, { projectId });
    return item;
  }

  async approveAndCompleteProject(context: RequestContext, projectId: string, closureVersion: number, projectVersion: number, now = new Date()) {
    const review = await this.repository.getClosureReview(context.tenantId, projectId);
    if (!review) throw new Error("PROJECT_CLOSURE_NOT_FOUND");
    requirePolicy(context, "approve", "project_closure", projectId);
    const approved = approveClosureReview(review, context.actorId, closureVersion);
    const completed: ProjectClosureReview = { ...approved, status: "completed", completedAt: now.toISOString(), version: approved.version + 1 };
    if (!(await this.repository.completeProject(completed, closureVersion, projectVersion))) throw new Error("PROJECT_VERSION_CONFLICT");
    await this.emit(context, "project.completed", "project", projectId, projectVersion + 1, { closureReviewId: completed.id, unresolvedHandoffs: completed.unresolvedItems.length });
    return completed;
  }

  async scanAttention(context: RequestContext, now = new Date()) {
    requirePolicy(context, "admin", "management_attention", "scan");
    const sources = await this.repository.collectAttentionSources(context.tenantId, now);
    const items = sources.map<ManagementAttentionItem>((source) => ({
      ...source, id: randomUUID(), tenantId: context.tenantId, status: "open", detectedAt: now.toISOString(), dedupeKey: attentionDedupeKey(source), version: 1,
    }));
    await this.repository.upsertAttentionItems(context.tenantId, items);
    await this.emit(context, "management_attention.scanned", "management_attention", "scan", 1, { detected: items.length });
    return items;
  }

  async executeCompensation(context: RequestContext, id: string, expectedVersion: number, now = new Date()) {
    const current = await this.repository.getCompensationPlan(context.tenantId, id);
    if (!current) throw new Error("COMPENSATION_NOT_FOUND");
    requirePolicy(context, "execute", "compensation", id);
    const executed = executeCompensation(current, context.actorId, expectedVersion, now);
    if (!(await this.repository.executeCompensation(executed))) throw new Error("PROJECT_VERSION_CONFLICT");
    await this.emit(context, "compensation.executed", "compensation", id, executed.version, { projectId: executed.resourceId, sourceOperationId: executed.sourceOperationId });
    return executed;
  }

  private async emit(context: RequestContext, type: string, aggregateType: string, aggregateId: string, aggregateVersion: number, payload: Record<string, unknown>) {
    await this.events.appendOutbox(createDomainEvent({ type, version: 1, tenantId: context.tenantId, aggregateType, aggregateId, aggregateVersion, actor: { type: "user", id: context.actorId }, traceId: context.traceId, payload }));
  }
}
