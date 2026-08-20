import { createHash } from "node:crypto";

export type ManagementCadence = {
  id: string;
  tenantId: string;
  name: string;
  cadenceType: "weekly_operations" | "monthly_business" | "quarterly_strategy" | "custom";
  frequency: "daily" | "weekly" | "monthly" | "quarterly";
  timezone: string;
  ownerId: string;
  participantRoleIds: string[];
  agendaTemplate: string[];
  evidenceRequirements: string[];
  status: "active" | "paused" | "archived";
  nextOccurrenceAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BriefingFact = { statement: string; evidenceRefs: string[] };
export type BriefingInference = { statement: string; confidence: number; evidenceRefs: string[] };
export type ManagementBriefing = {
  facts: BriefingFact[];
  inferences: BriefingInference[];
  proposals: Array<{ statement: string; requiresHumanDecision: true }>;
  usedDataScopes: string[];
  excludedDataScopes: string[];
  stateChanged: false;
  degraded: boolean;
  usage?: { provider: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number };
};

export type CadenceOccurrenceStatus = "scheduled" | "preparing" | "ready" | "in_progress" | "awaiting_evidence" | "closed" | "cancelled";
export type CadenceOccurrence = {
  id: string;
  tenantId: string;
  cadenceId: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  status: CadenceOccurrenceStatus;
  briefing?: ManagementBriefing;
  outcomeEvidenceRefs: string[];
  acknowledgedByIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type MetricSemanticProfile = {
  id: string;
  tenantId: string;
  metricId: string;
  businessDefinition: string;
  formula: string;
  ownerId: string;
  stewardId: string;
  authoritativeSource: string;
  sourceLocator: string;
  refreshCadence: "realtime" | "daily" | "weekly" | "monthly" | "quarterly";
  freshnessSlaMinutes: number;
  dimensions: string[];
  allowedUses: string[];
  prohibitedUses: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type MetricQualityStatus = "missing" | "stale" | "unverified" | "healthy";
export type MetricQualityCheck = {
  id: string;
  tenantId: string;
  metricId: string;
  status: MetricQualityStatus;
  observedAt?: string;
  freshnessMinutes?: number;
  completenessPercent: number;
  evidenceRefs: string[];
  checkedBy: string;
  checkedAt: string;
};

export type PortfolioProjectDecision = {
  projectId: string;
  action: "start" | "continue" | "accelerate" | "pause" | "stop";
  capacityPercent: number;
  rationale: string;
};

export type PortfolioScenario = {
  id: string;
  tenantId: string;
  portfolioId: string;
  name: string;
  assumptions: string[];
  projectDecisions: PortfolioProjectDecision[];
  expectedBenefit: number;
  estimatedCost: number;
  riskScore: number;
  evidenceRefs: string[];
  status: "draft" | "recommended" | "selected" | "rejected" | "superseded";
  createdBy: string;
  selectedBy?: string;
  selectedAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type EnterpriseCaseStatus = "open" | "triaged" | "in_progress" | "awaiting_evidence" | "resolved" | "closed" | "cancelled";
export type EnterpriseCase = {
  id: string;
  tenantId: string;
  code: string;
  caseType: "operational_exception" | "customer_issue" | "compliance" | "quality" | "service_request" | "other";
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  status: EnterpriseCaseStatus;
  ownerId?: string;
  dueAt: string;
  slaMinutes: number;
  sourceType: "web" | "wecom" | "system" | "integration";
  sourceRef: string;
  relatedObjectRefs: string[];
  evidenceRefs: string[];
  createdBy: string;
  resolvedAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type AiGovernanceEvaluation = {
  id: string;
  tenantId: string;
  capabilityId: string;
  agentRunId?: string;
  provider: string;
  model: string;
  promptVersion: string;
  datasetRef: string;
  outcome: "passed" | "failed" | "unknown";
  scores: { groundedness: number; citationCorrectness: number; policyCorrectness: number; taskCompletion: number };
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costMicrounits: number;
  evidenceRefs: string[];
  evaluatedBy: string;
  evaluatedAt: string;
};

export type AiGovernanceScorecard = {
  status: "insufficient_data" | "healthy" | "watch" | "at_risk";
  sampleSize: number;
  passRate: number | null;
  averageScores: AiGovernanceEvaluation["scores"] | null;
  totalCostMicrounits: number;
  p95LatencyMs: number | null;
  unknownCount: number;
};

export type ManagementChannelAction = {
  id: string;
  tenantId: string;
  actionType: "case_accept" | "cadence_start";
  resourceType: "enterprise_case" | "cadence_occurrence";
  resourceId: string;
  expectedVersion: number;
  proposalHash: string;
  expiresAt: string;
  status: "pending" | "executed" | "expired" | "cancelled" | "failed";
  connectionId: string;
  recipientDigest: string;
  createdBy: string;
  executedBy?: string;
  executedAt?: string;
  resultDigest?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const occurrenceTransitions: Record<CadenceOccurrenceStatus, CadenceOccurrenceStatus[]> = {
  scheduled: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["in_progress", "cancelled"],
  in_progress: ["awaiting_evidence", "cancelled"],
  awaiting_evidence: ["closed", "in_progress"],
  closed: [],
  cancelled: [],
};

const caseTransitions: Record<EnterpriseCaseStatus, EnterpriseCaseStatus[]> = {
  open: ["triaged", "in_progress", "cancelled"],
  triaged: ["in_progress", "cancelled"],
  in_progress: ["awaiting_evidence", "resolved", "cancelled"],
  awaiting_evidence: ["in_progress", "resolved"],
  resolved: ["closed", "in_progress"],
  closed: [],
  cancelled: [],
};

export function transitionOccurrence(current: CadenceOccurrence, target: CadenceOccurrenceStatus, evidenceRefs: string[], now: string): CadenceOccurrence {
  if (!occurrenceTransitions[current.status].includes(target)) throw new Error(`CADENCE_OCCURRENCE_INVALID_TRANSITION:${current.status}:${target}`);
  if (target === "closed" && evidenceRefs.length === 0) throw new Error("CADENCE_OUTCOME_EVIDENCE_REQUIRED");
  return { ...current, status: target, outcomeEvidenceRefs: [...new Set([...current.outcomeEvidenceRefs, ...evidenceRefs])], version: current.version + 1, updatedAt: now };
}

export function transitionEnterpriseCase(current: EnterpriseCase, target: EnterpriseCaseStatus, ownerId: string | undefined, evidenceRefs: string[], now: string): EnterpriseCase {
  if (!caseTransitions[current.status].includes(target)) throw new Error(`ENTERPRISE_CASE_INVALID_TRANSITION:${current.status}:${target}`);
  const resolved = target === "resolved" || target === "closed";
  if ((target === "in_progress" || resolved) && !(ownerId ?? current.ownerId)) throw new Error("ENTERPRISE_CASE_OWNER_REQUIRED");
  if (resolved && evidenceRefs.length === 0 && current.evidenceRefs.length === 0) throw new Error("ENTERPRISE_CASE_EVIDENCE_REQUIRED");
  return {
    ...current,
    status: target,
    ownerId: ownerId ?? current.ownerId,
    evidenceRefs: [...new Set([...current.evidenceRefs, ...evidenceRefs])],
    resolvedAt: resolved ? now : target === "in_progress" ? undefined : current.resolvedAt,
    version: current.version + 1,
    updatedAt: now,
  };
}

export function calculateMetricQuality(input: { profile: MetricSemanticProfile; observedAt?: string; completenessPercent: number; evidenceRefs: string[]; now: string }): Pick<MetricQualityCheck, "status" | "freshnessMinutes"> {
  if (!input.observedAt || input.evidenceRefs.length === 0) return { status: "missing", freshnessMinutes: undefined };
  const ageMilliseconds = Date.parse(input.now) - Date.parse(input.observedAt);
  if (!Number.isFinite(ageMilliseconds) || ageMilliseconds < 0) return { status: "unverified", freshnessMinutes: undefined };
  const freshnessMinutes = Math.floor(ageMilliseconds / 60_000);
  if (freshnessMinutes > input.profile.freshnessSlaMinutes) return { status: "stale", freshnessMinutes };
  if (input.completenessPercent < 95) return { status: "unverified", freshnessMinutes };
  return { status: "healthy", freshnessMinutes };
}

export function buildAiScorecard(evaluations: AiGovernanceEvaluation[]): AiGovernanceScorecard {
  const orderedLatency = evaluations.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
  const totalCostMicrounits = evaluations.reduce((sum, item) => sum + item.costMicrounits, 0);
  const unknownCount = evaluations.filter(({ outcome }) => outcome === "unknown").length;
  if (evaluations.length < 3) return { status: "insufficient_data", sampleSize: evaluations.length, passRate: null, averageScores: null, totalCostMicrounits, p95LatencyMs: orderedLatency.at(-1) ?? null, unknownCount };
  const averageScores = evaluations.reduce((scores, item) => ({
    groundedness: scores.groundedness + item.scores.groundedness / evaluations.length,
    citationCorrectness: scores.citationCorrectness + item.scores.citationCorrectness / evaluations.length,
    policyCorrectness: scores.policyCorrectness + item.scores.policyCorrectness / evaluations.length,
    taskCompletion: scores.taskCompletion + item.scores.taskCompletion / evaluations.length,
  }), { groundedness: 0, citationCorrectness: 0, policyCorrectness: 0, taskCompletion: 0 });
  const passRate = evaluations.filter(({ outcome }) => outcome === "passed").length / evaluations.length;
  const status = averageScores.policyCorrectness < 0.9 || passRate < 0.7 ? "at_risk" : passRate < 0.85 || unknownCount > 0 ? "watch" : "healthy";
  const p95Index = Math.max(0, Math.ceil(orderedLatency.length * 0.95) - 1);
  return { status, sampleSize: evaluations.length, passRate, averageScores, totalCostMicrounits, p95LatencyMs: orderedLatency[p95Index] ?? null, unknownCount };
}

export function managementActionHash(input: Pick<ManagementChannelAction, "tenantId" | "actionType" | "resourceType" | "resourceId" | "expectedVersion" | "expiresAt" | "connectionId" | "recipientDigest">): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
