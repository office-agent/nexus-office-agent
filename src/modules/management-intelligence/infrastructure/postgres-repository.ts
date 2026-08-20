import type { ManagementIntelligenceData, ManagementIntelligenceRepository } from "@/src/modules/management-intelligence/application/contracts";
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
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";

type Row = Record<string, unknown>;
const text = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalText = (value: unknown) => value === null || value === undefined ? undefined : text(value);
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

const mapCadence = (row: Row): ManagementCadence => ({
  id: text(row.id), tenantId: text(row.tenant_id), name: text(row.name), cadenceType: row.cadence_type as ManagementCadence["cadenceType"],
  frequency: row.frequency as ManagementCadence["frequency"], timezone: text(row.timezone), ownerId: text(row.owner_id),
  participantRoleIds: json<string[]>(row.participant_role_ids), agendaTemplate: json<string[]>(row.agenda_template), evidenceRequirements: json<string[]>(row.evidence_requirements),
  status: row.status as ManagementCadence["status"], nextOccurrenceAt: text(row.next_occurrence_at), version: Number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});

const mapOccurrence = (row: Row): CadenceOccurrence => ({
  id: text(row.id), tenantId: text(row.tenant_id), cadenceId: text(row.cadence_id), scheduledStartAt: text(row.scheduled_start_at), scheduledEndAt: text(row.scheduled_end_at),
  status: row.status as CadenceOccurrence["status"], briefing: row.briefing === null || row.briefing === undefined ? undefined : json<CadenceOccurrence["briefing"]>(row.briefing),
  outcomeEvidenceRefs: json<string[]>(row.outcome_evidence_refs), acknowledgedByIds: json<string[]>(row.acknowledged_by_ids), version: Number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});

const mapMetricProfile = (row: Row): MetricSemanticProfile => ({
  id: text(row.id), tenantId: text(row.tenant_id), metricId: text(row.metric_id), businessDefinition: text(row.business_definition), formula: text(row.formula),
  ownerId: text(row.owner_id), stewardId: text(row.steward_id), authoritativeSource: text(row.authoritative_source), sourceLocator: text(row.source_locator),
  refreshCadence: row.refresh_cadence as MetricSemanticProfile["refreshCadence"], freshnessSlaMinutes: Number(row.freshness_sla_minutes), dimensions: json<string[]>(row.dimensions),
  allowedUses: json<string[]>(row.allowed_uses), prohibitedUses: json<string[]>(row.prohibited_uses), version: Number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});

const mapMetricQuality = (row: Row): MetricQualityCheck => ({
  id: text(row.id), tenantId: text(row.tenant_id), metricId: text(row.metric_id), status: row.status as MetricQualityCheck["status"], observedAt: optionalText(row.observed_at),
  freshnessMinutes: row.freshness_minutes === null || row.freshness_minutes === undefined ? undefined : Number(row.freshness_minutes), completenessPercent: Number(row.completeness_percent),
  evidenceRefs: json<string[]>(row.evidence_refs), checkedBy: text(row.checked_by), checkedAt: text(row.checked_at),
});

const mapScenario = (row: Row): PortfolioScenario => ({
  id: text(row.id), tenantId: text(row.tenant_id), portfolioId: text(row.portfolio_id), name: text(row.name), assumptions: json<string[]>(row.assumptions),
  projectDecisions: json<PortfolioScenario["projectDecisions"]>(row.project_decisions), expectedBenefit: Number(row.expected_benefit), estimatedCost: Number(row.estimated_cost), riskScore: Number(row.risk_score),
  evidenceRefs: json<string[]>(row.evidence_refs), status: row.status as PortfolioScenario["status"], createdBy: text(row.created_by), selectedBy: optionalText(row.selected_by), selectedAt: optionalText(row.selected_at),
  version: Number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});

const mapCase = (row: Row): EnterpriseCase => ({
  id: text(row.id), tenantId: text(row.tenant_id), code: text(row.code), caseType: row.case_type as EnterpriseCase["caseType"], title: text(row.title), description: text(row.description),
  severity: row.severity as EnterpriseCase["severity"], status: row.status as EnterpriseCase["status"], ownerId: optionalText(row.owner_id), dueAt: text(row.due_at), slaMinutes: Number(row.sla_minutes),
  sourceType: row.source_type as EnterpriseCase["sourceType"], sourceRef: text(row.source_ref), relatedObjectRefs: json<string[]>(row.related_object_refs), evidenceRefs: json<string[]>(row.evidence_refs),
  createdBy: text(row.created_by), resolvedAt: optionalText(row.resolved_at), version: Number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});

const mapEvaluation = (row: Row): AiGovernanceEvaluation => ({
  id: text(row.id), tenantId: text(row.tenant_id), capabilityId: text(row.capability_id), agentRunId: optionalText(row.agent_run_id), provider: text(row.provider), model: text(row.model),
  promptVersion: text(row.prompt_version), datasetRef: text(row.dataset_ref), outcome: row.outcome as AiGovernanceEvaluation["outcome"], scores: json<AiGovernanceEvaluation["scores"]>(row.scores),
  inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), latencyMs: Number(row.latency_ms), costMicrounits: Number(row.cost_microunits), evidenceRefs: json<string[]>(row.evidence_refs),
  evaluatedBy: text(row.evaluated_by), evaluatedAt: text(row.evaluated_at),
});

const mapChannelAction = (row: Row): ManagementChannelAction => ({
  id: text(row.id), tenantId: text(row.tenant_id), actionType: row.action_type as ManagementChannelAction["actionType"], resourceType: row.resource_type as ManagementChannelAction["resourceType"],
  resourceId: text(row.resource_id), expectedVersion: Number(row.expected_version), proposalHash: text(row.proposal_hash), expiresAt: text(row.expires_at), status: row.status as ManagementChannelAction["status"],
  connectionId: text(row.connection_id), recipientDigest: text(row.recipient_digest), createdBy: text(row.created_by), executedBy: optionalText(row.executed_by), executedAt: optionalText(row.executed_at),
  resultDigest: optionalText(row.result_digest), version: Number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});

export class PostgresManagementIntelligenceRepository implements ManagementIntelligenceRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getData(tenantId: string): Promise<ManagementIntelligenceData> {
    return this.database.withTenant(tenantId, async (db) => {
      const [cadences, occurrences, profiles, checks, scenarios, cases, evaluations, actions] = await Promise.all([
        db.query("SELECT * FROM management_cadences WHERE tenant_id=$1 ORDER BY next_occurrence_at,id", [tenantId]),
        db.query("SELECT * FROM cadence_occurrences WHERE tenant_id=$1 ORDER BY scheduled_start_at,id", [tenantId]),
        db.query("SELECT * FROM metric_semantic_profiles WHERE tenant_id=$1 ORDER BY updated_at DESC,id", [tenantId]),
        db.query("SELECT * FROM metric_quality_checks WHERE tenant_id=$1 ORDER BY checked_at DESC,id", [tenantId]),
        db.query("SELECT * FROM portfolio_scenarios WHERE tenant_id=$1 ORDER BY updated_at DESC,id", [tenantId]),
        db.query("SELECT * FROM enterprise_cases WHERE tenant_id=$1 ORDER BY due_at,id", [tenantId]),
        db.query("SELECT * FROM ai_governance_evaluations WHERE tenant_id=$1 ORDER BY evaluated_at DESC,id", [tenantId]),
        db.query("SELECT * FROM management_channel_actions WHERE tenant_id=$1 ORDER BY created_at DESC,id", [tenantId]),
      ]);
      return {
        cadences: cadences.map(mapCadence), occurrences: occurrences.map(mapOccurrence), metricProfiles: profiles.map(mapMetricProfile), metricQualityChecks: checks.map(mapMetricQuality),
        scenarios: scenarios.map(mapScenario), cases: cases.map(mapCase), evaluations: evaluations.map(mapEvaluation), channelActions: actions.map(mapChannelAction), generatedAt: new Date().toISOString(),
      };
    });
  }

  async getCadence(tenantId: string, id: string) { return this.one(tenantId, "SELECT * FROM management_cadences WHERE tenant_id=$1 AND id=$2", id, mapCadence); }
  async saveCadence(value: ManagementCadence) {
    await this.database.withTenant(value.tenantId, (db) => db.query(
      `INSERT INTO management_cadences(id,tenant_id,name,cadence_type,frequency,timezone,owner_id,participant_role_ids,agenda_template,evidence_requirements,status,next_occurrence_at,version,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [value.id,value.tenantId,value.name,value.cadenceType,value.frequency,value.timezone,value.ownerId,value.participantRoleIds,value.agendaTemplate,value.evidenceRequirements,value.status,value.nextOccurrenceAt,value.version,value.createdAt,value.updatedAt],
    ).then(() => undefined));
  }

  async getOccurrence(tenantId: string, id: string) { return this.one(tenantId, "SELECT * FROM cadence_occurrences WHERE tenant_id=$1 AND id=$2", id, mapOccurrence); }
  async saveOccurrence(value: CadenceOccurrence, expectedVersion?: number) {
    return this.database.withTenant(value.tenantId, async (db) => {
      const rows = expectedVersion === undefined
        ? await db.query(`INSERT INTO cadence_occurrences(id,tenant_id,cadence_id,scheduled_start_at,scheduled_end_at,status,briefing,outcome_evidence_refs,acknowledged_by_ids,version,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`, [value.id,value.tenantId,value.cadenceId,value.scheduledStartAt,value.scheduledEndAt,value.status,value.briefing ?? null,value.outcomeEvidenceRefs,value.acknowledgedByIds,value.version,value.createdAt,value.updatedAt])
        : await db.query(`UPDATE cadence_occurrences SET status=$3,briefing=$4,outcome_evidence_refs=$5,acknowledged_by_ids=$6,version=$7,updated_at=$8
            WHERE tenant_id=$1 AND id=$2 AND version=$9 RETURNING id`, [value.tenantId,value.id,value.status,value.briefing ?? null,value.outcomeEvidenceRefs,value.acknowledgedByIds,value.version,value.updatedAt,expectedVersion]);
      return rows.length === 1;
    });
  }

  async getMetricProfile(tenantId: string, metricId: string) { return this.one(tenantId, "SELECT * FROM metric_semantic_profiles WHERE tenant_id=$1 AND metric_id=$2", metricId, mapMetricProfile); }
  async metricExists(tenantId: string, metricId: string) { return this.exists(tenantId, "SELECT id FROM metric_definitions WHERE tenant_id=$1 AND id=$2", metricId); }
  async saveMetricProfile(value: MetricSemanticProfile, expectedVersion?: number) {
    return this.database.withTenant(value.tenantId, async (db) => {
      const rows = expectedVersion === undefined
        ? await db.query(`INSERT INTO metric_semantic_profiles(id,tenant_id,metric_id,business_definition,formula,owner_id,steward_id,authoritative_source,source_locator,refresh_cadence,freshness_sla_minutes,dimensions,allowed_uses,prohibited_uses,version,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING RETURNING id`, [value.id,value.tenantId,value.metricId,value.businessDefinition,value.formula,value.ownerId,value.stewardId,value.authoritativeSource,value.sourceLocator,value.refreshCadence,value.freshnessSlaMinutes,value.dimensions,value.allowedUses,value.prohibitedUses,value.version,value.createdAt,value.updatedAt])
        : await db.query(`UPDATE metric_semantic_profiles SET business_definition=$3,formula=$4,owner_id=$5,steward_id=$6,authoritative_source=$7,source_locator=$8,refresh_cadence=$9,freshness_sla_minutes=$10,dimensions=$11,allowed_uses=$12,prohibited_uses=$13,version=$14,updated_at=$15
            WHERE tenant_id=$1 AND metric_id=$2 AND version=$16 RETURNING id`, [value.tenantId,value.metricId,value.businessDefinition,value.formula,value.ownerId,value.stewardId,value.authoritativeSource,value.sourceLocator,value.refreshCadence,value.freshnessSlaMinutes,value.dimensions,value.allowedUses,value.prohibitedUses,value.version,value.updatedAt,expectedVersion]);
      return rows.length === 1;
    });
  }
  async saveMetricQualityCheck(value: MetricQualityCheck) {
    await this.database.withTenant(value.tenantId, (db) => db.query(
      `INSERT INTO metric_quality_checks(id,tenant_id,metric_id,status,observed_at,freshness_minutes,completeness_percent,evidence_refs,checked_by,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [value.id,value.tenantId,value.metricId,value.status,value.observedAt ?? null,value.freshnessMinutes ?? null,value.completenessPercent,value.evidenceRefs,value.checkedBy,value.checkedAt],
    ).then(() => undefined));
  }

  async portfolioExists(tenantId: string, portfolioId: string) { return this.exists(tenantId, "SELECT id FROM portfolios WHERE tenant_id=$1 AND id=$2", portfolioId); }
  async saveScenario(value: PortfolioScenario) {
    await this.database.withTenant(value.tenantId, (db) => db.query(
      `INSERT INTO portfolio_scenarios(id,tenant_id,portfolio_id,name,assumptions,project_decisions,expected_benefit,estimated_cost,risk_score,evidence_refs,status,created_by,selected_by,selected_at,version,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [value.id,value.tenantId,value.portfolioId,value.name,value.assumptions,value.projectDecisions,value.expectedBenefit,value.estimatedCost,value.riskScore,value.evidenceRefs,value.status,value.createdBy,value.selectedBy ?? null,value.selectedAt ?? null,value.version,value.createdAt,value.updatedAt],
    ).then(() => undefined));
  }
  async getScenario(tenantId: string, id: string) { return this.one(tenantId, "SELECT * FROM portfolio_scenarios WHERE tenant_id=$1 AND id=$2", id, mapScenario); }
  async selectScenario(value: PortfolioScenario, expectedVersion: number) {
    return this.database.withTenant(value.tenantId, async (db) => {
      const locked = await db.query("SELECT id FROM portfolio_scenarios WHERE tenant_id=$1 AND id=$2 AND version=$3 FOR UPDATE", [value.tenantId,value.id,expectedVersion]);
      if (locked.length !== 1) return false;
      await db.query("UPDATE portfolio_scenarios SET status='superseded',version=version+1,updated_at=$3 WHERE tenant_id=$1 AND portfolio_id=$2 AND status='selected' AND id<>$4", [value.tenantId,value.portfolioId,value.updatedAt,value.id]);
      const rows = await db.query(`UPDATE portfolio_scenarios SET status='selected',selected_by=$3,selected_at=$4,version=$5,updated_at=$6 WHERE tenant_id=$1 AND id=$2 AND version=$7 RETURNING id`, [value.tenantId,value.id,value.selectedBy ?? null,value.selectedAt ?? null,value.version,value.updatedAt,expectedVersion]);
      return rows.length === 1;
    });
  }

  async saveCase(value: EnterpriseCase) {
    await this.database.withTenant(value.tenantId, (db) => db.query(
      `INSERT INTO enterprise_cases(id,tenant_id,code,case_type,title,description,severity,status,owner_id,due_at,sla_minutes,source_type,source_ref,related_object_refs,evidence_refs,created_by,resolved_at,version,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [value.id,value.tenantId,value.code,value.caseType,value.title,value.description,value.severity,value.status,value.ownerId ?? null,value.dueAt,value.slaMinutes,value.sourceType,value.sourceRef,value.relatedObjectRefs,value.evidenceRefs,value.createdBy,value.resolvedAt ?? null,value.version,value.createdAt,value.updatedAt],
    ).then(() => undefined));
  }
  async getCase(tenantId: string, id: string) { return this.one(tenantId, "SELECT * FROM enterprise_cases WHERE tenant_id=$1 AND id=$2", id, mapCase); }
  async updateCase(value: EnterpriseCase, expectedVersion: number) {
    return this.database.withTenant(value.tenantId, async (db) => (await db.query(
      `UPDATE enterprise_cases SET status=$3,owner_id=$4,evidence_refs=$5,resolved_at=$6,version=$7,updated_at=$8 WHERE tenant_id=$1 AND id=$2 AND version=$9 RETURNING id`,
      [value.tenantId,value.id,value.status,value.ownerId ?? null,value.evidenceRefs,value.resolvedAt ?? null,value.version,value.updatedAt,expectedVersion],
    )).length === 1);
  }

  async saveEvaluation(value: AiGovernanceEvaluation) {
    await this.database.withTenant(value.tenantId, (db) => db.query(
      `INSERT INTO ai_governance_evaluations(id,tenant_id,capability_id,agent_run_id,provider,model,prompt_version,dataset_ref,outcome,scores,input_tokens,output_tokens,latency_ms,cost_microunits,evidence_refs,evaluated_by,evaluated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [value.id,value.tenantId,value.capabilityId,value.agentRunId ?? null,value.provider,value.model,value.promptVersion,value.datasetRef,value.outcome,value.scores,value.inputTokens,value.outputTokens,value.latencyMs,value.costMicrounits,value.evidenceRefs,value.evaluatedBy,value.evaluatedAt],
    ).then(() => undefined));
  }
  async isWecomConnectionActive(tenantId: string, connectionId: string) { return this.exists(tenantId, "SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 AND provider='wecom' AND status='active'", connectionId); }

  async saveChannelAction(value: ManagementChannelAction) {
    await this.database.withTenant(value.tenantId, (db) => db.query(
      `INSERT INTO management_channel_actions(id,tenant_id,action_type,resource_type,resource_id,expected_version,proposal_hash,expires_at,status,connection_id,recipient_digest,created_by,executed_by,executed_at,result_digest,version,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [value.id,value.tenantId,value.actionType,value.resourceType,value.resourceId,value.expectedVersion,value.proposalHash,value.expiresAt,value.status,value.connectionId,value.recipientDigest,value.createdBy,value.executedBy ?? null,value.executedAt ?? null,value.resultDigest ?? null,value.version,value.createdAt,value.updatedAt],
    ).then(() => undefined));
  }
  async getChannelAction(tenantId: string, id: string) { return this.one(tenantId, "SELECT * FROM management_channel_actions WHERE tenant_id=$1 AND id=$2", id, mapChannelAction); }
  async updateChannelAction(value: ManagementChannelAction, expectedVersion: number) {
    return this.database.withTenant(value.tenantId, async (db) => (await db.query(
      `UPDATE management_channel_actions SET status=$3,executed_by=$4,executed_at=$5,result_digest=$6,version=$7,updated_at=$8 WHERE tenant_id=$1 AND id=$2 AND version=$9 RETURNING id`,
      [value.tenantId,value.id,value.status,value.executedBy ?? null,value.executedAt ?? null,value.resultDigest ?? null,value.version,value.updatedAt,expectedVersion],
    )).length === 1);
  }

  async executeCaseChannelAction(input: { action: ManagementChannelAction; enterpriseCase: EnterpriseCase; expectedActionVersion: number; expectedResourceVersion: number }) {
    return this.database.withTenant(input.action.tenantId, async (db) => {
      if (!(await this.lockActionAndResource(db, input.action.tenantId, input.action.id, input.expectedActionVersion, "enterprise_cases", input.enterpriseCase.id, input.expectedResourceVersion))) return false;
      await db.query(`UPDATE enterprise_cases SET status=$3,owner_id=$4,evidence_refs=$5,resolved_at=$6,version=$7,updated_at=$8 WHERE tenant_id=$1 AND id=$2`, [input.enterpriseCase.tenantId,input.enterpriseCase.id,input.enterpriseCase.status,input.enterpriseCase.ownerId ?? null,input.enterpriseCase.evidenceRefs,input.enterpriseCase.resolvedAt ?? null,input.enterpriseCase.version,input.enterpriseCase.updatedAt]);
      await this.executeActionRow(db, input.action);
      return true;
    });
  }

  async executeOccurrenceChannelAction(input: { action: ManagementChannelAction; occurrence: CadenceOccurrence; expectedActionVersion: number; expectedResourceVersion: number }) {
    return this.database.withTenant(input.action.tenantId, async (db) => {
      if (!(await this.lockActionAndResource(db, input.action.tenantId, input.action.id, input.expectedActionVersion, "cadence_occurrences", input.occurrence.id, input.expectedResourceVersion))) return false;
      await db.query(`UPDATE cadence_occurrences SET status=$3,briefing=$4,outcome_evidence_refs=$5,acknowledged_by_ids=$6,version=$7,updated_at=$8 WHERE tenant_id=$1 AND id=$2`, [input.occurrence.tenantId,input.occurrence.id,input.occurrence.status,input.occurrence.briefing ?? null,input.occurrence.outcomeEvidenceRefs,input.occurrence.acknowledgedByIds,input.occurrence.version,input.occurrence.updatedAt]);
      await this.executeActionRow(db, input.action);
      return true;
    });
  }

  private async lockActionAndResource(db: DatabaseExecutor, tenantId: string, actionId: string, actionVersion: number, table: "enterprise_cases" | "cadence_occurrences", resourceId: string, resourceVersion: number) {
    const actions = await db.query("SELECT id FROM management_channel_actions WHERE tenant_id=$1 AND id=$2 AND version=$3 AND status='pending' FOR UPDATE", [tenantId,actionId,actionVersion]);
    if (actions.length !== 1) return false;
    const resources = await db.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=$2 AND version=$3 FOR UPDATE`, [tenantId,resourceId,resourceVersion]);
    return resources.length === 1;
  }

  private async executeActionRow(db: DatabaseExecutor, value: ManagementChannelAction) {
    await db.query(`UPDATE management_channel_actions SET status=$3,executed_by=$4,executed_at=$5,result_digest=$6,version=$7,updated_at=$8 WHERE tenant_id=$1 AND id=$2`, [value.tenantId,value.id,value.status,value.executedBy ?? null,value.executedAt ?? null,value.resultDigest ?? null,value.version,value.updatedAt]);
  }

  private async one<T>(tenantId: string, sql: string, id: string, mapper: (row: Row) => T): Promise<T | null> {
    return this.database.withTenant(tenantId, async (db) => { const rows = await db.query(sql, [tenantId,id]); return rows[0] ? mapper(rows[0]) : null; });
  }
  private async exists(tenantId: string, sql: string, id: string) { return this.database.withTenant(tenantId, async (db) => (await db.query(sql, [tenantId,id])).length === 1); }
}
