import type { EnterpriseIntelligenceData, EnterpriseIntelligenceRepository } from "@/src/modules/enterprise-intelligence/application/contracts";
import type { CapacityPlan, ResponsibilityAssignment } from "@/src/modules/organization/domain/management-governance";
import type { MetricObservation, OperatingReview } from "@/src/modules/strategy/domain/enterprise-strategy";
import { DEMO_MANAGER_ID, DEMO_OBJECTIVE_ID, DEMO_PROJECT_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

export const DEMO_THEME_ID = "91000000-0000-4000-8000-000000000001";
export const DEMO_DELIVERY_METRIC_ID = "92000000-0000-4000-8000-000000000001";
export const DEMO_MARGIN_METRIC_ID = "92000000-0000-4000-8000-000000000002";
export const DEMO_REVIEW_ID = "94000000-0000-4000-8000-000000000001";
export const DEMO_TALENT_SUBJECT_ID = "10000000-0000-4000-8000-000000000002";

function seedData(): EnterpriseIntelligenceData {
  return {
    themes: [{
      id: DEMO_THEME_ID, tenantId: DEMO_TENANT_ID, name: "高质量规模化交付", description: "在增长同时保持客户体验与交付毛利。",
      ownerId: DEMO_MANAGER_ID, status: "active", startsAt: "2026-01-01", endsAt: "2026-12-31", version: 1,
    }],
    objectives: [{
      id: DEMO_OBJECTIVE_ID, tenantId: DEMO_TENANT_ID, themeId: DEMO_THEME_ID, title: "核心客户按期交付率达到 95%",
      description: "通过交付标准化和风险前置管理提升企业客户体验。", ownerId: DEMO_MANAGER_ID, objectiveType: "okr",
      status: "at_risk", measurementMethod: "按期验收项目数 / 当期应验收项目数", dataSource: "项目验收台账",
      reviewCadence: "weekly", startsAt: "2026-07-01", endsAt: "2026-09-30", metricIds: [DEMO_DELIVERY_METRIC_ID], projectIds: [DEMO_PROJECT_ID], version: 2,
    }, {
      id: "40000000-0000-4000-8000-000000000002", tenantId: DEMO_TENANT_ID, themeId: DEMO_THEME_ID, title: "交付毛利率稳定在 33%",
      description: "以统一口径持续监控交付经营质量。", ownerId: DEMO_MANAGER_ID, objectiveType: "kpi",
      status: "active", measurementMethod: "(确认收入-交付直接成本) / 确认收入", dataSource: "财务月结口径",
      reviewCadence: "monthly", startsAt: "2026-01-01", endsAt: "2026-12-31", metricIds: [DEMO_MARGIN_METRIC_ID], projectIds: [DEMO_PROJECT_ID], version: 1,
    }],
    metrics: [{
      id: DEMO_DELIVERY_METRIC_ID, tenantId: DEMO_TENANT_ID, code: "ON_TIME_DELIVERY", name: "核心客户按期交付率", description: "按客户验收日判断。",
      ownerId: DEMO_MANAGER_ID, unit: "%", direction: "increase", baseline: 82, targetValue: 95, tolerancePercent: 3,
      sourceSystem: "project-ledger", sourceLocator: "acceptance.completed_at", refreshCadence: "weekly", classification: "internal", version: 1,
    }, {
      id: DEMO_MARGIN_METRIC_ID, tenantId: DEMO_TENANT_ID, code: "DELIVERY_MARGIN", name: "交付毛利率", description: "以财务关账口径为准。",
      ownerId: DEMO_MANAGER_ID, unit: "%", direction: "increase", baseline: 29, targetValue: 33, tolerancePercent: 2,
      sourceSystem: "finance-ledger", sourceLocator: "monthly.delivery_margin", refreshCadence: "monthly", classification: "confidential", version: 1,
    }],
    observations: [{
      id: "92100000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, metricId: DEMO_DELIVERY_METRIC_ID, value: 88,
      periodStart: "2026-07-28", periodEnd: "2026-08-03", observedAt: "2026-08-04T00:30:00.000Z", sourceType: "authoritative",
      sourceRef: "project-ledger:weekly:2026-W31", evidenceRefs: [`project:${DEMO_PROJECT_ID}`, "acceptance-batch:2026-W31"], recordedBy: DEMO_MANAGER_ID,
    }, {
      id: "92100000-0000-4000-8000-000000000002", tenantId: DEMO_TENANT_ID, metricId: DEMO_MARGIN_METRIC_ID, value: 31.8,
      periodStart: "2026-07-01", periodEnd: "2026-07-31", observedAt: "2026-08-03T02:00:00.000Z", sourceType: "human_confirmed",
      sourceRef: "finance-close:2026-07", evidenceRefs: ["finance-report:delivery-margin:2026-07"], recordedBy: DEMO_MANAGER_ID,
    }],
    portfolios: [{
      id: "93000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, code: "PF-DELIVERY", name: "客户交付组合", ownerId: DEMO_MANAGER_ID,
      status: "active", projectIds: [DEMO_PROJECT_ID], investmentThesis: "优先投入影响核心客户验收与可复制交付能力的项目。", version: 1,
    }],
    reviews: [{
      id: DEMO_REVIEW_ID, tenantId: DEMO_TENANT_ID, title: "2026 年 8 月经营复盘", cadence: "monthly", periodStart: "2026-07-01", periodEnd: "2026-07-31",
      ownerId: DEMO_MANAGER_ID, status: "pending_confirmation",
      facts: [
        { statement: "交付毛利率为 31.8%。", evidenceRefs: ["finance-close:2026-07"] },
        { statement: "核心客户按期交付率为 88%。", evidenceRefs: ["project-ledger:weekly:2026-W31"] },
      ],
      inferences: [{ statement: "按期交付偏差可能继续挤压 8 月毛利。", confidence: 0.78, evidenceRefs: ["project-ledger:weekly:2026-W31", `project:${DEMO_PROJECT_ID}`] }],
      decisions: ["将华东客户首批灰度范围控制在 30%"],
      excludedDataScopes: ["one_to_one", "talent_label", "private_chat", "online_time"], version: 1,
    }],
    responsibilities: [{
      id: "95000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, resourceType: "objective", resourceId: DEMO_OBJECTIVE_ID,
      subjectType: "user", subjectId: DEMO_MANAGER_ID, role: "accountable", startsAt: "2026-07-01T00:00:00.000Z", version: 1,
    }, {
      id: "95000000-0000-4000-8000-000000000002", tenantId: DEMO_TENANT_ID, resourceType: "objective", resourceId: DEMO_OBJECTIVE_ID,
      subjectType: "user", subjectId: DEMO_TALENT_SUBJECT_ID, role: "responsible", startsAt: "2026-07-01T00:00:00.000Z", version: 1,
    }],
    capacityPlans: [{
      id: "96000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, userId: DEMO_TALENT_SUBJECT_ID,
      periodStart: "2026-08-03", periodEnd: "2026-08-09", availableHours: 40,
      allocations: [
        { resourceType: "project", resourceId: DEMO_PROJECT_ID, allocationPercent: 75 },
        { resourceType: "operations", resourceId: "97000000-0000-4000-8000-000000000001", allocationPercent: 20 },
      ],
      includedSignals: ["planned_allocation", "approved_leave", "project_assignment"], version: 1,
    }],
    performanceFacts: [{
      id: "98000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, subjectUserId: DEMO_TALENT_SUBJECT_ID,
      sourceType: "project", sourceId: DEMO_PROJECT_ID, statement: "完成华东客户核心链路回归并提交可复核测试证据。",
      evidenceRefs: [`project:${DEMO_PROJECT_ID}`, "test-report:east-core-flow"], factType: "fact", effectiveAt: "2026-08-02T09:00:00.000Z",
      classification: "confidential", visibleToIds: [DEMO_MANAGER_ID, DEMO_TALENT_SUBJECT_ID],
    }],
    talentRecords: [{
      id: "99000000-0000-4000-8000-000000000001", tenantId: DEMO_TENANT_ID, subjectUserId: DEMO_TALENT_SUBJECT_ID,
      recordType: "one_to_one", content: "受限的 1:1 私密记录，不进入通用 Agent 上下文。", participantIds: [DEMO_MANAGER_ID, DEMO_TALENT_SUBJECT_ID],
      agentEligible: false, classification: "restricted", effectiveAt: "2026-08-01T08:00:00.000Z",
    }, {
      id: "99000000-0000-4000-8000-000000000002", tenantId: DEMO_TENANT_ID, subjectUserId: DEMO_TALENT_SUBJECT_ID,
      recordType: "development_goal", content: "提升跨团队交付风险协调能力。", participantIds: [DEMO_MANAGER_ID, DEMO_TALENT_SUBJECT_ID],
      agentEligible: true, classification: "confidential", effectiveAt: "2026-07-01T08:00:00.000Z",
    }],
    generatedAt: new Date().toISOString(),
  };
}

export class InMemoryEnterpriseIntelligenceRepository implements EnterpriseIntelligenceRepository {
  private data: EnterpriseIntelligenceData;
  constructor(seed = true) { this.data = seed ? seedData() : { themes: [], objectives: [], metrics: [], observations: [], portfolios: [], reviews: [], responsibilities: [], capacityPlans: [], performanceFacts: [], talentRecords: [], generatedAt: new Date().toISOString() }; }

  async getData(tenantId: string) {
    const filter = <T extends { tenantId: string }>(items: T[]) => items.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item));
    return {
      themes: filter(this.data.themes), objectives: filter(this.data.objectives), metrics: filter(this.data.metrics), observations: filter(this.data.observations),
      portfolios: filter(this.data.portfolios), reviews: filter(this.data.reviews), responsibilities: filter(this.data.responsibilities), capacityPlans: filter(this.data.capacityPlans),
      performanceFacts: filter(this.data.performanceFacts), talentRecords: filter(this.data.talentRecords), generatedAt: new Date().toISOString(),
    };
  }

  async getMetric(tenantId: string, id: string) { return structuredClone(this.data.metrics.find((item) => item.tenantId === tenantId && item.id === id) ?? null); }
  async saveObservation(observation: MetricObservation) { this.data.observations.push(structuredClone(observation)); }
  async getReview(tenantId: string, id: string) { return structuredClone(this.data.reviews.find((item) => item.tenantId === tenantId && item.id === id) ?? null); }
  async saveReview(review: OperatingReview, expectedVersion: number) {
    const index = this.data.reviews.findIndex((item) => item.tenantId === review.tenantId && item.id === review.id);
    if (index < 0 || this.data.reviews[index].version !== expectedVersion) return false;
    this.data.reviews[index] = structuredClone(review); return true;
  }
  async replaceResponsibilities(tenantId: string, resourceType: ResponsibilityAssignment["resourceType"], resourceId: string, assignments: ResponsibilityAssignment[]) {
    this.data.responsibilities = this.data.responsibilities.filter((item) => !(item.tenantId === tenantId && item.resourceType === resourceType && item.resourceId === resourceId));
    this.data.responsibilities.push(...assignments.map((item) => structuredClone(item)));
  }
  async saveCapacityPlan(plan: CapacityPlan) {
    const index = this.data.capacityPlans.findIndex((item) => item.tenantId === plan.tenantId && item.userId === plan.userId && item.periodStart === plan.periodStart);
    if (index >= 0) this.data.capacityPlans[index] = structuredClone(plan); else this.data.capacityPlans.push(structuredClone(plan));
  }
}

const runtime = globalThis as typeof globalThis & { __nexusEnterpriseRepository?: InMemoryEnterpriseIntelligenceRepository; __nexusEnterpriseRepositoryVersion?: number };
export function getDevelopmentEnterpriseRepository() {
  if (runtime.__nexusEnterpriseRepositoryVersion !== 1) {
    runtime.__nexusEnterpriseRepository = new InMemoryEnterpriseIntelligenceRepository();
    runtime.__nexusEnterpriseRepositoryVersion = 1;
  }
  return runtime.__nexusEnterpriseRepository!;
}
