import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiApprovalExecutionPermit, PiApprovalObjectVersions } from "@/src/modules/pi-agent/domain/approval-contracts";
import type { PiArtifactType, PiRepositoryBinding, PiWorkspaceArtifact, PiWorkspaceDiff, PiWorkspaceRecord } from "@/src/modules/pi-agent/domain/workspace-contracts";

export type PiDeliveryCheckStatus = "passed" | "failed" | "unknown" | "not_run";
export type PiDeliveryCheck = {
  id: string;
  type: "test" | "scan" | "policy";
  status: PiDeliveryCheckStatus;
  evidenceDigest?: string;
  artifactId?: string;
};

export type PiChangeSubmissionStatus = "awaiting_approval" | "queued" | "submitted" | "failed" | "unknown" | "cancelled";
export type PiPullRequestStatus = "pending" | "open" | "mergeable" | "conflicted" | "merged" | "closed" | "failed" | "unknown";
export type PiMergeability = "unknown" | "mergeable" | "conflicted" | "blocked";
export type PiProposalStatus = "awaiting_approval" | "queued" | "succeeded" | "failed" | "unknown" | "cancelled";
export type PiDeliveryActionType = "create_pull_request" | "refresh_mergeability" | "propose_merge" | "propose_release";
export type PiDeliveryOutboxStatus = "awaiting_approval" | "queued" | "leased" | "succeeded" | "failed" | "unknown" | "cancelled";
export type PiExternalResultStatus = "succeeded" | "failed" | "unknown";

export type PiChangeSetValidation = {
  sessionId: string;
  runId: string;
  workspaceRecordId: string;
  repositoryId: string;
  baseCommitSha: string;
  headCommitSha: string;
  branch: string;
  targetBranch: string;
  diffDigest: string;
  changeSetDigest: string;
  validationDigest: string;
  checkpointIds: string[];
  checks: PiDeliveryCheck[];
  generatedAt: string;
};

export type PiChangeSetValidationInput = {
  sessionId: string;
  runId: string;
  workspaceRecordId: string;
  repositoryId: string;
  baseCommitSha: string;
  targetBranch: string;
  checkpointIds: string[];
  artifactIds: string[];
};

export type PiChangeSubmission = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  workspaceRecordId: string;
  repositoryId: string;
  baseCommitSha: string;
  headCommitSha: string;
  branch: string;
  targetBranch: string;
  diffDigest: string;
  changeSetDigest: string;
  validationDigest: string;
  checkpointIds: string[];
  checks: PiDeliveryCheck[];
  approvalId: string;
  approvalHash: string;
  status: PiChangeSubmissionStatus;
  version: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};

export type PiPullRequest = {
  id: string;
  tenantId: string;
  actorId: string;
  submissionId: string;
  provider: "forgejo" | "github" | "gitlab" | "other";
  repositoryId: string;
  repositoryRef: string;
  branch: string;
  targetBranch: string;
  baseCommitSha: string;
  headCommitSha: string;
  externalId?: string;
  externalUrl?: string;
  status: PiPullRequestStatus;
  mergeability: PiMergeability;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PiMergeProposal = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  submissionId: string;
  pullRequestId: string;
  targetBranch: string;
  approvalId: string;
  proposalHash: string;
  expectedObjectVersions: PiApprovalObjectVersions;
  status: PiProposalStatus;
  version: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};

export type PiReleaseProposal = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  submissionId: string;
  pullRequestId?: string;
  environment: string;
  artifactDigest: string;
  approvalId: string;
  proposalHash: string;
  expectedObjectVersions: PiApprovalObjectVersions;
  status: PiProposalStatus;
  version: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};

export type PiDeliveryOutbox = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  actionType: PiDeliveryActionType;
  entityId: string;
  approvalId?: string;
  proposalHash?: string;
  status: PiDeliveryOutboxStatus;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  idempotencyKey: string;
  payloadDigest: string;
  externalId?: string;
  externalUrl?: string;
  resultDigest?: string;
  lastErrorCode?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PiDeliveryEventType =
  | "pi.change.validated"
  | "pi.change.submitted"
  | "pi.change.pull_request_queued"
  | "pi.change.pull_request_result"
  | "pi.change.mergeability_queued"
  | "pi.change.merge_proposed"
  | "pi.change.release_proposed"
  | "pi.change.external_result_unknown";

export type PiDeliveryEvent = {
  id: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  actionType: PiDeliveryActionType;
  entityId: string;
  eventType: PiDeliveryEventType;
  subjectDigest: string;
  traceId: string;
  createdAt: string;
};

export type PiChangeDeliveryEvidenceReader = {
  getRepository(context: RequestContext, repositoryId: string): Promise<PiRepositoryBinding>;
  getWorkspace(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceRecord>;
  deliveryDiff(context: RequestContext, workspaceRecordId: string): Promise<PiWorkspaceDiff>;
  checkpoints(context: RequestContext, sessionId: string): Promise<Array<{ id: string; sessionId: string; diffDigest: string; gitCommitSha?: string }>>;
  listArtifacts(context: RequestContext, sessionId: string): Promise<PiWorkspaceArtifact[]>;
};

export type PiChangeApprovalGateway = {
  createProposal(context: RequestContext, input: {
    sessionId: string;
    runId: string;
    toolName: string;
    toolVersion: number;
    profile: string;
    riskLevel: "R2" | "R3";
    preview: string;
    inputDigest: string;
    expectedObjectVersions: PiApprovalObjectVersions;
    idempotencyKey: string;
  }): Promise<{ approval: { id: string; proposalHash: string } }>;
  resumeToolCall(context: RequestContext, approvalId: string): Promise<PiApprovalExecutionPermit>;
};

export type PiPullRequestGatewayInput = {
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  repositoryId: string;
  provider: PiRepositoryBinding["provider"];
  repositoryRef: string;
  credentialRef: string;
  branch: string;
  targetBranch: string;
  baseCommitSha: string;
  headCommitSha: string;
  changeSetDigest: string;
  idempotencyKey: string;
  externalId?: string;
  traceId: string;
};

export type PiExternalActionResult = {
  status: PiExternalResultStatus;
  resultDigest: string;
  externalId?: string;
  externalUrl?: string;
  mergeability?: PiMergeability;
  errorCode?: string;
};

export interface PiPullRequestGateway {
  createPullRequest(input: PiPullRequestGatewayInput): Promise<PiExternalActionResult>;
  refreshMergeability(input: PiPullRequestGatewayInput): Promise<PiExternalActionResult>;
}

export type PiMergeGatewayInput = PiPullRequestGatewayInput & { pullRequestId: string; targetBranch: string };
export type PiReleaseGatewayInput = PiMergeGatewayInput & { environment: string; artifactDigest: string; releaseProposalId: string };

export interface PiChangeReleaseGateway {
  proposeMerge(input: PiMergeGatewayInput): Promise<PiExternalActionResult>;
  proposeRelease(input: PiReleaseGatewayInput): Promise<PiExternalActionResult>;
}

export interface PiChangeDeliveryStore {
  findSubmissionByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiChangeSubmission | null>;
  createSubmission(submission: PiChangeSubmission): Promise<{ submission: PiChangeSubmission; created: boolean }>;
  getSubmission(context: RequestContext, submissionId: string): Promise<PiChangeSubmission | null>;
  listSubmissions(context: RequestContext): Promise<PiChangeSubmission[]>;
  updateSubmission(context: RequestContext, submissionId: string, expectedVersion: number, patch: { status: PiChangeSubmissionStatus; updatedAt: string }): Promise<PiChangeSubmission | null>;
  getPullRequest(context: RequestContext, pullRequestId: string): Promise<PiPullRequest | null>;
  getPullRequestForSubmission(context: RequestContext, submissionId: string): Promise<PiPullRequest | null>;
  listPullRequests(context: RequestContext): Promise<PiPullRequest[]>;
  createPullRequest(pullRequest: PiPullRequest): Promise<{ pullRequest: PiPullRequest; created: boolean }>;
  updatePullRequest(context: RequestContext, pullRequestId: string, expectedVersion: number, patch: Partial<Pick<PiPullRequest, "status" | "mergeability" | "externalId" | "externalUrl" | "updatedAt">>): Promise<PiPullRequest | null>;
  findMergeProposalByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiMergeProposal | null>;
  createMergeProposal(proposal: PiMergeProposal): Promise<{ proposal: PiMergeProposal; created: boolean }>;
  getMergeProposal(context: RequestContext, proposalId: string): Promise<PiMergeProposal | null>;
  listMergeProposals(context: RequestContext): Promise<PiMergeProposal[]>;
  updateMergeProposal(context: RequestContext, proposalId: string, expectedVersion: number, patch: { status: PiProposalStatus; updatedAt: string }): Promise<PiMergeProposal | null>;
  findReleaseProposalByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiReleaseProposal | null>;
  createReleaseProposal(proposal: PiReleaseProposal): Promise<{ proposal: PiReleaseProposal; created: boolean }>;
  getReleaseProposal(context: RequestContext, proposalId: string): Promise<PiReleaseProposal | null>;
  listReleaseProposals(context: RequestContext): Promise<PiReleaseProposal[]>;
  updateReleaseProposal(context: RequestContext, proposalId: string, expectedVersion: number, patch: { status: PiProposalStatus; updatedAt: string }): Promise<PiReleaseProposal | null>;
  findOutboxByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiDeliveryOutbox | null>;
  createOutbox(outbox: PiDeliveryOutbox): Promise<{ outbox: PiDeliveryOutbox; created: boolean }>;
  getOutbox(context: RequestContext, outboxId: string): Promise<PiDeliveryOutbox | null>;
  listOutbox(context: RequestContext): Promise<PiDeliveryOutbox[]>;
  activateOutbox(context: RequestContext, outboxId: string, expectedVersion: number, updatedAt: string): Promise<PiDeliveryOutbox | null>;
  claimOutbox(context: RequestContext, outboxId: string, expectedVersion: number, now: string, leaseOwner: string, leaseToken: string, leaseMs: number): Promise<PiDeliveryOutbox | null>;
  reclaimExpiredOutbox(context: RequestContext, outboxId: string, expectedVersion: number, now: string, leaseOwner: string, leaseToken: string, leaseMs: number): Promise<PiDeliveryOutbox | null>;
  completeOutbox(context: RequestContext, outboxId: string, expectedVersion: number, input: { leaseToken: string; status: PiDeliveryOutboxStatus; resultDigest: string; externalId?: string; externalUrl?: string; lastErrorCode?: string; updatedAt: string }): Promise<PiDeliveryOutbox | null>;
  appendEvent(event: PiDeliveryEvent): Promise<void>;
  listEvents(context: RequestContext, limit?: number): Promise<PiDeliveryEvent[]>;
}

export type PiChangeDeliveryRuntimeSnapshot = {
  submissions: PiChangeSubmission[];
  pullRequests: PiPullRequest[];
  mergeProposals: PiMergeProposal[];
  releaseProposals: PiReleaseProposal[];
  outbox: PiDeliveryOutbox[];
  events: PiDeliveryEvent[];
};

export type PiChangeArtifactRequirement = PiArtifactType;
