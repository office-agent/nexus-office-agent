import type { EnterpriseGovernanceRepository, EnterpriseGovernanceWorkspace, GovernedObjectiveRecord, GovernedProjectRecord } from "@/src/modules/enterprise-governance/application/contracts";
import type {
  AttentionSource,
  CompensationPlan,
  ManagementAttentionItem,
  OrganizationChangeCase,
  ProjectBaseline,
  ProjectChangeRequest,
  ProjectClosureReview,
  WorkHandoff,
} from "@/src/modules/enterprise-governance/domain/governance";
import { DEMO_MANAGER_ID, DEMO_PROJECT_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const successorId = "10000000-0000-4000-8000-000000000002";

function seededProject(): GovernedProjectRecord {
  return {
    id: DEMO_PROJECT_ID, tenantId: DEMO_TENANT_ID, code: "DELIVERY-EAST", ownerId: DEMO_MANAGER_ID, status: "active", priority: "critical", health: "at_risk",
    name: "华东客户交付计划", description: "通过统一交付节奏保障关键客户按期验收。", businessValue: "保障核心客户续约并沉淀标准交付方法。",
    acceptanceCriteria: "客户验收单签署且遗留事项均有书面移交。", resourcePlan: { delivery: 3, qa: 1 }, startsAt: "2026-07-01", targetEndAt: "2026-09-30",
    budget: 800000, currency: "CNY", baselineVersion: 1, projectVersion: 3,
  };
}

export class InMemoryEnterpriseGovernanceRepository implements EnterpriseGovernanceRepository {
  readonly organizationChanges = new Map<string, OrganizationChangeCase>();
  readonly projectChanges = new Map<string, ProjectChangeRequest>();
  readonly closureReviews = new Map<string, ProjectClosureReview>();
  readonly compensationPlans = new Map<string, CompensationPlan>();
  readonly objectives = new Map<string, GovernedObjectiveRecord>();
  readonly projects = new Map<string, GovernedProjectRecord>();
  handoffs: WorkHandoff[] = [];
  attentionItems: ManagementAttentionItem[] = [];
  pendingOwnerships: Array<{ resourceType: WorkHandoff["resourceType"]; resourceId: string; fromUserId: string }> = [];
  attentionSources: AttentionSource[] = [];

  constructor(seed = true) {
    if (seed) {
      const project = seededProject();
      this.projects.set(project.id, project);
      this.objectives.set("40000000-0000-4000-8000-000000000001", {
        id: "40000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, title: "关键客户按期交付率达到 95%",
        description: "以标准交付和风险前置保障核心客户续约", ownerId: DEMO_MANAGER_ID, status: "active",
        baseline: 86, targetValue: 95, currentValue: 91, unit: "%", startsAt: "2026-07-01", endsAt: "2026-09-30", reviewCadence: "weekly", version: 1,
      });
      this.organizationChanges.set("91000000-0000-4000-8000-000000000001", {
        id: "91000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, subjectUserId: successorId,
        changeType: "departure", effectiveAt: "2026-08-04T16:00:00.000Z", successorUserId: DEMO_MANAGER_ID,
        reason: "客户成功负责人离岗，交接客户与风险跟进", status: "submitted", requestedBy: successorId, version: 1,
      });
      this.projectChanges.set("93000000-0000-4000-8000-000000000001", {
        id: "93000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, projectId: project.id, changeType: "schedule",
        baselineBefore: {
          name: project.name, description: project.description, businessValue: project.businessValue, acceptanceCriteria: project.acceptanceCriteria,
          resourcePlan: project.resourcePlan, startsAt: project.startsAt, targetEndAt: project.targetEndAt, budget: project.budget,
          currency: project.currency, baselineVersion: project.baselineVersion, projectVersion: project.projectVersion,
        },
        proposedBaseline: { targetEndAt: "2026-10-07" }, reason: "客户验收窗口后移一周", impactAssessment: "交付节奏调整，预算与范围不变",
        requestedBy: successorId, status: "submitted", version: 1,
      });
      this.pendingOwnerships = [
        { resourceType: "task", resourceId: "70000000-0000-4000-8000-000000000001", fromUserId: DEMO_MANAGER_ID },
        { resourceType: "risk", resourceId: "50000000-0000-4000-8000-000000000001", fromUserId: successorId },
      ];
      this.attentionSources = [{ projectId: project.id, sourceType: "risk", sourceId: "50000000-0000-4000-8000-000000000001", ownerId: DEMO_MANAGER_ID, reasonCode: "risk_exposure", severity: "at_risk", details: { exposure: 12 } }];
    }
  }

  async getWorkspace(tenantId: string): Promise<EnterpriseGovernanceWorkspace> {
    const filter = <T extends { tenantId: string }>(items: Iterable<T>) => [...items].filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item));
    return {
      objectives: filter(this.objectives.values()), projects: filter(this.projects.values()), organizationChanges: filter(this.organizationChanges.values()), handoffs: filter(this.handoffs), projectChanges: filter(this.projectChanges.values()),
      closureReviews: filter(this.closureReviews.values()), attentionItems: filter(this.attentionItems), compensationPlans: filter(this.compensationPlans.values()), generatedAt: new Date().toISOString(),
    };
  }

  async createInitiative(objective: GovernedObjectiveRecord, project: GovernedProjectRecord) {
    if (this.objectives.has(objective.id) || this.projects.has(project.id) || [...this.projects.values()].some((item) => item.tenantId === project.tenantId && item.code === project.code)) return false;
    this.objectives.set(objective.id, structuredClone(objective));
    this.projects.set(project.id, structuredClone(project));
    return true;
  }

  async getOrganizationChange(tenantId: string, id: string) { const item = this.organizationChanges.get(id); return item?.tenantId === tenantId ? structuredClone(item) : null; }
  async saveOrganizationChange(item: OrganizationChangeCase, expectedVersion?: number) {
    const current = this.organizationChanges.get(item.id);
    if (expectedVersion === undefined ? Boolean(current) : !current || current.version !== expectedVersion) return false;
    this.organizationChanges.set(item.id, structuredClone(item)); return true;
  }
  async executeOrganizationChange(item: OrganizationChangeCase) {
    const current = this.organizationChanges.get(item.id);
    if (!current || current.version + 1 !== item.version || current.status !== "approved") throw new Error("ORGANIZATION_CHANGE_VERSION_CONFLICT");
    const ownerships = this.pendingOwnerships.filter((entry) => entry.fromUserId === item.subjectUserId);
    if (item.changeType === "departure" && ownerships.length > 0 && !item.successorUserId) throw new Error("ORGANIZATION_CHANGE_SUCCESSOR_REQUIRED");
    const handoffs = (item.successorUserId ? ownerships : []).map<WorkHandoff>((entry) => ({
      id: crypto.randomUUID(), tenantId: item.tenantId, organizationChangeId: item.id, resourceType: entry.resourceType, resourceId: entry.resourceId,
      fromUserId: item.subjectUserId, toUserId: item.successorUserId!, status: "transferred", evidenceRef: `organization-change:${item.id}`,
      transferredAt: item.executedAt!, version: 1,
    }));
    this.handoffs.push(...handoffs);
    this.pendingOwnerships = this.pendingOwnerships.map((entry) => entry.fromUserId === item.subjectUserId && item.successorUserId ? { ...entry, fromUserId: item.successorUserId } : entry);
    this.organizationChanges.set(item.id, structuredClone(item));
    return structuredClone(handoffs);
  }

  async getProject(tenantId: string, id: string) { const item = this.projects.get(id); return item?.tenantId === tenantId ? structuredClone(item) : null; }
  async getProjectChange(tenantId: string, id: string) { const item = this.projectChanges.get(id); return item?.tenantId === tenantId ? structuredClone(item) : null; }
  async saveProjectChange(item: ProjectChangeRequest, expectedVersion?: number) {
    const current = this.projectChanges.get(item.id);
    if (expectedVersion === undefined ? Boolean(current) : !current || current.version !== expectedVersion) return false;
    this.projectChanges.set(item.id, structuredClone(item)); return true;
  }
  async applyProjectChange(item: ProjectChangeRequest, baseline: ProjectBaseline, compensation: CompensationPlan) {
    const project = this.projects.get(item.projectId);
    const current = this.projectChanges.get(item.id);
    if (!project || !current || project.projectVersion !== item.baselineBefore.projectVersion || current.version + 1 !== item.version) return false;
    this.projects.set(project.id, { ...project, ...structuredClone(baseline) });
    this.projectChanges.set(item.id, structuredClone(item));
    this.compensationPlans.set(compensation.id, structuredClone(compensation));
    return true;
  }

  async getClosureReview(tenantId: string, projectId: string) { const item = this.closureReviews.get(projectId); return item?.tenantId === tenantId ? structuredClone(item) : null; }
  async saveClosureReview(item: ProjectClosureReview, expectedVersion?: number) {
    const current = this.closureReviews.get(item.projectId);
    if (expectedVersion === undefined ? Boolean(current) : !current || current.version !== expectedVersion) return false;
    this.closureReviews.set(item.projectId, structuredClone(item)); return true;
  }
  async completeProject(item: ProjectClosureReview, expectedClosureVersion: number, expectedProjectVersion: number) {
    const project = this.projects.get(item.projectId);
    const review = this.closureReviews.get(item.projectId);
    if (!project || !review || project.status !== "closing" || project.projectVersion !== expectedProjectVersion) return false;
    if (review.status !== "ready" || review.version !== expectedClosureVersion || item.status !== "completed" || item.version !== expectedClosureVersion + 2) throw new Error("PROJECT_CLOSURE_VERSION_CONFLICT");
    this.projects.set(project.id, { ...project, status: "completed", projectVersion: project.projectVersion + 1 });
    this.closureReviews.set(item.projectId, structuredClone(item)); return true;
  }

  async collectAttentionSources(tenantId: string) { return structuredClone(this.attentionSources.filter((item) => this.projects.get(item.projectId)?.tenantId === tenantId)); }
  async upsertAttentionItems(tenantId: string, items: ManagementAttentionItem[]) {
    for (const item of items.filter((entry) => entry.tenantId === tenantId)) {
      const index = this.attentionItems.findIndex((entry) => entry.tenantId === tenantId && entry.dedupeKey === item.dedupeKey);
      if (index >= 0) this.attentionItems[index] = { ...this.attentionItems[index], ...structuredClone(item), id: this.attentionItems[index].id, version: this.attentionItems[index].version + 1 };
      else this.attentionItems.push(structuredClone(item));
    }
  }

  async getCompensationPlan(tenantId: string, id: string) { const item = this.compensationPlans.get(id); return item?.tenantId === tenantId ? structuredClone(item) : null; }
  async executeCompensation(item: CompensationPlan) {
    const current = this.compensationPlans.get(item.id);
    const project = this.projects.get(item.resourceId);
    const change = this.projectChanges.get(item.sourceOperationId);
    if (!current || !project || !change || current.version + 1 !== item.version || project.projectVersion !== current.expectedResourceVersion) return false;
    const restored = item.inversePayload;
    this.projects.set(project.id, { ...project, ...structuredClone(restored), projectVersion: project.projectVersion + 1, baselineVersion: project.baselineVersion + 1 });
    this.compensationPlans.set(item.id, structuredClone(item));
    this.projectChanges.set(change.id, { ...change, status: "compensated", version: change.version + 1 });
    return true;
  }
}

const runtime = globalThis as typeof globalThis & { __nexusGovernanceRepository?: InMemoryEnterpriseGovernanceRepository; __nexusGovernanceRepositoryVersion?: number };
export function getDevelopmentEnterpriseGovernanceRepository() {
  if (runtime.__nexusGovernanceRepositoryVersion !== 1) {
    runtime.__nexusGovernanceRepository = new InMemoryEnterpriseGovernanceRepository();
    runtime.__nexusGovernanceRepositoryVersion = 1;
  }
  return runtime.__nexusGovernanceRepository!;
}
