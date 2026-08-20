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

export type GovernedProjectRecord = ProjectBaseline & {
  id: string;
  tenantId: string;
  code: string;
  ownerId: string;
  status: "draft" | "proposed" | "approved" | "active" | "paused" | "closing" | "completed" | "cancelled";
  priority: "critical" | "high" | "medium" | "low";
  health: "unknown" | "healthy" | "watch" | "at_risk" | "critical";
};

export type GovernedObjectiveRecord = {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  ownerId: string;
  status: "draft" | "proposed" | "active" | "at_risk" | "achieved" | "missed" | "cancelled" | "reviewed";
  baseline: number;
  targetValue: number;
  currentValue: number;
  unit: string;
  startsAt: string;
  endsAt: string;
  reviewCadence: "daily" | "weekly" | "monthly" | "quarterly";
  version: number;
};

export type EnterpriseGovernanceWorkspace = {
  objectives: GovernedObjectiveRecord[];
  projects: GovernedProjectRecord[];
  organizationChanges: OrganizationChangeCase[];
  handoffs: WorkHandoff[];
  projectChanges: ProjectChangeRequest[];
  closureReviews: ProjectClosureReview[];
  attentionItems: ManagementAttentionItem[];
  compensationPlans: CompensationPlan[];
  generatedAt: string;
};

export interface EnterpriseGovernanceRepository {
  getWorkspace(tenantId: string): Promise<EnterpriseGovernanceWorkspace>;
  createInitiative(objective: GovernedObjectiveRecord, project: GovernedProjectRecord): Promise<boolean>;
  getOrganizationChange(tenantId: string, id: string): Promise<OrganizationChangeCase | null>;
  saveOrganizationChange(item: OrganizationChangeCase, expectedVersion?: number): Promise<boolean>;
  executeOrganizationChange(item: OrganizationChangeCase): Promise<WorkHandoff[]>;
  getProject(tenantId: string, id: string): Promise<GovernedProjectRecord | null>;
  getProjectChange(tenantId: string, id: string): Promise<ProjectChangeRequest | null>;
  saveProjectChange(item: ProjectChangeRequest, expectedVersion?: number): Promise<boolean>;
  applyProjectChange(item: ProjectChangeRequest, baseline: ProjectBaseline, compensation: CompensationPlan): Promise<boolean>;
  getClosureReview(tenantId: string, projectId: string): Promise<ProjectClosureReview | null>;
  saveClosureReview(item: ProjectClosureReview, expectedVersion?: number): Promise<boolean>;
  completeProject(item: ProjectClosureReview, expectedClosureVersion: number, expectedProjectVersion: number): Promise<boolean>;
  collectAttentionSources(tenantId: string, now: Date): Promise<AttentionSource[]>;
  upsertAttentionItems(tenantId: string, items: ManagementAttentionItem[]): Promise<void>;
  getCompensationPlan(tenantId: string, id: string): Promise<CompensationPlan | null>;
  executeCompensation(item: CompensationPlan): Promise<boolean>;
}
