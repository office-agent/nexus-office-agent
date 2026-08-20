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

export type ManagementIntelligenceData = {
  cadences: ManagementCadence[];
  occurrences: CadenceOccurrence[];
  metricProfiles: MetricSemanticProfile[];
  metricQualityChecks: MetricQualityCheck[];
  scenarios: PortfolioScenario[];
  cases: EnterpriseCase[];
  evaluations: AiGovernanceEvaluation[];
  channelActions: ManagementChannelAction[];
  generatedAt: string;
};

export interface ManagementIntelligenceRepository {
  getData(tenantId: string): Promise<ManagementIntelligenceData>;
  getCadence(tenantId: string, id: string): Promise<ManagementCadence | null>;
  saveCadence(value: ManagementCadence): Promise<void>;
  getOccurrence(tenantId: string, id: string): Promise<CadenceOccurrence | null>;
  saveOccurrence(value: CadenceOccurrence, expectedVersion?: number): Promise<boolean>;
  getMetricProfile(tenantId: string, metricId: string): Promise<MetricSemanticProfile | null>;
  metricExists(tenantId: string, metricId: string): Promise<boolean>;
  saveMetricProfile(value: MetricSemanticProfile, expectedVersion?: number): Promise<boolean>;
  saveMetricQualityCheck(value: MetricQualityCheck): Promise<void>;
  portfolioExists(tenantId: string, portfolioId: string): Promise<boolean>;
  saveScenario(value: PortfolioScenario): Promise<void>;
  getScenario(tenantId: string, id: string): Promise<PortfolioScenario | null>;
  selectScenario(value: PortfolioScenario, expectedVersion: number): Promise<boolean>;
  saveCase(value: EnterpriseCase): Promise<void>;
  getCase(tenantId: string, id: string): Promise<EnterpriseCase | null>;
  updateCase(value: EnterpriseCase, expectedVersion: number): Promise<boolean>;
  saveEvaluation(value: AiGovernanceEvaluation): Promise<void>;
  isWecomConnectionActive(tenantId: string, connectionId: string): Promise<boolean>;
  saveChannelAction(value: ManagementChannelAction): Promise<void>;
  getChannelAction(tenantId: string, id: string): Promise<ManagementChannelAction | null>;
  updateChannelAction(value: ManagementChannelAction, expectedVersion: number): Promise<boolean>;
  executeCaseChannelAction(input: { action: ManagementChannelAction; enterpriseCase: EnterpriseCase; expectedActionVersion: number; expectedResourceVersion: number }): Promise<boolean>;
  executeOccurrenceChannelAction(input: { action: ManagementChannelAction; occurrence: CadenceOccurrence; expectedActionVersion: number; expectedResourceVersion: number }): Promise<boolean>;
}

export type WecomActionDelivery = {
  status: "delivered" | "retry_scheduled" | "failed" | "unknown";
  attempts: number;
  externalMessageId?: string;
  errorCategory?: string;
};

export interface ManagementWecomGateway {
  deliver(input: {
    id: string;
    tenantId: string;
    connectionId: string;
    externalUserId: string;
    message: {
      type: "confirmation";
      title: string;
      text: string;
      deepLink: string;
      actionId: string;
      proposalHash: string;
      expiresAt: string;
    };
  }): Promise<WecomActionDelivery>;
}
