import { z } from "zod";

export const piProfileSchema = z.enum(["coding", "review", "debug", "refactor", "office", "integration", "release"]);

export const createPiSessionSchema = z.object({
  profile: piProfileSchema,
  workspaceId: z.string().trim().min(1).max(256),
  repositoryId: z.string().trim().max(256).optional(),
  baseRef: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._/-]+$/).optional(),
  baseCommit: z.string().trim().regex(/^[a-f0-9]{7,64}$/i).optional(),
  skillIds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  packageIds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  extensionIds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  mcpBindingIds: z.array(z.string().uuid()).max(32).optional(),
  modelPolicy: z.string().trim().min(1).max(128).optional(),
}).strict();

export const piMessageSchema = z.object({ message: z.string().min(1).max(100_000) }).strict();
export const piApprovalDecisionSchema = z.object({
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approve", "reject"]),
  comment: z.string().trim().max(2_000).optional(),
}).strict();
export const piCheckpointSchema = z.object({ label: z.string().trim().max(200).optional() }).strict();
export const piCancelSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();
export const piForkSchema = z.object({
  parentBranchId: z.string().uuid().optional(),
  baseEventSequence: z.number().int().nonnegative().optional(),
  checkpointId: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(100),
}).strict();
export const piResumeSchema = z.object({ branchId: z.string().uuid().optional() }).strict();
export const piCompactSchema = z.object({
  branchId: z.string().uuid().optional(),
  maxEvents: z.number().int().positive().max(500).optional(),
}).strict();
export const piDelegationBudgetSchema = z.object({
  maxDurationMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
  maxOutputBytes: z.number().int().positive().max(50_000_000).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  maxChildRuns: z.number().int().nonnegative().max(32).optional(),
}).strict();
export const piDelegationSchema = z.object({
  profile: piProfileSchema,
  budget: piDelegationBudgetSchema.optional(),
}).strict();
export const piDownloadGrantSchema = z.object({
  version: z.number().int().positive().optional(),
  ttlMs: z.number().int().positive().max(15 * 60 * 1000).optional(),
}).strict();
export const piResourceRolloutSchema = z.object({ percent: z.number().int().min(0).max(100) }).strict();
export const piResourceScanSchema = z.object({ status: z.enum(["passed", "failed"]) }).strict();
export const piSkillReleaseDraftSchema = z.object({
  skillId: z.string().trim().regex(/^[A-Za-z0-9._-]{1,128}$/),
  version: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/),
  scope: z.enum(["global", "tenant", "project", "personal"]),
  signature: z.string().min(1).max(4096),
  content: z.string().min(1).max(2_000_000),
  requiredTools: z.array(z.string().trim().min(1).max(128)).max(64),
  dataClassification: z.enum(["public", "internal", "confidential", "restricted"]),
  riskLevel: z.enum(["R0", "R1", "R2", "R3", "R4"]),
  allowedProfiles: z.array(piProfileSchema).min(1).max(7),
}).strict();
export const piArtifactReleaseDraftSchema = z.object({
  resourceId: z.string().trim().regex(/^[A-Za-z0-9._/-]{1,256}$/),
  kind: z.enum(["package", "extension"]),
  version: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/i),
  signature: z.string().min(1).max(4096),
  artifactRef: z.string().trim().min(1).max(512),
  sbomDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  allowedProfiles: z.array(piProfileSchema).min(1).max(7),
  dataClassification: z.enum(["public", "internal", "confidential", "restricted"]),
  riskLevel: z.enum(["R0", "R1", "R2", "R3", "R4"]),
}).strict();

export const mcpNetworkPolicySchema = z.object({
  allowedHosts: z.array(z.string().trim().min(1).max(253)).min(1).max(32),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).min(1).max(16),
  timeoutMs: z.number().int().min(100).max(30_000),
  maxResponseBytes: z.number().int().min(1_024).max(20_000_000),
  proxyRef: z.string().regex(/^(?:proxy|egress):\/[a-zA-Z0-9/_-]{1,200}$/).optional(),
}).strict();

export const mcpServerRegistrationSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  version: z.string().trim().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?$/),
  source: z.string().trim().min(1).max(256),
  endpointRef: z.string().url().max(512),
  credentialRef: z.string().regex(/^secret:\/\/[a-zA-Z0-9/_-]{1,200}$/).optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(1).max(4096),
  networkPolicy: mcpNetworkPolicySchema,
}).strict();

export const mcpProbeSchema = z.object({ version: z.string().trim().min(1).max(64) }).strict();

export const mcpBindingSchema = z.object({
  serverId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  serverVersion: z.string().trim().min(1).max(64),
  toolName: z.string().trim().min(1).max(128),
  schemaDigest: z.string().regex(/^[a-f0-9]{64}$/),
  exposedName: z.string().trim().max(256).optional(),
  allowedProfiles: z.array(piProfileSchema).min(1).max(7),
  scope: z.discriminatedUnion("type", [
    z.object({ type: z.literal("tenant") }).strict(),
    z.object({ type: z.literal("project"), projectId: z.string().trim().min(1).max(256) }).strict(),
    z.object({ type: z.literal("user"), actorId: z.string().uuid() }).strict(),
  ]),
  networkPolicyRef: z.string().regex(/^(?:proxy|egress):\/[a-zA-Z0-9/_-]{1,200}$/).optional(),
}).strict();

export const piModelRouteDraftSchema = z.object({
  routeId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  version: z.string().trim().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?$/),
  provider: z.string().trim().regex(/^[a-z][a-z0-9._-]{1,63}$/),
  model: z.string().trim().regex(/^[\w./:-]{1,128}$/),
  region: z.string().trim().regex(/^[a-z0-9-]{2,32}$/),
  egress: z.enum(["private", "public", "local"]),
  allowedDataClassifications: z.array(z.enum(["public", "internal", "confidential", "restricted"])).min(1).max(4),
  fallbackRouteIds: z.array(z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)).max(8),
  maxInputTokens: z.number().int().positive().max(10_000_000),
  maxOutputTokens: z.number().int().positive().max(10_000_000),
  inputCostMicrosPerMillion: z.number().int().nonnegative().max(10_000_000_000),
  outputCostMicrosPerMillion: z.number().int().nonnegative().max(10_000_000_000),
}).strict();
export const piModelRouteActionSchema = z.object({ version: z.string().trim().max(64) }).strict();
export const piModelAuthorizationSchema = z.object({
  routeId: z.string().trim().max(64),
  dataClassification: z.enum(["public", "internal", "confidential", "restricted"]),
  inputTokens: z.number().int().nonnegative().max(10_000_000),
  outputTokens: z.number().int().nonnegative().max(10_000_000),
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();
export const piModelUsageSchema = z.object({
  routeId: z.string().trim().max(64),
  provider: z.string().trim().max(64),
  model: z.string().trim().max(128),
  dataClassification: z.enum(["public", "internal", "confidential", "restricted"]),
  inputTokens: z.number().int().nonnegative().max(10_000_000),
  outputTokens: z.number().int().nonnegative().max(10_000_000),
  latencyMs: z.number().int().nonnegative().max(86_400_000),
  status: z.enum(["succeeded", "failed", "cancelled", "blocked"]),
  usageId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(256),
  workspaceId: z.string().trim().max(256).optional(),
  sessionId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  traceId: z.string().trim().min(1).max(128),
}).strict();
export const piTraceSchema = z.object({
  traceId: z.string().trim().min(1).max(128),
  workspaceId: z.string().trim().max(256).optional(),
  sessionId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  modelRouteId: z.string().trim().max(64).optional(),
  skillDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/i)).max(64),
  dataClassification: z.enum(["public", "internal", "confidential", "restricted"]),
  status: z.enum(["started", "succeeded", "failed", "blocked", "cancelled", "unknown"]),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  errorCode: z.string().trim().max(128).optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
}).strict();
export const piMetricSchema = z.object({
  traceId: z.string().trim().min(1).max(128),
  name: z.string().trim().regex(/^[a-z][a-z0-9_.-]{1,96}$/),
  value: z.number().finite(),
  unit: z.enum(["count", "milliseconds", "tokens", "micros", "ratio", "bytes"]),
  dimensions: z.record(z.string(), z.string().trim().max(128)).default({}),
}).strict();
export const piEvaluationSchema = z.object({
  suiteId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  caseId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  routeId: z.string().trim().max(64).optional(),
  traceId: z.string().trim().max(128).optional(),
  status: z.enum(["passed", "failed", "blocked", "unknown"]).optional(),
  score: z.number().finite().min(0).max(1),
  threshold: z.number().finite().min(0).max(1),
  metricSummary: z.record(z.string(), z.number().finite()).default({}),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();
export const piQuotaPolicySchema = z.object({
  scope: z.enum(["tenant", "project", "actor", "profile"]),
  scopeId: z.string().trim().max(256).optional(),
  version: z.number().int().positive().max(1000),
  maxConcurrentRuns: z.number().int().nonnegative().max(100_000),
  maxTokens: z.number().int().nonnegative().max(1_000_000_000),
  maxCostMicros: z.number().int().nonnegative().max(1_000_000_000_000),
  maxStorageBytes: z.number().int().nonnegative().max(10_000_000_000_000),
  maxToolCalls: z.number().int().nonnegative().max(10_000_000),
  status: z.enum(["active", "revoked"]).default("active"),
}).strict();
export const piQuotaReserveSchema = z.object({
  policyId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(256),
  runId: z.string().uuid().optional(),
  requested: z.object({
    concurrentRuns: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export const piQuotaReservationActionSchema = z.object({
  consumed: z.object({
    concurrentRuns: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();

export const piKillSwitchDraftSchema = z.object({
  scope: z.enum(["global", "tenant", "profile", "model", "resource"]),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  targetProfile: piProfileSchema.optional(),
  targetModelRouteId: z.string().trim().max(128).optional(),
  reasonCode: z.string().trim().min(1).max(128),
}).strict();

export const piCapacityPolicyDraftSchema = z.object({
  scope: z.enum(["tenant", "profile"]),
  scopeId: z.string().trim().max(128).optional(),
  version: z.number().int().positive().max(100_000),
  maxConcurrentRuns: z.number().int().positive().max(100_000),
  maxQueueDepth: z.number().int().positive().max(1_000_000),
  maxPromptBytes: z.number().int().positive().max(16_777_216),
  maxEventBytes: z.number().int().positive().max(16_777_216),
}).strict();

export const piCapacityAdmissionSchema = z.object({
  runId: z.string().trim().min(1).max(256),
  idempotencyKey: z.string().trim().min(1).max(256),
  profile: piProfileSchema.optional(),
}).strict();

export const piFaultPlanDraftSchema = z.object({
  target: z.enum(["queue.claim", "runner.runtime", "model.provider", "telemetry.write", "object.store", "database.query"]),
  errorCode: z.string().trim().regex(/^[A-Z][A-Z0-9_.-]{2,127}$/),
  remaining: z.number().int().positive().max(100),
  ttlSeconds: z.number().int().positive().max(3600),
}).strict();

export const piReleaseCandidateDraftSchema = z.object({
  version: z.string().trim().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/),
  imageDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  signatureDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  sbomDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();

export const piSecretLeaseDraftSchema = z.object({
  reference: z.string().trim().min(1).max(512),
  purpose: z.string().trim().min(1).max(128),
  audience: z.string().trim().min(1).max(128),
  ttlSeconds: z.number().int().positive().max(3600),
}).strict();

export const piPilotDraftSchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(128),
  version: z.string().trim().min(1).max(64),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  exitPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();
export const piPilotParticipantDraftSchema = z.object({
  subjectDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  role: z.string().trim().min(1).max(64),
  projectScopeDigest: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();
export const piPilotJourneyDraftSchema = z.object({
  kind: z.enum(["new_feature", "bug_fix", "refactor", "test_failure_repair", "code_review", "pull_request"]),
  sampleDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  runDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  qualityScore: z.number().finite().min(0).max(1).optional(),
}).strict();
export const piPilotObservationDraftSchema = z.object({
  metric: z.enum(["stability", "quality", "cost", "security", "adoption", "data_access"]),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  value: z.number().finite(),
  threshold: z.number().finite(),
  unit: z.string().trim().min(1).max(32),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();
export const piPilotDataSampleDraftSchema = z.object({
  classification: z.enum(["public", "internal", "confidential", "restricted"]),
  sampleDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();
export const piPilotIncidentDraftSchema = z.object({
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  status: z.enum(["open", "resolved"]).optional(),
  summaryDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  resolvedAt: z.string().datetime().optional(),
}).strict();

export const piPublicationDraftSchema = z.object({
  version: z.string().trim().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/),
  upstreamVersion: z.string().trim().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/),
  apiDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  schemaDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  imageDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  signatureDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  sbomDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  rollbackDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  pilotReadinessDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();
export const piGateAttestationDraftSchema = z.object({ gateId: z.string().trim().max(16), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/i), validUntil: z.string().datetime() }).strict();
export const piReleaseRiskDraftSchema = z.object({ severity: z.enum(["P0", "P1", "P2", "P3"]), summaryDigest: z.string().regex(/^[a-f0-9]{64}$/i), mitigationDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict();
export const piReleaseRiskResolutionSchema = z.object({ mitigationDigest: z.string().regex(/^[a-f0-9]{64}$/i) }).strict();
export const piReleaseApprovalRequestSchema = z.object({ role: z.enum(["release_manager", "security_reviewer", "operations_reviewer"]), expiresAt: z.string().datetime() }).strict();
export const piReleaseApprovalDecisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) }).strict();
export const piRolloutDraftSchema = z.object({ scopeDigest: z.string().regex(/^[a-f0-9]{64}$/i), capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/i), stage: z.enum(["canary", "pilot", "general"]), previousVersionDigest: z.string().regex(/^[a-f0-9]{64}$/i) }).strict();
export const piReleaseEvaluationDraftSchema = z.object({ suiteDigest: z.string().regex(/^[a-f0-9]{64}$/i), score: z.number().finite().min(0).max(1), threshold: z.number().finite().min(0).max(1), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/i) }).strict();
export const piChangeSubmitSchema = z.object({
  runId: z.string().uuid(),
  workspaceRecordId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  baseCommitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  targetBranch: z.string().trim().min(1).max(255).regex(/^(?!refs\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/),
  checkpointIds: z.array(z.string().uuid()).min(1).max(64),
  artifactIds: z.array(z.string().uuid()).min(1).max(64),
}).strict();
export const piMergeProposalSchema = z.object({
  targetBranch: z.string().trim().min(1).max(255).regex(/^(?!refs\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/).optional(),
}).strict();
export const piReleaseProposalSchema = z.object({
  environment: z.string().trim().regex(/^[a-z][a-z0-9-]{0,63}$/),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  pullRequestId: z.string().uuid().optional(),
}).strict();
