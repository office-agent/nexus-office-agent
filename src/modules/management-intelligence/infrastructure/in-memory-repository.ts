import type { ManagementIntelligenceData, ManagementIntelligenceRepository, ManagementWecomGateway, WecomActionDelivery } from "@/src/modules/management-intelligence/application/contracts";
import type {
  AiGovernanceEvaluation,
  CadenceOccurrence,
  EnterpriseCase,
  ManagementCadence,
  ManagementChannelAction,
  MetricQualityCheck,
  MetricSemanticProfile,
  PortfolioScenario,
} from "@/src/modules/management-intelligence/domain/management-intelligence";
import { DEMO_MANAGER_ID, DEMO_PROJECT_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

export const DEMO_MANAGEMENT_CADENCE_ID = "a1000000-0000-4000-8000-000000000001";
export const DEMO_CADENCE_OCCURRENCE_ID = "a2000000-0000-4000-8000-000000000001";
export const DEMO_METRIC_ID = "92000000-0000-4000-8000-000000000001";
export const DEMO_PORTFOLIO_ID = "93000000-0000-4000-8000-000000000001";
export const DEMO_PORTFOLIO_SCENARIO_ID = "a3000000-0000-4000-8000-000000000001";
export const DEMO_ENTERPRISE_CASE_ID = "a4000000-0000-4000-8000-000000000001";
export const DEMO_WECOM_CONNECTION_ID = "a5000000-0000-4000-8000-000000000001";

function seedData(): ManagementIntelligenceData {
  return {
    cadences: [{
      id: DEMO_MANAGEMENT_CADENCE_ID,
      tenantId: DEMO_TENANT_ID,
      name: "每周交付经营会",
      cadenceType: "weekly_operations",
      frequency: "weekly",
      timezone: "Asia/Shanghai",
      ownerId: DEMO_MANAGER_ID,
      participantRoleIds: ["delivery_owner", "pmo", "operations"],
      agendaTemplate: ["核对指标新鲜度", "处理关键事项", "确认资源与行动"],
      evidenceRequirements: ["指标质量检查", "事项处理证据", "决定和行动项"],
      status: "active",
      nextOccurrenceAt: "2026-08-07T01:00:00.000Z",
      version: 1,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }],
    occurrences: [{
      id: DEMO_CADENCE_OCCURRENCE_ID,
      tenantId: DEMO_TENANT_ID,
      cadenceId: DEMO_MANAGEMENT_CADENCE_ID,
      scheduledStartAt: "2026-08-07T01:00:00.000Z",
      scheduledEndAt: "2026-08-07T02:00:00.000Z",
      status: "scheduled",
      outcomeEvidenceRefs: [],
      acknowledgedByIds: [],
      version: 1,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }],
    metricProfiles: [{
      id: "a6000000-0000-4000-8000-000000000001",
      tenantId: DEMO_TENANT_ID,
      metricId: DEMO_METRIC_ID,
      businessDefinition: "在承诺日期内完成客户验收的核心项目占比。",
      formula: "按期验收核心项目数 / 当期应验收核心项目数 × 100%",
      ownerId: DEMO_MANAGER_ID,
      stewardId: DEMO_MANAGER_ID,
      authoritativeSource: "项目验收台账",
      sourceLocator: "acceptance.completed_at",
      refreshCadence: "weekly",
      freshnessSlaMinutes: 10_080,
      dimensions: ["客户区域", "项目级别"],
      allowedUses: ["经营复盘", "资源调度"],
      prohibitedUses: ["个人绩效自动评分", "雇佣决定"],
      version: 1,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }],
    metricQualityChecks: [{
      id: "a7000000-0000-4000-8000-000000000001",
      tenantId: DEMO_TENANT_ID,
      metricId: DEMO_METRIC_ID,
      status: "healthy",
      observedAt: "2026-08-04T01:00:00.000Z",
      freshnessMinutes: 1_380,
      completenessPercent: 100,
      evidenceRefs: ["project-ledger:2026-W31"],
      checkedBy: DEMO_MANAGER_ID,
      checkedAt: "2026-08-05T00:00:00.000Z",
    }],
    scenarios: [{
      id: DEMO_PORTFOLIO_SCENARIO_ID,
      tenantId: DEMO_TENANT_ID,
      portfolioId: DEMO_PORTFOLIO_ID,
      name: "守住核心客户交付",
      assumptions: ["本月总交付容量保持不变", "核心客户验收优先"],
      projectDecisions: [{ projectId: DEMO_PROJECT_ID, action: "accelerate", capacityPercent: 65, rationale: "优先解除核心验收链路阻塞" }],
      expectedBenefit: 120,
      estimatedCost: 35,
      riskScore: 8,
      evidenceRefs: [`project:${DEMO_PROJECT_ID}`, "capacity-plan:2026-W32"],
      status: "recommended",
      createdBy: DEMO_MANAGER_ID,
      version: 1,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }],
    cases: [{
      id: DEMO_ENTERPRISE_CASE_ID,
      tenantId: DEMO_TENANT_ID,
      code: "CASE-20260805-DEMO01",
      caseType: "operational_exception",
      title: "核心客户验收依赖待确认",
      description: "一个跨团队依赖尚未形成正式责任和处理证据。",
      severity: "high",
      status: "open",
      dueAt: "2026-08-08T10:00:00.000Z",
      slaMinutes: 4_320,
      sourceType: "system",
      sourceRef: `project:${DEMO_PROJECT_ID}`,
      relatedObjectRefs: [`project:${DEMO_PROJECT_ID}`],
      evidenceRefs: [],
      createdBy: DEMO_MANAGER_ID,
      version: 1,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }],
    evaluations: [],
    channelActions: [],
    generatedAt: new Date().toISOString(),
  };
}

export class InMemoryManagementIntelligenceRepository implements ManagementIntelligenceRepository {
  private data = seedData();
  private readonly activeWecomConnections = new Set([`${DEMO_TENANT_ID}:${DEMO_WECOM_CONNECTION_ID}`]);

  async getData(tenantId: string) {
    const copy = structuredClone(this.data);
    return {
      ...copy,
      cadences: copy.cadences.filter((item) => item.tenantId === tenantId),
      occurrences: copy.occurrences.filter((item) => item.tenantId === tenantId),
      metricProfiles: copy.metricProfiles.filter((item) => item.tenantId === tenantId),
      metricQualityChecks: copy.metricQualityChecks.filter((item) => item.tenantId === tenantId),
      scenarios: copy.scenarios.filter((item) => item.tenantId === tenantId),
      cases: copy.cases.filter((item) => item.tenantId === tenantId),
      evaluations: copy.evaluations.filter((item) => item.tenantId === tenantId),
      channelActions: copy.channelActions.filter((item) => item.tenantId === tenantId),
      generatedAt: new Date().toISOString(),
    };
  }

  async getCadence(tenantId: string, id: string) { return structuredClone(this.data.cadences.find((item) => item.tenantId === tenantId && item.id === id) ?? null); }
  async saveCadence(value: ManagementCadence) { this.data.cadences.push(structuredClone(value)); }
  async getOccurrence(tenantId: string, id: string) { return structuredClone(this.data.occurrences.find((item) => item.tenantId === tenantId && item.id === id) ?? null); }
  async saveOccurrence(value: CadenceOccurrence, expectedVersion?: number) {
    const index = this.data.occurrences.findIndex((item) => item.tenantId === value.tenantId && item.id === value.id);
    if (index < 0) { if (expectedVersion !== undefined) return false; this.data.occurrences.push(structuredClone(value)); return true; }
    if (expectedVersion === undefined || this.data.occurrences[index].version !== expectedVersion) return false;
    this.data.occurrences[index] = structuredClone(value); return true;
  }
  async getMetricProfile(tenantId: string, metricId: string) { return structuredClone(this.data.metricProfiles.find((item) => item.tenantId === tenantId && item.metricId === metricId) ?? null); }
  async metricExists(tenantId: string, metricId: string) { return tenantId === DEMO_TENANT_ID && metricId === DEMO_METRIC_ID; }
  async saveMetricProfile(value: MetricSemanticProfile, expectedVersion?: number) {
    const index = this.data.metricProfiles.findIndex((item) => item.tenantId === value.tenantId && item.metricId === value.metricId);
    if (index < 0) { if (expectedVersion !== undefined) return false; this.data.metricProfiles.push(structuredClone(value)); return true; }
    if (expectedVersion === undefined || this.data.metricProfiles[index].version !== expectedVersion) return false;
    this.data.metricProfiles[index] = structuredClone(value); return true;
  }
  async saveMetricQualityCheck(value: MetricQualityCheck) { this.data.metricQualityChecks.push(structuredClone(value)); }
  async portfolioExists(tenantId: string, portfolioId: string) { return tenantId === DEMO_TENANT_ID && portfolioId === DEMO_PORTFOLIO_ID; }
  async saveScenario(value: PortfolioScenario) { this.data.scenarios.push(structuredClone(value)); }
  async getScenario(tenantId: string, id: string) { return structuredClone(this.data.scenarios.find((item) => item.tenantId === tenantId && item.id === id) ?? null); }
  async selectScenario(value: PortfolioScenario, expectedVersion: number) {
    const index = this.data.scenarios.findIndex((item) => item.tenantId === value.tenantId && item.id === value.id);
    if (index < 0 || this.data.scenarios[index].version !== expectedVersion) return false;
    this.data.scenarios = this.data.scenarios.map((item) => item.tenantId === value.tenantId && item.portfolioId === value.portfolioId && item.status === "selected" ? { ...item, status: "superseded", version: item.version + 1, updatedAt: value.updatedAt } : item);
    this.data.scenarios[index] = structuredClone(value); return true;
  }
  async saveCase(value: EnterpriseCase) { this.data.cases.push(structuredClone(value)); }
  async getCase(tenantId: string, id: string) { return structuredClone(this.data.cases.find((item) => item.tenantId === tenantId && item.id === id) ?? null); }
  async updateCase(value: EnterpriseCase, expectedVersion: number) {
    const index = this.data.cases.findIndex((item) => item.tenantId === value.tenantId && item.id === value.id);
    if (index < 0 || this.data.cases[index].version !== expectedVersion) return false;
    this.data.cases[index] = structuredClone(value); return true;
  }
  async saveEvaluation(value: AiGovernanceEvaluation) { this.data.evaluations.push(structuredClone(value)); }
  async isWecomConnectionActive(tenantId: string, connectionId: string) { return this.activeWecomConnections.has(`${tenantId}:${connectionId}`); }
  async saveChannelAction(value: ManagementChannelAction) { this.data.channelActions.push(structuredClone(value)); }
  async getChannelAction(tenantId: string, id: string) { return structuredClone(this.data.channelActions.find((item) => item.tenantId === tenantId && item.id === id) ?? null); }
  async updateChannelAction(value: ManagementChannelAction, expectedVersion: number) {
    const index = this.data.channelActions.findIndex((item) => item.tenantId === value.tenantId && item.id === value.id);
    if (index < 0 || this.data.channelActions[index].version !== expectedVersion) return false;
    this.data.channelActions[index] = structuredClone(value); return true;
  }
  async executeCaseChannelAction(input: { action: ManagementChannelAction; enterpriseCase: EnterpriseCase; expectedActionVersion: number; expectedResourceVersion: number }) {
    const actionIndex = this.data.channelActions.findIndex((item) => item.tenantId === input.action.tenantId && item.id === input.action.id);
    const caseIndex = this.data.cases.findIndex((item) => item.tenantId === input.enterpriseCase.tenantId && item.id === input.enterpriseCase.id);
    if (actionIndex < 0 || caseIndex < 0 || this.data.channelActions[actionIndex].version !== input.expectedActionVersion || this.data.cases[caseIndex].version !== input.expectedResourceVersion) return false;
    this.data.channelActions[actionIndex] = structuredClone(input.action);
    this.data.cases[caseIndex] = structuredClone(input.enterpriseCase);
    return true;
  }
  async executeOccurrenceChannelAction(input: { action: ManagementChannelAction; occurrence: CadenceOccurrence; expectedActionVersion: number; expectedResourceVersion: number }) {
    const actionIndex = this.data.channelActions.findIndex((item) => item.tenantId === input.action.tenantId && item.id === input.action.id);
    const occurrenceIndex = this.data.occurrences.findIndex((item) => item.tenantId === input.occurrence.tenantId && item.id === input.occurrence.id);
    if (actionIndex < 0 || occurrenceIndex < 0 || this.data.channelActions[actionIndex].version !== input.expectedActionVersion || this.data.occurrences[occurrenceIndex].version !== input.expectedResourceVersion) return false;
    this.data.channelActions[actionIndex] = structuredClone(input.action);
    this.data.occurrences[occurrenceIndex] = structuredClone(input.occurrence);
    return true;
  }
}

export class InMemoryManagementWecomGateway implements ManagementWecomGateway {
  readonly deliveries: Parameters<ManagementWecomGateway["deliver"]>[0][] = [];
  async deliver(input: Parameters<ManagementWecomGateway["deliver"]>[0]): Promise<WecomActionDelivery> {
    this.deliveries.push(structuredClone(input));
    return { status: "delivered", attempts: 1, externalMessageId: `fixture-${input.id}` };
  }
}

const runtime = globalThis as typeof globalThis & { __nexusManagementIntelligenceRepository?: InMemoryManagementIntelligenceRepository; __nexusManagementWecomGateway?: InMemoryManagementWecomGateway; __nexusManagementFixtureVersion?: number };

export function getDevelopmentManagementIntelligenceRepository() {
  if (runtime.__nexusManagementFixtureVersion !== 1) {
    runtime.__nexusManagementIntelligenceRepository = new InMemoryManagementIntelligenceRepository();
    runtime.__nexusManagementWecomGateway = new InMemoryManagementWecomGateway();
    runtime.__nexusManagementFixtureVersion = 1;
  }
  return runtime.__nexusManagementIntelligenceRepository!;
}

export function getDevelopmentManagementWecomGateway() {
  getDevelopmentManagementIntelligenceRepository();
  return runtime.__nexusManagementWecomGateway!;
}

