export type StrategyTheme = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  ownerId: string;
  status: "draft" | "active" | "completed" | "cancelled";
  startsAt: string;
  endsAt: string;
  version: number;
};

export type GovernedObjective = {
  id: string;
  tenantId: string;
  themeId: string;
  title: string;
  description: string;
  ownerId: string;
  objectiveType: "okr" | "kpi";
  status: "draft" | "proposed" | "active" | "at_risk" | "achieved" | "missed" | "cancelled" | "reviewed";
  measurementMethod: string;
  dataSource: string;
  reviewCadence: "daily" | "weekly" | "monthly" | "quarterly";
  startsAt: string;
  endsAt: string;
  metricIds: string[];
  projectIds: string[];
  version: number;
};

export type MetricDefinition = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string;
  ownerId: string;
  unit: string;
  direction: "increase" | "decrease" | "maintain";
  baseline: number;
  targetValue: number;
  tolerancePercent: number;
  sourceSystem: string;
  sourceLocator: string;
  refreshCadence: "daily" | "weekly" | "monthly" | "quarterly";
  classification: "internal" | "confidential";
  version: number;
};

export type MetricObservation = {
  id: string;
  tenantId: string;
  metricId: string;
  value: number;
  periodStart: string;
  periodEnd: string;
  observedAt: string;
  sourceType: "authoritative" | "human_confirmed";
  sourceRef: string;
  evidenceRefs: string[];
  recordedBy: string;
};

export type OperatingReview = {
  id: string;
  tenantId: string;
  title: string;
  cadence: "weekly" | "monthly" | "quarterly";
  periodStart: string;
  periodEnd: string;
  ownerId: string;
  status: "draft" | "pending_confirmation" | "confirmed";
  facts: Array<{ statement: string; evidenceRefs: string[] }>;
  inferences: Array<{ statement: string; confidence: number; evidenceRefs: string[] }>;
  decisions: string[];
  excludedDataScopes: string[];
  confirmedBy?: string;
  confirmedAt?: string;
  version: number;
};

export type MetricHealth = "on_target" | "watch" | "at_risk" | "unknown";

export function metricProgress(metric: MetricDefinition, value: number): number | null {
  if (metric.targetValue === metric.baseline) return null;
  if (metric.direction === "maintain") {
    const tolerance = Math.abs(metric.targetValue) * metric.tolerancePercent / 100;
    return Math.abs(value - metric.targetValue) <= tolerance ? 1 : Math.max(0, 1 - Math.abs(value - metric.targetValue) / Math.max(tolerance * 3, 1));
  }
  const raw = (value - metric.baseline) / (metric.targetValue - metric.baseline);
  return Math.max(0, Math.min(1, raw));
}

export function metricHealth(metric: MetricDefinition, value: number): MetricHealth {
  const progress = metricProgress(metric, value);
  if (progress === null) return "unknown";
  if (progress >= 0.9) return "on_target";
  if (progress >= 0.7) return "watch";
  return "at_risk";
}

export function assertObjectiveTraceability(objective: GovernedObjective): void {
  if (!objective.ownerId || !objective.measurementMethod.trim() || !objective.dataSource.trim()) throw new Error("OBJECTIVE_GOVERNANCE_INCOMPLETE");
  if (objective.metricIds.length === 0 || objective.projectIds.length === 0) throw new Error("OBJECTIVE_TRACEABILITY_REQUIRED");
  if (objective.endsAt < objective.startsAt) throw new Error("OBJECTIVE_PERIOD_INVALID");
}

export function confirmOperatingReview(review: OperatingReview, actorId: string, expectedVersion: number, now = new Date()): OperatingReview {
  if (review.version !== expectedVersion) throw new Error("OPERATING_REVIEW_VERSION_CONFLICT");
  if (review.status !== "pending_confirmation") throw new Error("OPERATING_REVIEW_INVALID_TRANSITION");
  if (review.ownerId !== actorId) throw new Error("OPERATING_REVIEW_OWNER_REQUIRED");
  return { ...review, status: "confirmed", confirmedBy: actorId, confirmedAt: now.toISOString(), version: review.version + 1 };
}
