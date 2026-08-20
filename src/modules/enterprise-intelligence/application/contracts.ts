import type { CapacityPlan, ResponsibilityAssignment } from "@/src/modules/organization/domain/management-governance";
import type { GovernedObjective, MetricDefinition, MetricObservation, OperatingReview, StrategyTheme } from "@/src/modules/strategy/domain/enterprise-strategy";
import type { PerformanceFact, TalentRecord } from "@/src/modules/talent/domain/performance-evidence";

export type Portfolio = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  ownerId: string;
  status: "draft" | "active" | "paused" | "closed";
  projectIds: string[];
  investmentThesis: string;
  version: number;
};

export type EnterpriseIntelligenceData = {
  themes: StrategyTheme[];
  objectives: GovernedObjective[];
  metrics: MetricDefinition[];
  observations: MetricObservation[];
  portfolios: Portfolio[];
  reviews: OperatingReview[];
  responsibilities: ResponsibilityAssignment[];
  capacityPlans: CapacityPlan[];
  performanceFacts: PerformanceFact[];
  talentRecords: TalentRecord[];
  generatedAt: string;
};

export interface EnterpriseIntelligenceRepository {
  getData(tenantId: string): Promise<EnterpriseIntelligenceData>;
  getMetric(tenantId: string, id: string): Promise<MetricDefinition | null>;
  saveObservation(observation: MetricObservation): Promise<void>;
  getReview(tenantId: string, id: string): Promise<OperatingReview | null>;
  saveReview(review: OperatingReview, expectedVersion: number): Promise<boolean>;
  replaceResponsibilities(tenantId: string, resourceType: ResponsibilityAssignment["resourceType"], resourceId: string, assignments: ResponsibilityAssignment[]): Promise<void>;
  saveCapacityPlan(plan: CapacityPlan): Promise<void>;
}
