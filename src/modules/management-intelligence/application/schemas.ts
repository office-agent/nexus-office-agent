import { z } from "zod";

const uuid = z.uuid();
const shortText = (min = 1, max = 200) => z.string().trim().min(min).max(max);
const ref = shortText(2, 300);
const evidenceRefs = z.array(ref).max(30).default([]);

export const createCadenceSchema = z.object({
  name: shortText(2, 120),
  cadenceType: z.enum(["weekly_operations", "monthly_business", "quarterly_strategy", "custom"]),
  frequency: z.enum(["daily", "weekly", "monthly", "quarterly"]),
  timezone: shortText(2, 80),
  ownerId: uuid,
  participantRoleIds: z.array(shortText(2, 100)).min(1).max(30),
  agendaTemplate: z.array(shortText(2, 300)).min(1).max(30),
  evidenceRequirements: z.array(shortText(2, 300)).min(1).max(30),
  nextOccurrenceAt: z.iso.datetime({ offset: true }),
}).strict();

export const createOccurrenceSchema = z.object({
  scheduledStartAt: z.iso.datetime({ offset: true }),
  scheduledEndAt: z.iso.datetime({ offset: true }),
}).strict().refine((value) => Date.parse(value.scheduledEndAt) > Date.parse(value.scheduledStartAt), { path: ["scheduledEndAt"], message: "scheduledEndAt must follow scheduledStartAt" });

export const transitionOccurrenceSchema = z.object({
  targetStatus: z.enum(["in_progress", "awaiting_evidence", "closed", "cancelled"]),
  version: z.number().int().positive(),
  evidenceRefs,
}).strict();

export const metricSemanticProfileSchema = z.object({
  businessDefinition: shortText(4, 1000),
  formula: shortText(1, 1000),
  ownerId: uuid,
  stewardId: uuid,
  authoritativeSource: shortText(2, 200),
  sourceLocator: shortText(2, 500),
  refreshCadence: z.enum(["realtime", "daily", "weekly", "monthly", "quarterly"]),
  freshnessSlaMinutes: z.number().int().positive().max(525_600),
  dimensions: z.array(shortText(1, 80)).max(30),
  allowedUses: z.array(shortText(2, 200)).min(1).max(30),
  prohibitedUses: z.array(shortText(2, 200)).min(1).max(30),
  version: z.number().int().positive().optional(),
}).strict();

export const metricQualityCheckSchema = z.object({
  observedAt: z.iso.datetime({ offset: true }).optional(),
  completenessPercent: z.number().min(0).max(100),
  evidenceRefs,
}).strict();

export const createPortfolioScenarioSchema = z.object({
  name: shortText(2, 120),
  assumptions: z.array(shortText(2, 500)).min(1).max(30),
  projectDecisions: z.array(z.object({
    projectId: uuid,
    action: z.enum(["start", "continue", "accelerate", "pause", "stop"]),
    capacityPercent: z.number().min(0).max(100),
    rationale: shortText(4, 500),
  }).strict()).min(1).max(100),
  expectedBenefit: z.number().finite().min(0),
  estimatedCost: z.number().finite().min(0),
  riskScore: z.number().int().min(1).max(25),
  evidenceRefs: z.array(ref).min(1).max(30),
  status: z.enum(["draft", "recommended"]).default("draft"),
}).strict();

export const selectPortfolioScenarioSchema = z.object({ version: z.number().int().positive() }).strict();

export const createEnterpriseCaseSchema = z.object({
  caseType: z.enum(["operational_exception", "customer_issue", "compliance", "quality", "service_request", "other"]),
  title: shortText(2, 160),
  description: shortText(4, 4000),
  severity: z.enum(["low", "medium", "high", "critical"]),
  ownerId: uuid.optional(),
  dueAt: z.iso.datetime({ offset: true }),
  slaMinutes: z.number().int().positive().max(525_600),
  sourceType: z.enum(["web", "wecom", "system", "integration"]),
  sourceRef: ref,
  relatedObjectRefs: z.array(ref).max(30),
  evidenceRefs,
}).strict();

export const transitionEnterpriseCaseSchema = z.object({
  targetStatus: z.enum(["triaged", "in_progress", "awaiting_evidence", "resolved", "closed", "cancelled"]),
  version: z.number().int().positive(),
  ownerId: uuid.optional(),
  evidenceRefs,
}).strict();

const score = z.number().min(0).max(1);
export const aiGovernanceEvaluationSchema = z.object({
  capabilityId: shortText(2, 120),
  agentRunId: uuid.optional(),
  provider: shortText(2, 80),
  model: shortText(1, 120),
  promptVersion: shortText(1, 120),
  datasetRef: ref,
  outcome: z.enum(["passed", "failed", "unknown"]),
  scores: z.object({ groundedness: score, citationCorrectness: score, policyCorrectness: score, taskCompletion: score }).strict(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  latencyMs: z.number().int().min(0).max(3_600_000),
  costMicrounits: z.number().int().min(0),
  evidenceRefs: z.array(ref).min(1).max(30),
  evaluatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const wecomManagementActionSchema = z.object({
  actionType: z.enum(["case_accept", "cadence_start"]),
  resourceId: uuid,
  connectionId: uuid,
  externalUserId: shortText(1, 200),
  expiresInMinutes: z.number().int().min(1).max(60).default(10),
}).strict();

export const confirmManagementChannelActionSchema = z.object({ proposalHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
