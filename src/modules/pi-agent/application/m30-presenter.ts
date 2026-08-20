import type { PiModelRoute, PiModelRouteSummary, PiModelUsageRecord } from "@/src/modules/pi-agent/domain/model-contracts";
import type { PiEvaluationResult, PiObservabilitySnapshot, PiRegressionAlert, PiTelemetryMetric } from "@/src/modules/pi-agent/domain/observability-contracts";
import type { PiQuotaPolicy, PiQuotaReservation, PiQuotaUsage } from "@/src/modules/pi-agent/domain/quota-contracts";

export function presentModelRoute(route: PiModelRouteSummary | PiModelRoute) {
  return {
    id: route.id,
    routeId: route.routeId,
    version: route.version,
    provider: route.provider,
    model: route.model,
    region: route.region,
    egress: route.egress,
    allowedDataClassifications: route.allowedDataClassifications,
    fallbackRouteIds: route.fallbackRouteIds,
    maxInputTokens: route.maxInputTokens,
    maxOutputTokens: route.maxOutputTokens,
    inputCostMicrosPerMillion: route.inputCostMicrosPerMillion,
    outputCostMicrosPerMillion: route.outputCostMicrosPerMillion,
    status: route.status,
    createdAt: route.createdAt,
    approvedAt: route.approvedAt,
    revokedAt: route.revokedAt,
  };
}

export function presentModelUsage(record: PiModelUsageRecord) {
  return {
    usageId: record.usageId,
    routeId: record.routeId,
    provider: record.provider,
    model: record.model,
    dataClassification: record.dataClassification,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    latencyMs: record.latencyMs,
    status: record.status,
    costMicros: record.costMicros,
    traceId: record.traceId,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    runId: record.runId,
    createdAt: record.createdAt,
  };
}

export function presentMetric(metric: PiTelemetryMetric) {
  return { id: metric.id, traceId: metric.traceId, name: metric.name, value: metric.value, unit: metric.unit, dimensions: metric.dimensions, createdAt: metric.createdAt };
}

export function presentEvaluation(result: PiEvaluationResult) {
  return { id: result.id, suiteId: result.suiteId, caseId: result.caseId, routeId: result.routeId, traceId: result.traceId, status: result.status, score: result.score, threshold: result.threshold, metricSummary: result.metricSummary, outputDigest: result.outputDigest, correctionRequired: result.correctionRequired, createdAt: result.createdAt };
}

export function presentAlert(alert: PiRegressionAlert) {
  return { id: alert.id, suiteId: alert.suiteId, metric: alert.metric, baseline: alert.baseline, observed: alert.observed, threshold: alert.threshold, severity: alert.severity, status: alert.status, createdAt: alert.createdAt };
}

export function presentObservability(snapshot: PiObservabilitySnapshot) {
  return {
    traces: snapshot.traces,
    metrics: snapshot.metrics.map(presentMetric),
    evaluations: snapshot.evaluations.map(presentEvaluation),
    alerts: snapshot.alerts.map(presentAlert),
    usage: snapshot.usage,
  };
}

export function presentQuotaUsage(usage: PiQuotaUsage) {
  return { concurrentRuns: usage.concurrentRuns, tokens: usage.tokens, costMicros: usage.costMicros, storageBytes: usage.storageBytes, toolCalls: usage.toolCalls };
}

export function presentQuotaPolicy(policy: PiQuotaPolicy) {
  return {
    id: policy.id,
    scope: policy.scope,
    scopeId: policy.scopeId,
    version: policy.version,
    maxConcurrentRuns: policy.maxConcurrentRuns,
    maxTokens: policy.maxTokens,
    maxCostMicros: policy.maxCostMicros,
    maxStorageBytes: policy.maxStorageBytes,
    maxToolCalls: policy.maxToolCalls,
    status: policy.status,
    createdAt: policy.createdAt,
  };
}

export function presentQuotaReservation(reservation: PiQuotaReservation) {
  return {
    id: reservation.id,
    runId: reservation.runId,
    scope: reservation.scope,
    scopeId: reservation.scopeId,
    policyId: reservation.policyId,
    policyVersion: reservation.policyVersion,
    reserved: presentQuotaUsage(reservation.reserved),
    consumed: presentQuotaUsage(reservation.consumed),
    status: reservation.status,
    createdAt: reservation.createdAt,
    releasedAt: reservation.releasedAt,
  };
}
