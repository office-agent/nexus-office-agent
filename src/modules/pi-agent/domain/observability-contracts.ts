import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiModelDataClassification } from "@/src/modules/pi-agent/domain/model-contracts";

export type PiTraceStatus = "started" | "succeeded" | "failed" | "blocked" | "cancelled" | "unknown";

export type PiTraceRecord = {
  id: string;
  tenantId: string;
  actorId: string;
  traceId: string;
  workspaceId?: string;
  sessionId?: string;
  runId?: string;
  sandboxRunId?: string;
  toolCallId?: string;
  modelRouteId?: string;
  skillDigests: string[];
  gitCommitSha?: string;
  dataClassification: PiModelDataClassification;
  status: PiTraceStatus;
  inputDigest?: string;
  outputDigest?: string;
  durationMs?: number;
  errorCode?: string;
  startedAt: string;
  endedAt?: string;
};

export type PiTelemetryMetric = {
  id: string;
  tenantId: string;
  traceId: string;
  name: string;
  value: number;
  unit: "count" | "milliseconds" | "tokens" | "micros" | "ratio" | "bytes";
  dimensions: Record<string, string>;
  createdAt: string;
};

export type PiEvaluationStatus = "passed" | "failed" | "blocked" | "unknown";

export type PiEvaluationResult = {
  id: string;
  tenantId: string;
  suiteId: string;
  caseId: string;
  routeId?: string;
  traceId?: string;
  status: PiEvaluationStatus;
  score: number;
  threshold: number;
  metricSummary: Record<string, number>;
  outputDigest?: string;
  correctionRequired: boolean;
  createdAt: string;
};

export type PiRegressionAlert = {
  id: string;
  tenantId: string;
  suiteId: string;
  metric: string;
  baseline: number;
  observed: number;
  threshold: number;
  severity: "P0" | "P1" | "P2";
  status: "open" | "acknowledged" | "resolved";
  createdAt: string;
};

export type PiObservabilitySnapshot = {
  traces: { total: number; succeeded: number; failed: number; blocked: number; unknown: number; averageDurationMs?: number };
  metrics: PiTelemetryMetric[];
  evaluations: PiEvaluationResult[];
  alerts: PiRegressionAlert[];
  usage: { inputTokens: number; outputTokens: number; costMicros: number; calls: number };
};

export interface PiObservabilityStore {
  appendTrace(trace: PiTraceRecord): Promise<void>;
  appendMetric(metric: PiTelemetryMetric): Promise<void>;
  appendEvaluation(result: PiEvaluationResult): Promise<void>;
  appendAlert(alert: PiRegressionAlert): Promise<void>;
  listTraces(context: RequestContext, limit?: number): Promise<PiTraceRecord[]>;
  listMetrics(context: RequestContext, limit?: number): Promise<PiTelemetryMetric[]>;
  listEvaluations(context: RequestContext, limit?: number): Promise<PiEvaluationResult[]>;
  listAlerts(context: RequestContext, limit?: number): Promise<PiRegressionAlert[]>;
}
