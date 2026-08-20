import type { TransactionalDatabase } from "@/src/platform/database/executor";
import type { EnterpriseIntelligenceData, EnterpriseIntelligenceRepository, Portfolio } from "@/src/modules/enterprise-intelligence/application/contracts";
import type { CapacityAllocation, CapacityPlan, ResponsibilityAssignment } from "@/src/modules/organization/domain/management-governance";
import type { GovernedObjective, MetricDefinition, MetricObservation, OperatingReview, StrategyTheme } from "@/src/modules/strategy/domain/enterprise-strategy";
import type { PerformanceFact, TalentRecord } from "@/src/modules/talent/domain/performance-evidence";

type Row = Record<string, unknown>;
const asText = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalText = (value: unknown) => value === null || value === undefined ? undefined : asText(value);
function json<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }

const mapTheme = (row: Row): StrategyTheme => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), name: asText(row.name), description: asText(row.description), ownerId: asText(row.owner_id),
  status: row.status as StrategyTheme["status"], startsAt: asText(row.starts_at).slice(0, 10), endsAt: asText(row.ends_at).slice(0, 10), version: Number(row.version),
});

const mapObjective = (row: Row): GovernedObjective => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), themeId: asText(row.theme_id), title: asText(row.title), description: asText(row.description),
  ownerId: asText(row.owner_id), objectiveType: row.objective_type as GovernedObjective["objectiveType"], status: row.status as GovernedObjective["status"],
  measurementMethod: asText(row.measurement_method), dataSource: asText(row.data_source), reviewCadence: row.review_cadence as GovernedObjective["reviewCadence"],
  startsAt: asText(row.starts_at).slice(0, 10), endsAt: asText(row.ends_at).slice(0, 10), metricIds: json<string[]>(row.metric_ids),
  projectIds: json<string[]>(row.project_ids), version: Number(row.version),
});

const mapMetric = (row: Row): MetricDefinition => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), code: asText(row.code), name: asText(row.name), description: asText(row.description), ownerId: asText(row.owner_id),
  unit: asText(row.unit), direction: row.direction as MetricDefinition["direction"], baseline: Number(row.baseline), targetValue: Number(row.target_value),
  tolerancePercent: Number(row.tolerance_percent), sourceSystem: asText(row.source_system), sourceLocator: asText(row.source_locator),
  refreshCadence: row.refresh_cadence as MetricDefinition["refreshCadence"], classification: row.classification as MetricDefinition["classification"], version: Number(row.version),
});

const mapObservation = (row: Row): MetricObservation => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), metricId: asText(row.metric_id), value: Number(row.value),
  periodStart: asText(row.period_start).slice(0, 10), periodEnd: asText(row.period_end).slice(0, 10), observedAt: asText(row.observed_at),
  sourceType: row.source_type as MetricObservation["sourceType"], sourceRef: asText(row.source_ref), evidenceRefs: json<string[]>(row.evidence_refs), recordedBy: asText(row.recorded_by),
});

const mapPortfolio = (row: Row): Portfolio => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), code: asText(row.code), name: asText(row.name), ownerId: asText(row.owner_id),
  status: row.status as Portfolio["status"], projectIds: json<string[]>(row.project_ids), investmentThesis: asText(row.investment_thesis), version: Number(row.version),
});

const mapReview = (row: Row): OperatingReview => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), title: asText(row.title), cadence: row.cadence as OperatingReview["cadence"],
  periodStart: asText(row.period_start).slice(0, 10), periodEnd: asText(row.period_end).slice(0, 10), ownerId: asText(row.owner_id), status: row.status as OperatingReview["status"],
  facts: json<OperatingReview["facts"]>(row.facts), inferences: json<OperatingReview["inferences"]>(row.inferences), decisions: json<string[]>(row.decisions),
  excludedDataScopes: json<string[]>(row.excluded_data_scopes), confirmedBy: optionalText(row.confirmed_by), confirmedAt: optionalText(row.confirmed_at), version: Number(row.version),
});

const mapResponsibility = (row: Row): ResponsibilityAssignment => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), resourceType: row.resource_type as ResponsibilityAssignment["resourceType"], resourceId: asText(row.resource_id),
  subjectType: row.subject_type as ResponsibilityAssignment["subjectType"], subjectId: asText(row.subject_id), role: row.role as ResponsibilityAssignment["role"],
  startsAt: asText(row.starts_at), endsAt: optionalText(row.ends_at), version: Number(row.version),
});

const mapCapacity = (row: Row): CapacityPlan => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), userId: asText(row.user_id), periodStart: asText(row.period_start).slice(0, 10), periodEnd: asText(row.period_end).slice(0, 10),
  availableHours: Number(row.available_hours), allocations: json<CapacityAllocation[]>(row.allocations), includedSignals: json<string[]>(row.included_signals), version: Number(row.version),
});

const mapPerformanceFact = (row: Row): PerformanceFact => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), subjectUserId: asText(row.subject_user_id), sourceType: row.source_type as PerformanceFact["sourceType"],
  sourceId: asText(row.source_id), statement: asText(row.statement), evidenceRefs: json<string[]>(row.evidence_refs), factType: row.fact_type as PerformanceFact["factType"],
  effectiveAt: asText(row.effective_at), classification: row.classification as PerformanceFact["classification"], visibleToIds: json<string[]>(row.visible_to_ids),
});

const mapTalentRecord = (row: Row): TalentRecord => ({
  id: asText(row.id), tenantId: asText(row.tenant_id), subjectUserId: asText(row.subject_user_id), recordType: row.record_type as TalentRecord["recordType"],
  content: asText(row.content), participantIds: json<string[]>(row.participant_ids), agentEligible: Boolean(row.agent_eligible),
  classification: row.classification as TalentRecord["classification"], effectiveAt: asText(row.effective_at),
});

export class PostgresEnterpriseIntelligenceRepository implements EnterpriseIntelligenceRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getData(tenantId: string): Promise<EnterpriseIntelligenceData> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [themes, objectives, metrics, observations, portfolios, reviews, responsibilities, capacity, performanceFacts, talentRecords] = await Promise.all([
        executor.query("SELECT * FROM strategy_themes WHERE tenant_id=$1 ORDER BY starts_at DESC,id", [tenantId]),
        executor.query(
          `SELECT o.*,g.theme_id,g.objective_type,g.measurement_method,g.data_source,
             COALESCE((SELECT jsonb_agg(om.metric_id ORDER BY om.metric_id) FROM objective_metric_links om WHERE om.tenant_id=o.tenant_id AND om.objective_id=o.id),'[]'::jsonb) AS metric_ids,
             COALESCE((SELECT jsonb_agg(op.project_id ORDER BY op.project_id) FROM objective_project_links op WHERE op.tenant_id=o.tenant_id AND op.objective_id=o.id),'[]'::jsonb) AS project_ids
           FROM objectives o JOIN objective_governance_profiles g ON g.tenant_id=o.tenant_id AND g.objective_id=o.id
           WHERE o.tenant_id=$1 ORDER BY o.ends_at,o.id`, [tenantId],
        ),
        executor.query("SELECT * FROM metric_definitions WHERE tenant_id=$1 ORDER BY code", [tenantId]),
        executor.query("SELECT * FROM metric_observations WHERE tenant_id=$1 ORDER BY observed_at,id", [tenantId]),
        executor.query(
          `SELECT p.*,COALESCE((SELECT jsonb_agg(pp.project_id ORDER BY pp.priority,pp.project_id) FROM portfolio_projects pp WHERE pp.tenant_id=p.tenant_id AND pp.portfolio_id=p.id),'[]'::jsonb) AS project_ids
           FROM portfolios p WHERE p.tenant_id=$1 ORDER BY p.code`, [tenantId],
        ),
        executor.query("SELECT * FROM operating_reviews WHERE tenant_id=$1 ORDER BY period_end DESC,id", [tenantId]),
        executor.query("SELECT * FROM responsibility_assignments WHERE tenant_id=$1 ORDER BY resource_type,resource_id,role,id", [tenantId]),
        executor.query("SELECT * FROM capacity_plans WHERE tenant_id=$1 ORDER BY period_start DESC,user_id", [tenantId]),
        executor.query("SELECT * FROM performance_facts WHERE tenant_id=$1 ORDER BY effective_at DESC,id", [tenantId]),
        executor.query("SELECT * FROM talent_records WHERE tenant_id=$1 ORDER BY effective_at DESC,id", [tenantId]),
      ]);
      return {
        themes: themes.map(mapTheme), objectives: objectives.map(mapObjective), metrics: metrics.map(mapMetric), observations: observations.map(mapObservation),
        portfolios: portfolios.map(mapPortfolio), reviews: reviews.map(mapReview), responsibilities: responsibilities.map(mapResponsibility), capacityPlans: capacity.map(mapCapacity),
        performanceFacts: performanceFacts.map(mapPerformanceFact), talentRecords: talentRecords.map(mapTalentRecord), generatedAt: new Date().toISOString(),
      };
    });
  }

  async getMetric(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM metric_definitions WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapMetric(rows[0]) : null;
    });
  }

  async saveObservation(observation: MetricObservation) {
    await this.database.withTenant(observation.tenantId, (executor) => executor.query(
      `INSERT INTO metric_observations(id,tenant_id,metric_id,value,period_start,period_end,observed_at,source_type,source_ref,evidence_refs,recorded_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [observation.id,observation.tenantId,observation.metricId,observation.value,observation.periodStart,observation.periodEnd,observation.observedAt,observation.sourceType,observation.sourceRef,observation.evidenceRefs,observation.recordedBy],
    ).then(() => undefined));
  }

  async getReview(tenantId: string, id: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query("SELECT * FROM operating_reviews WHERE tenant_id=$1 AND id=$2", [tenantId,id]);
      return rows[0] ? mapReview(rows[0]) : null;
    });
  }

  async saveReview(review: OperatingReview, expectedVersion: number) {
    return this.database.withTenant(review.tenantId, async (executor) => {
      const rows = await executor.query(
        `UPDATE operating_reviews SET title=$3,status=$4,facts=$5,inferences=$6,decisions=$7,excluded_data_scopes=$8,confirmed_by=$9,confirmed_at=$10,version=$11,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND version=$12 RETURNING id`,
        [review.tenantId,review.id,review.title,review.status,review.facts,review.inferences,review.decisions,review.excludedDataScopes,review.confirmedBy ?? null,review.confirmedAt ?? null,review.version,expectedVersion],
      );
      return rows.length === 1;
    });
  }

  async replaceResponsibilities(tenantId: string, resourceType: ResponsibilityAssignment["resourceType"], resourceId: string, assignments: ResponsibilityAssignment[]) {
    await this.database.withTenant(tenantId, async (executor) => {
      await executor.query("DELETE FROM responsibility_assignments WHERE tenant_id=$1 AND resource_type=$2 AND resource_id=$3", [tenantId,resourceType,resourceId]);
      for (const item of assignments) await executor.query(
        `INSERT INTO responsibility_assignments(id,tenant_id,resource_type,resource_id,subject_type,subject_id,role,starts_at,ends_at,version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [item.id,item.tenantId,item.resourceType,item.resourceId,item.subjectType,item.subjectId,item.role,item.startsAt,item.endsAt ?? null,item.version],
      );
    });
  }

  async saveCapacityPlan(plan: CapacityPlan) {
    await this.database.withTenant(plan.tenantId, (executor) => executor.query(
      `INSERT INTO capacity_plans(id,tenant_id,user_id,period_start,period_end,available_hours,allocations,included_signals,version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(tenant_id,user_id,period_start,period_end) DO UPDATE SET available_hours=EXCLUDED.available_hours,allocations=EXCLUDED.allocations,included_signals=EXCLUDED.included_signals,version=capacity_plans.version+1,updated_at=now()`,
      [plan.id,plan.tenantId,plan.userId,plan.periodStart,plan.periodEnd,plan.availableHours,plan.allocations,plan.includedSignals,plan.version],
    ).then(() => undefined));
  }
}
