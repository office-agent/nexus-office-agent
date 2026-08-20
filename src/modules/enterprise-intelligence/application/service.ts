import { randomUUID } from "node:crypto";
import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import type { EventStore } from "@/src/modules/events/application/event-store";
import { createDomainEvent } from "@/src/modules/events/domain/event-envelope";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { EnterpriseIntelligenceRepository } from "@/src/modules/enterprise-intelligence/application/contracts";
import { assertRaci, capacityStatus, type CapacityPlan, type ResponsibilityAssignment } from "@/src/modules/organization/domain/management-governance";
import { confirmOperatingReview, metricHealth, metricProgress, type MetricObservation } from "@/src/modules/strategy/domain/enterprise-strategy";
import { buildTalentEvidencePack } from "@/src/modules/talent/domain/performance-evidence";

function requirePolicy(context: RequestContext, action: "read" | "create" | "update" | "approve" | "admin", type: string, id: string, ownerId?: string) {
  const result = evaluateAccess({ context, action, resource: { tenantId: context.tenantId, type, id, ownerId } });
  if (!result.allowed) throw new Error(`POLICY_DENIED:${result.reason}`);
}

export class EnterpriseIntelligenceService {
  constructor(private readonly repository: EnterpriseIntelligenceRepository, private readonly events: EventStore) {}

  async workspace(context: RequestContext) {
    requirePolicy(context, "read", "enterprise_intelligence", "workspace");
    const data = await this.repository.getData(context.tenantId);
    const latestByMetric = new Map<string, MetricObservation>();
    for (const observation of [...data.observations].sort((left, right) => left.observedAt.localeCompare(right.observedAt))) latestByMetric.set(observation.metricId, observation);
    return {
      themes: data.themes,
      objectives: data.objectives.map((objective) => {
        const metricStates = objective.metricIds.map((metricId) => {
          const metric = data.metrics.find(({ id }) => id === metricId);
          const observation = latestByMetric.get(metricId);
          return metric && observation ? { metric, observation, progress: metricProgress(metric, observation.value), health: metricHealth(metric, observation.value) } : null;
        }).filter((item): item is NonNullable<typeof item> => Boolean(item));
        const progress = metricStates.length ? metricStates.reduce((sum, item) => sum + (item.progress ?? 0), 0) / metricStates.length : null;
        return { ...objective, metricStates, progress };
      }),
      metrics: data.metrics.map((metric) => {
        const observation = latestByMetric.get(metric.id);
        return { ...metric, latestObservation: observation, health: observation ? metricHealth(metric, observation.value) : "unknown" };
      }),
      portfolios: data.portfolios,
      reviews: data.reviews,
      responsibilities: data.responsibilities,
      capacity: data.capacityPlans.map((plan) => ({ ...plan, ...capacityStatus(plan) })),
      talent: {
        factCount: data.performanceFacts.filter(({ visibleToIds }) => visibleToIds.includes(context.actorId)).length,
        protectedRecordCount: data.talentRecords.filter(({ recordType, agentEligible, participantIds }) => participantIds.includes(context.actorId) && (recordType === "one_to_one" || !agentEligible)).length,
        policy: "AI 只整理证据，不评分、不排名、不作雇佣决定",
      },
      generatedAt: data.generatedAt,
    };
  }

  async recordMetricObservation(context: RequestContext, metricId: string, input: Omit<MetricObservation, "id" | "tenantId" | "metricId" | "recordedBy">) {
    const metric = await this.repository.getMetric(context.tenantId, metricId);
    if (!metric) throw new Error("METRIC_NOT_FOUND");
    requirePolicy(context, "update", "metric", metric.id, metric.ownerId);
    if (!input.sourceRef.trim() || input.evidenceRefs.length === 0) throw new Error("METRIC_EVIDENCE_REQUIRED");
    const observation: MetricObservation = { ...input, id: randomUUID(), tenantId: context.tenantId, metricId, recordedBy: context.actorId };
    await this.repository.saveObservation(observation);
    await this.events.appendOutbox(createDomainEvent({
      type: "metric.observed", version: 1, tenantId: context.tenantId,
      aggregateType: "metric", aggregateId: metric.id, aggregateVersion: metric.version,
      actor: { type: "user", id: context.actorId }, traceId: context.traceId,
      payload: { observationId: observation.id, value: observation.value, sourceType: observation.sourceType, evidenceRefs: observation.evidenceRefs },
    }));
    return { observation, health: metricHealth(metric, observation.value), progress: metricProgress(metric, observation.value) };
  }

  async prepareOperatingInsight(context: RequestContext) {
    requirePolicy(context, "read", "enterprise_intelligence", "insight");
    const workspace = await this.workspace(context);
    const facts = workspace.metrics.flatMap((metric) => metric.latestObservation ? [{
      statement: `${metric.name} 当前为 ${metric.latestObservation.value}${metric.unit}`,
      evidenceRefs: [metric.latestObservation.sourceRef, ...metric.latestObservation.evidenceRefs],
      metricId: metric.id,
    }] : []);
    const inferences = workspace.metrics.filter(({ health }) => health === "at_risk" || health === "watch").map((metric) => ({
      statement: `${metric.name} ${metric.health === "at_risk" ? "明显偏离" : "接近预警线"}，建议由指标 Owner 结合项目风险复核。`,
      confidence: metric.latestObservation?.sourceType === "authoritative" ? 0.86 : 0.72,
      evidenceRefs: metric.latestObservation ? [metric.latestObservation.sourceRef] : [],
      type: "inference" as const,
    }));
    return {
      facts,
      inferences,
      proposals: inferences.map(({ statement }) => ({ statement, requiresHumanDecision: true })),
      usedDataScopes: ["strategy", "metric", "portfolio", "project-risk"],
      excludedDataScopes: ["one_to_one", "talent_label", "private_chat", "online_time", "message_count"],
      stateChanged: false as const,
    };
  }

  async confirmReview(context: RequestContext, reviewId: string, version: number) {
    const current = await this.repository.getReview(context.tenantId, reviewId);
    if (!current) throw new Error("OPERATING_REVIEW_NOT_FOUND");
    requirePolicy(context, "approve", "operating_review", current.id, current.ownerId);
    const confirmed = confirmOperatingReview(current, context.actorId, version);
    if (!(await this.repository.saveReview(confirmed, current.version))) throw new Error("OPERATING_REVIEW_VERSION_CONFLICT");
    await this.events.appendOutbox(createDomainEvent({
      type: "operating_review.confirmed", version: 1, tenantId: context.tenantId,
      aggregateType: "operating_review", aggregateId: confirmed.id, aggregateVersion: confirmed.version,
      actor: { type: "user", id: context.actorId }, traceId: context.traceId,
      payload: { periodStart: confirmed.periodStart, periodEnd: confirmed.periodEnd },
    }));
    return confirmed;
  }

  async replaceResponsibilities(context: RequestContext, resourceType: ResponsibilityAssignment["resourceType"], resourceId: string, input: Array<Omit<ResponsibilityAssignment, "id" | "tenantId" | "resourceType" | "resourceId" | "version">>) {
    requirePolicy(context, "admin", "responsibility", resourceId);
    const assignments = input.map<ResponsibilityAssignment>((item) => ({ ...item, id: randomUUID(), tenantId: context.tenantId, resourceType, resourceId, version: 1 }));
    assertRaci(assignments);
    await this.repository.replaceResponsibilities(context.tenantId, resourceType, resourceId, assignments);
    return assignments;
  }

  async saveCapacityPlan(context: RequestContext, input: Omit<CapacityPlan, "id" | "tenantId" | "version">) {
    requirePolicy(context, "admin", "capacity_plan", input.userId);
    const plan: CapacityPlan = { ...input, id: randomUUID(), tenantId: context.tenantId, version: 1 };
    const status = capacityStatus(plan);
    await this.repository.saveCapacityPlan(plan);
    return { plan, ...status };
  }

  async prepareTalentEvidence(context: RequestContext, subjectUserId: string, purpose: "development_conversation" | "performance_review") {
    requirePolicy(context, "read", "talent_evidence", subjectUserId);
    const data = await this.repository.getData(context.tenantId);
    return buildTalentEvidencePack({ subjectUserId, purpose, facts: data.performanceFacts, records: data.talentRecords, actorId: context.actorId });
  }
}
