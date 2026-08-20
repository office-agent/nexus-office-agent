import type { RequestContext } from "@/src/platform/context/request-context";

export type PiPublicationStatus = "draft" | "candidate" | "approved" | "rolling_out" | "active" | "rolled_back" | "revoked";
export type PiGateStatus = "pending" | "pass" | "fail" | "expired";
export type PiRiskSeverity = "P0" | "P1" | "P2" | "P3";
export type PiRiskStatus = "open" | "mitigated" | "accepted";
export type PiApprovalDecision = "pending" | "approved" | "rejected";
export type PiApprovalRole = "release_manager" | "security_reviewer" | "operations_reviewer";
export type PiRolloutStage = "canary" | "pilot" | "general";
export type PiRolloutStatus = "planned" | "running" | "completed" | "paused" | "rolled_back";
export type PiReleaseEvaluationStatus = "passed" | "regressed" | "blocked" | "unknown";

export type PiPublication = {
  id: string;
  tenantId: string;
  createdBy: string;
  version: string;
  upstreamVersion: string;
  apiDigest: string;
  schemaDigest: string;
  imageDigest: string;
  signatureDigest: string;
  sbomDigest: string;
  rollbackDigest: string;
  pilotReadinessDigest?: string;
  actionDigest: string;
  status: PiPublicationStatus;
  createdAt: string;
  approvedAt?: string;
  revokedAt?: string;
};

export type PiGateAttestation = {
  id: string;
  tenantId: string;
  publicationId: string;
  gateId: string;
  status: PiGateStatus;
  evidenceDigest: string;
  policyVersion: number;
  validUntil: string;
  createdBy: string;
  createdAt: string;
};

export type PiReleaseRisk = {
  id: string;
  tenantId: string;
  publicationId: string;
  severity: PiRiskSeverity;
  status: PiRiskStatus;
  summaryDigest: string;
  mitigationDigest?: string;
  createdBy: string;
  createdAt: string;
  resolvedAt?: string;
};

export type PiReleaseApproval = {
  id: string;
  tenantId: string;
  publicationId: string;
  actorId: string;
  role: PiApprovalRole;
  decision: PiApprovalDecision;
  proposalHash: string;
  expiresAt: string;
  createdAt: string;
};

export type PiRollout = {
  id: string;
  tenantId: string;
  publicationId: string;
  scopeDigest: string;
  capabilityDigest: string;
  stage: PiRolloutStage;
  status: PiRolloutStatus;
  previousVersionDigest: string;
  actionDigest: string;
  createdAt: string;
  changedAt: string;
};

export type PiReleaseEvaluation = {
  id: string;
  tenantId: string;
  publicationId: string;
  status: PiReleaseEvaluationStatus;
  suiteDigest: string;
  score: number;
  threshold: number;
  evidenceDigest: string;
  createdAt: string;
};

export type PiReleaseGateCheck = {
  id: string;
  status: PiGateStatus;
  message: string;
  evidenceDigest?: string;
};

export type PiReleaseGateEvaluation = {
  id: string;
  tenantId: string;
  actorId: string;
  publicationId: string;
  ready: boolean;
  checks: PiReleaseGateCheck[];
  policyVersion: number;
  generatedAt: string;
  failureDigest?: string;
};

export type PiReleaseGovernanceEventKind =
  | "pi.publication.gate_evaluated"
  | "pi.publication.approved"
  | "pi.publication.rollout_changed"
  | "pi.publication.revoked";

export type PiReleaseGovernanceEvent = {
  id: string;
  tenantId: string;
  actorId: string;
  publicationId: string;
  kind: PiReleaseGovernanceEventKind;
  subjectDigest: string;
  traceId: string;
  createdAt: string;
};

export type PiReleaseGovernanceSnapshot = {
  publications: PiPublication[];
  gates: PiGateAttestation[];
  risks: PiReleaseRisk[];
  approvals: PiReleaseApproval[];
  rollouts: PiRollout[];
  evaluations: PiReleaseEvaluation[];
  gateEvaluations: PiReleaseGateEvaluation[];
  events: PiReleaseGovernanceEvent[];
  generatedAt: string;
};

export interface PiReleaseGovernanceStore {
  putPublication(publication: PiPublication): Promise<{ publication: PiPublication; created: boolean }>;
  findPublication(context: RequestContext, id: string): Promise<PiPublication | null>;
  findPublicationByActionDigest(context: RequestContext, actionDigest: string): Promise<PiPublication | null>;
  listPublications(context: RequestContext): Promise<PiPublication[]>;
  updatePublication(context: RequestContext, id: string, patch: Partial<Pick<PiPublication, "status" | "approvedAt" | "revokedAt">>): Promise<PiPublication>;
  putGate(attestation: PiGateAttestation): Promise<void>;
  listGates(context: RequestContext, publicationId: string): Promise<PiGateAttestation[]>;
  putRisk(risk: PiReleaseRisk): Promise<void>;
  listRisks(context: RequestContext, publicationId: string): Promise<PiReleaseRisk[]>;
  resolveRisk(context: RequestContext, publicationId: string, riskId: string, mitigationDigest: string, resolvedAt: string): Promise<PiReleaseRisk>;
  putApproval(approval: PiReleaseApproval): Promise<void>;
  listApprovals(context: RequestContext, publicationId: string): Promise<PiReleaseApproval[]>;
  putRollout(rollout: PiRollout): Promise<void>;
  findRollout(context: RequestContext, rolloutId: string): Promise<PiRollout | null>;
  listRollouts(context: RequestContext, publicationId?: string): Promise<PiRollout[]>;
  updateRollout(context: RequestContext, rolloutId: string, patch: Partial<Pick<PiRollout, "stage" | "status" | "changedAt">>): Promise<PiRollout>;
  putEvaluation(evaluation: PiReleaseEvaluation): Promise<void>;
  listEvaluations(context: RequestContext, publicationId?: string): Promise<PiReleaseEvaluation[]>;
  putGateEvaluation(evaluation: PiReleaseGateEvaluation): Promise<void>;
  latestGateEvaluation(context: RequestContext, publicationId: string): Promise<PiReleaseGateEvaluation | null>;
  listGateEvaluations(context: RequestContext, limit?: number): Promise<PiReleaseGateEvaluation[]>;
  appendEvent(event: PiReleaseGovernanceEvent): Promise<void>;
  listEvents(context: RequestContext, limit?: number): Promise<PiReleaseGovernanceEvent[]>;
}
