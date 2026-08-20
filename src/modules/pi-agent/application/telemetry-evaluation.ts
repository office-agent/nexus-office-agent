import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import type { PiModelUsageRecord } from "@/src/modules/pi-agent/domain/model-contracts";
import type { PiEvaluationResult, PiObservabilitySnapshot, PiObservabilityStore, PiRegressionAlert, PiTelemetryMetric, PiTraceRecord, PiTraceStatus } from "@/src/modules/pi-agent/domain/observability-contracts";

export class PiTelemetryService {
  constructor(private readonly store: PiObservabilityStore) {}

  async startTrace(context: RequestContext, input: Omit<PiTraceRecord, "id" | "tenantId" | "actorId" | "traceId" | "status" | "startedAt"> & { traceId?: string }): Promise<PiTraceRecord> {
    assertPiPermission(context, "pi:audit:write");
    const trace: PiTraceRecord = { ...input, id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, traceId: input.traceId ?? context.traceId, status: "started", startedAt: new Date().toISOString() };
    await this.store.appendTrace(trace);
    return trace;
  }

  async recordTrace(context: RequestContext, input: Omit<PiTraceRecord, "id" | "tenantId" | "actorId" | "startedAt"> & { status: PiTraceStatus }): Promise<PiTraceRecord> {
    assertPiPermission(context, "pi:audit:write");
    if (input.durationMs !== undefined && (!Number.isInteger(input.durationMs) || input.durationMs < 0)) throw new Error("PI_TRACE_DURATION_INVALID");
    const trace: PiTraceRecord = { ...input, id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, startedAt: new Date().toISOString() };
    await this.store.appendTrace(trace);
    return trace;
  }

  async recordMetric(context: RequestContext, input: Omit<PiTelemetryMetric, "id" | "tenantId" | "createdAt">): Promise<PiTelemetryMetric> {
    assertPiPermission(context, "pi:telemetry:write");
    if (!/^[a-z][a-z0-9_.-]{1,96}$/.test(input.name) || !Number.isFinite(input.value)) throw new Error("PI_METRIC_INVALID");
    if (Object.keys(input.dimensions).length > 32 || Object.keys(input.dimensions).some((key) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(key))) throw new Error("PI_METRIC_DIMENSIONS_INVALID");
    const metric: PiTelemetryMetric = { id: randomUUID(), tenantId: context.tenantId, createdAt: new Date().toISOString(), ...input, dimensions: Object.fromEntries(Object.entries(input.dimensions).map(([key, value]) => [key, String(value).slice(0, 128)])) };
    await this.store.appendMetric(metric);
    return metric;
  }

  async recordEvaluation(context: RequestContext, input: Omit<PiEvaluationResult, "id" | "tenantId" | "status" | "correctionRequired" | "createdAt"> & { status?: PiEvaluationResult["status"] }): Promise<PiEvaluationResult> {
    assertPiPermission(context, "pi:evaluation:write");
    if (!input.suiteId || !input.caseId || !Number.isFinite(input.score) || input.score < 0 || input.score > 1 || !Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1) throw new Error("PI_EVALUATION_INVALID");
    const status: PiEvaluationResult["status"] = input.status === "blocked" || input.status === "unknown" ? input.status : input.score >= input.threshold ? "passed" : "failed";
    const result: PiEvaluationResult = { id: randomUUID(), tenantId: context.tenantId, ...input, status, correctionRequired: status !== "passed", createdAt: new Date().toISOString() };
    await this.store.appendEvaluation(result);
    if (status === "failed") await this.recordAlert(context, { id: randomUUID(), tenantId: context.tenantId, suiteId: input.suiteId, metric: "score", baseline: input.threshold, observed: input.score, threshold: input.threshold, severity: input.score < input.threshold * 0.8 ? "P1" : "P2", status: "open", createdAt: result.createdAt });
    return result;
  }

  async recordAlert(context: RequestContext, alert: PiRegressionAlert): Promise<void> {
    assertPiPermission(context, "pi:evaluation:write");
    if (alert.tenantId !== context.tenantId || !Number.isFinite(alert.baseline) || !Number.isFinite(alert.observed)) throw new Error("PI_ALERT_INVALID");
    await this.store.appendAlert(alert);
  }

  async snapshot(context: RequestContext, usage: PiModelUsageRecord[] = []): Promise<PiObservabilitySnapshot> {
    assertPiPermission(context, "pi:audit:read");
    const traces = await this.store.listTraces(context, 500);
    const metrics = await this.store.listMetrics(context, 100);
    const evaluations = await this.store.listEvaluations(context, 100);
    const alerts = await this.store.listAlerts(context, 100);
    const durations = traces.map((trace) => trace.durationMs).filter((value): value is number => value !== undefined);
    return {
      traces: { total: traces.length, succeeded: traces.filter((trace) => trace.status === "succeeded").length, failed: traces.filter((trace) => trace.status === "failed").length, blocked: traces.filter((trace) => trace.status === "blocked").length, unknown: traces.filter((trace) => trace.status === "unknown").length, ...(durations.length ? { averageDurationMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) } : {}) },
      metrics,
      evaluations,
      alerts,
      usage: { inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0), outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0), costMicros: usage.reduce((sum, item) => sum + item.costMicros, 0), calls: usage.length },
    };
  }
}
