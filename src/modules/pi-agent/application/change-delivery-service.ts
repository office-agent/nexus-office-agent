import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { sha256, stableJson } from "@/src/modules/pi-agent/application/manifest";
import type { PiApprovalExecutionPermit, PiApprovalObjectVersions } from "@/src/modules/pi-agent/domain/approval-contracts";
import type {
  PiChangeApprovalGateway,
  PiChangeArtifactRequirement,
  PiChangeDeliveryEvidenceReader,
  PiChangeDeliveryRuntimeSnapshot,
  PiChangeDeliveryStore,
  PiChangeSetValidation,
  PiChangeSetValidationInput,
  PiChangeSubmission,
  PiDeliveryCheck,
  PiDeliveryEvent,
  PiDeliveryEventType,
  PiDeliveryOutbox,
  PiDeliveryOutboxStatus,
  PiExternalActionResult,
  PiMergeProposal,
  PiPullRequest,
  PiPullRequestGateway,
  PiReleaseProposal,
  PiChangeReleaseGateway,
} from "@/src/modules/pi-agent/domain/change-delivery-contracts";
import { FailClosedPiChangeApprovalGateway, FailClosedPiChangeReleaseGateway, FailClosedPiPullRequestGateway } from "@/src/modules/pi-agent/infrastructure/change-delivery-store";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const DIGEST = /^[a-f0-9]{64}$/i;
const FULL_SHA = /^[a-f0-9]{40,64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRANCH = /^(?!refs\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;
const SAFE_ENVIRONMENT = /^[a-z][a-z0-9-]{0,63}$/;
const DEFAULT_OUTBOX_LEASE_MS = 60_000;

function clone<T>(value: T): T { return structuredClone(value); }

function id(value: string, code: string): string {
  const normalized = value.trim();
  if (!ID.test(normalized)) throw new Error(code);
  return normalized;
}

function uuid(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) throw new Error(code);
  return normalized;
}

function digest(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!DIGEST.test(normalized)) throw new Error(code);
  return normalized;
}

function commit(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!FULL_SHA.test(normalized)) throw new Error(code);
  return normalized;
}

function branch(value: string, code: string): string {
  const normalized = value.trim();
  if (!BRANCH.test(normalized) || isProtectedBranch(normalized)) throw new Error(code);
  return normalized;
}

function targetBranch(value: string): string {
  const normalized = value.trim();
  if (!BRANCH.test(normalized)) throw new Error("PI_CHANGE_TARGET_BRANCH_INVALID");
  return normalized;
}

function environment(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SAFE_ENVIRONMENT.test(normalized)) throw new Error("PI_RELEASE_ENVIRONMENT_INVALID");
  return normalized;
}

function isProtectedBranch(value: string): boolean {
  const normalized = value.replace(/^refs\/heads\//, "").toLowerCase();
  return normalized === "main" || normalized === "master" || normalized === "production" || normalized === "prod" || normalized.startsWith("release/");
}

function now(): string { return new Date().toISOString(); }

function errorCode(error: unknown): string {
  const code = error instanceof Error ? error.message.split(":")[0] : "";
  return /^[A-Z0-9_:-]{1,120}$/.test(code) ? code : "PI_CHANGE_EXTERNAL_RESULT_UNKNOWN";
}

function externalUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || normalized.length > 2_000) throw new Error("PI_CHANGE_EXTERNAL_URL_INVALID");
  } catch {
    throw new Error("PI_CHANGE_EXTERNAL_URL_INVALID");
  }
  return normalized;
}

function checkType(type: PiChangeArtifactRequirement): "test" | "scan" | "policy" {
  if (type === "test_report") return "test";
  if (type === "scan_report") return "scan";
  return "policy";
}

function objectVersions(input: { workspaceRecordId: string; baseCommitSha: string; headCommitSha: string; branch: string; targetBranch: string; pullRequestVersion?: number; submissionVersion?: number }): PiApprovalObjectVersions {
  return {
    workspaceRecordId: input.workspaceRecordId,
    baseCommitSha: input.baseCommitSha,
    headCommitSha: input.headCommitSha,
    branch: input.branch,
    targetBranch: input.targetBranch,
    ...(input.pullRequestVersion === undefined ? {} : { pullRequestVersion: input.pullRequestVersion }),
    ...(input.submissionVersion === undefined ? {} : { submissionVersion: input.submissionVersion }),
  };
}

function sameScope(context: RequestContext, value: { tenantId: string; actorId: string }): boolean {
  return context.tenantId === value.tenantId && (context.channel === "system" || context.actorId === value.actorId || context.permissions.includes("pi:change:admin"));
}

type PiChangeSubmitInput = PiChangeSetValidationInput & { idempotencyKey: string };
type PiMergeProposalInput = { idempotencyKey: string; targetBranch?: string };
type PiReleaseProposalInput = { idempotencyKey: string; environment: string; artifactDigest: string; pullRequestId?: string };

export class PiChangeDeliveryService {
  private readonly leaseMs: number;

  constructor(
    private readonly store: PiChangeDeliveryStore,
    private readonly evidence: PiChangeDeliveryEvidenceReader,
    private readonly approvals: PiChangeApprovalGateway = new FailClosedPiChangeApprovalGateway(),
    private readonly pullRequests: PiPullRequestGateway = new FailClosedPiPullRequestGateway(),
    private readonly releases: PiChangeReleaseGateway = new FailClosedPiChangeReleaseGateway(),
    leaseMs = DEFAULT_OUTBOX_LEASE_MS,
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 15 * 60_000) throw new Error("PI_CHANGE_LEASE_DURATION_INVALID");
    this.leaseMs = leaseMs;
  }

  async validateChangeSet(context: RequestContext, input: PiChangeSetValidationInput): Promise<PiChangeSetValidation> {
    assertPiPermission(context, "pi:change:submit");
    const sessionId = uuid(input.sessionId, "PI_CHANGE_SESSION_INVALID");
    const runId = uuid(input.runId, "PI_CHANGE_RUN_INVALID");
    const workspaceRecordId = uuid(input.workspaceRecordId, "PI_CHANGE_WORKSPACE_INVALID");
    const repositoryId = uuid(input.repositoryId, "PI_CHANGE_REPOSITORY_INVALID");
    const baseCommitSha = commit(input.baseCommitSha, "PI_CHANGE_BASE_COMMIT_INVALID");
    const requestedTargetBranch = targetBranch(input.targetBranch);
    const checkpointIds = [...new Set(input.checkpointIds.map((value) => uuid(value, "PI_CHANGE_CHECKPOINT_INVALID")))].sort();
    const artifactIds = [...new Set(input.artifactIds.map((value) => uuid(value, "PI_CHANGE_ARTIFACT_INVALID")))].sort();
    if (checkpointIds.length === 0) throw new Error("PI_CHANGE_CHECKPOINT_REQUIRED");
    if (artifactIds.length === 0) throw new Error("PI_CHANGE_ARTIFACT_REQUIRED");
    const workspace = await this.evidence.getWorkspace(context, workspaceRecordId);
    if (!sameScope(context, workspace) || workspace.sessionId !== sessionId || workspace.runId !== runId || workspace.repositoryId !== repositoryId) throw new Error("PI_CHANGE_SCOPE_MISMATCH");
    if (!(["ready", "destroyed"] as string[]).includes(workspace.status)) throw new Error("PI_CHANGE_WORKSPACE_NOT_DELIVERABLE");
    if (workspace.baseCommitSha.toLowerCase() !== baseCommitSha) throw new Error("PI_CHANGE_BASE_COMMIT_MISMATCH");
    if (!workspace.headCommitSha) throw new Error("PI_CHANGE_HEAD_COMMIT_MISSING");
    const headCommitSha = commit(workspace.headCommitSha, "PI_CHANGE_HEAD_COMMIT_INVALID");
    const diff = await this.evidence.deliveryDiff(context, workspaceRecordId);
    if (diff.baseCommitSha.toLowerCase() !== baseCommitSha) throw new Error("PI_CHANGE_DIFF_BASE_MISMATCH");
    const diffDigest = digest(diff.diffDigest, "PI_CHANGE_DIFF_DIGEST_INVALID");
    const checkpoints = await this.evidence.checkpoints(context, sessionId);
    const checkpointById = new Map(checkpoints.map((item) => [item.id, item]));
    const selectedCheckpoints = checkpointIds.map((checkpointId) => checkpointById.get(checkpointId));
    if (selectedCheckpoints.some((item) => !item || item.sessionId !== sessionId)) throw new Error("PI_CHANGE_CHECKPOINT_NOT_FOUND");
    if (selectedCheckpoints.some((item) => item && item.diffDigest !== diffDigest)) throw new Error("PI_CHANGE_CHECKPOINT_DIFF_MISMATCH");
    if (selectedCheckpoints.every((item) => !item?.gitCommitSha || item.gitCommitSha.toLowerCase() !== headCommitSha)) throw new Error("PI_CHANGE_CHECKPOINT_HEAD_MISMATCH");
    const artifacts = await this.evidence.listArtifacts(context, sessionId);
    const selectedArtifacts = artifactIds.map((artifactId) => artifacts.find((item) => item.id === artifactId));
    if (selectedArtifacts.some((item) => !item || item.sessionId !== sessionId || (item.runId ?? "") !== runId)) throw new Error("PI_CHANGE_ARTIFACT_SCOPE_MISMATCH");
    if (selectedArtifacts.some((item) => item && item.status !== "active")) throw new Error("PI_CHANGE_ARTIFACT_NOT_ACTIVE");
    const checks: PiDeliveryCheck[] = selectedArtifacts.map((artifact) => ({ id: artifact!.id, type: checkType(artifact!.type), status: "passed", evidenceDigest: artifact!.contentDigest, artifactId: artifact!.id }));
    if (!checks.some((item) => item.type === "test" && item.status === "passed")) throw new Error("PI_CHANGE_TEST_REPORT_REQUIRED");
    const generatedAt = now();
    const validationDigest = sha256(stableJson({ sessionId, runId, workspaceRecordId, repositoryId, baseCommitSha, headCommitSha, branch: workspace.ephemeralBranch, targetBranch: requestedTargetBranch, diffDigest, checkpointIds, checks: checks.map((item) => ({ id: item.id, type: item.type, status: item.status, evidenceDigest: item.evidenceDigest })) }));
    const changeSetDigest = sha256(stableJson({ validationDigest, workspaceDigest: workspace.workspaceDigest ?? null, provider: workspace.provider }));
    const validation: PiChangeSetValidation = { sessionId, runId, workspaceRecordId, repositoryId, baseCommitSha, headCommitSha, branch: branch(workspace.ephemeralBranch, "PI_CHANGE_BRANCH_INVALID"), targetBranch: requestedTargetBranch, diffDigest, changeSetDigest, validationDigest, checkpointIds, checks, generatedAt };
    await this.emit(context, sessionId, runId, workspaceRecordId, validation.changeSetDigest, "create_pull_request", "pi.change.validated", validation.generatedAt);
    return validation;
  }

  async submitChange(context: RequestContext, input: PiChangeSubmitInput): Promise<{ submission: PiChangeSubmission; validation?: PiChangeSetValidation; created: boolean }> {
    assertPiPermission(context, "pi:change:submit");
    const idempotencyKey = id(input.idempotencyKey, "PI_IDEMPOTENCY_KEY_INVALID");
    const existing = await this.store.findSubmissionByIdempotency(context, idempotencyKey);
    if (existing) return { submission: existing, created: false };
    const validation = await this.validateChangeSet(context, input);
    const approval = await this.approvals.createProposal(context, {
      sessionId: validation.sessionId,
      runId: validation.runId,
      toolName: "change.create_pull_request",
      toolVersion: 1,
      profile: "coding",
      riskLevel: "R2",
      preview: `为 ${validation.branch} 创建受保护变更交付提案`,
      inputDigest: validation.changeSetDigest,
      expectedObjectVersions: objectVersions(validation),
      idempotencyKey: `pi-change-approval:${idempotencyKey}`,
    });
    const timestamp = validation.generatedAt;
    const submission: PiChangeSubmission = {
      id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, sessionId: validation.sessionId, runId: validation.runId,
      workspaceRecordId: validation.workspaceRecordId, repositoryId: validation.repositoryId, baseCommitSha: validation.baseCommitSha, headCommitSha: validation.headCommitSha,
      branch: validation.branch, targetBranch: validation.targetBranch, diffDigest: validation.diffDigest, changeSetDigest: validation.changeSetDigest, validationDigest: validation.validationDigest,
      checkpointIds: validation.checkpointIds, checks: clone(validation.checks), approvalId: approval.approval.id, approvalHash: digest(approval.approval.proposalHash, "PI_CHANGE_APPROVAL_HASH_INVALID"), status: "awaiting_approval", version: 1,
      idempotencyKey, createdAt: timestamp, updatedAt: timestamp,
    };
    const created = await this.store.createSubmission(submission);
    if (!created.created && (created.submission.actorId !== context.actorId || created.submission.changeSetDigest !== submission.changeSetDigest)) throw new Error("PI_IDEMPOTENCY_CONFLICT");
    if (created.created) await this.emit(context, submission.sessionId, submission.runId, submission.id, submission.changeSetDigest, "create_pull_request", "pi.change.submitted", timestamp);
    return { submission: created.submission, validation, created: created.created };
  }

  async createPullRequest(context: RequestContext, submissionId: string): Promise<{ pullRequest: PiPullRequest; outbox: PiDeliveryOutbox; created: boolean }> {
    assertPiPermission(context, "pi:change:submit");
    const submission = await this.requireSubmission(context, submissionId);
    const existing = await this.store.getPullRequestForSubmission(context, submission.id);
    if (existing) {
      const outbox = (await this.store.listOutbox(context)).find((item) => item.actionType === "create_pull_request" && item.entityId === existing.id);
      if (!outbox) throw new Error("PI_CHANGE_OUTBOX_MISSING");
      return { pullRequest: existing, outbox, created: false };
    }
    if (!["awaiting_approval", "queued"].includes(submission.status)) throw new Error("PI_CHANGE_SUBMISSION_STATE_CONFLICT");
    await this.requirePermit(context, submission.approvalId, submission.approvalHash, "change.create_pull_request", submission.sessionId, submission.runId, submission.changeSetDigest);
    const workspace = await this.evidence.getWorkspace(context, submission.workspaceRecordId);
    if (workspace.repositoryId !== submission.repositoryId || !sameScope(context, workspace)) throw new Error("PI_CHANGE_SCOPE_MISMATCH");
    const timestamp = now();
    const pullRequest: PiPullRequest = {
      id: randomUUID(), tenantId: context.tenantId, actorId: submission.actorId, submissionId: submission.id, provider: workspace.provider,
      repositoryId: submission.repositoryId, repositoryRef: workspace.repositoryRef, branch: submission.branch, targetBranch: submission.targetBranch,
      baseCommitSha: submission.baseCommitSha, headCommitSha: submission.headCommitSha, status: "pending", mergeability: "unknown", version: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    const stored = await this.store.createPullRequest(pullRequest);
    const outbox = await this.queueOutbox(context, { actionType: "create_pull_request", entityId: stored.pullRequest.id, sessionId: submission.sessionId, runId: submission.runId, approvalId: submission.approvalId, proposalHash: submission.approvalHash, approvalReady: true, idempotencyKey: `pi-change-pr:${submission.id}`, payload: stored.pullRequest });
    const updated = await this.store.updateSubmission(context, submission.id, submission.version, { status: "queued", updatedAt: timestamp });
    if (!updated) throw new Error("PI_CHANGE_VERSION_CONFLICT");
    if (stored.created) await this.emit(context, submission.sessionId, submission.runId, stored.pullRequest.id, stored.pullRequest.id, "create_pull_request", "pi.change.pull_request_queued", timestamp);
    return { pullRequest: stored.pullRequest, outbox, created: stored.created };
  }

  async refreshMergeability(context: RequestContext, pullRequestId: string): Promise<PiDeliveryOutbox> {
    assertPiPermission(context, "pi:change:read");
    const pullRequest = await this.requirePullRequest(context, pullRequestId);
    if (!["open", "mergeable", "conflicted"].includes(pullRequest.status)) throw new Error("PI_CHANGE_PULL_REQUEST_STATE_CONFLICT");
    return this.queueOutbox(context, { actionType: "refresh_mergeability", entityId: pullRequest.id, sessionId: (await this.requireSubmission(context, pullRequest.submissionId)).sessionId, runId: (await this.requireSubmission(context, pullRequest.submissionId)).runId, idempotencyKey: `pi-change-mergeability:${pullRequest.id}:${pullRequest.version}`, payload: pullRequest });
  }

  async proposeMerge(context: RequestContext, pullRequestId: string, input: PiMergeProposalInput): Promise<{ proposal: PiMergeProposal; outbox: PiDeliveryOutbox; created: boolean }> {
    assertPiPermission(context, "pi:change:merge");
    const idempotencyKey = id(input.idempotencyKey, "PI_IDEMPOTENCY_KEY_INVALID");
    const existing = await this.store.findMergeProposalByIdempotency(context, idempotencyKey);
    if (existing) return { proposal: existing, outbox: await this.requireOutboxForEntity(context, "propose_merge", existing.id), created: false };
    const pullRequest = await this.requirePullRequest(context, pullRequestId);
    if (!["mergeable", "open"].includes(pullRequest.status)) throw new Error("PI_CHANGE_PULL_REQUEST_NOT_MERGEABLE");
    const submission = await this.requireSubmission(context, pullRequest.submissionId);
    const requestedTarget = input.targetBranch ? targetBranch(input.targetBranch) : pullRequest.targetBranch;
    if (!isProtectedBranch(requestedTarget)) throw new Error("PI_CHANGE_MERGE_TARGET_NOT_PROTECTED");
    const approval = await this.approvals.createProposal(context, {
      sessionId: submission.sessionId, runId: submission.runId, toolName: "change.propose_merge", toolVersion: 1, profile: "release", riskLevel: "R3",
      preview: `将变更合并到 ${requestedTarget}`, inputDigest: submission.changeSetDigest,
      expectedObjectVersions: objectVersions({ workspaceRecordId: submission.workspaceRecordId, baseCommitSha: submission.baseCommitSha, headCommitSha: submission.headCommitSha, branch: submission.branch, targetBranch: requestedTarget, pullRequestVersion: pullRequest.version, submissionVersion: submission.version }),
      idempotencyKey: `pi-change-merge-approval:${idempotencyKey}`,
    });
    const timestamp = now();
    const proposal: PiMergeProposal = {
      id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, sessionId: submission.sessionId, runId: submission.runId, submissionId: submission.id, pullRequestId: pullRequest.id,
      targetBranch: requestedTarget, approvalId: approval.approval.id, proposalHash: digest(approval.approval.proposalHash, "PI_CHANGE_APPROVAL_HASH_INVALID"),
      expectedObjectVersions: objectVersions({ workspaceRecordId: submission.workspaceRecordId, baseCommitSha: submission.baseCommitSha, headCommitSha: submission.headCommitSha, branch: submission.branch, targetBranch: requestedTarget, pullRequestVersion: pullRequest.version, submissionVersion: submission.version }),
      status: "awaiting_approval", version: 1, idempotencyKey, createdAt: timestamp, updatedAt: timestamp,
    };
    const stored = await this.store.createMergeProposal(proposal);
    const outbox = await this.queueOutbox(context, { actionType: "propose_merge", entityId: stored.proposal.id, sessionId: proposal.sessionId, runId: proposal.runId, approvalId: proposal.approvalId, proposalHash: proposal.proposalHash, idempotencyKey: `pi-change-merge:${proposal.id}`, payload: proposal });
    if (stored.created) await this.emit(context, proposal.sessionId, proposal.runId, proposal.id, proposal.proposalHash, "propose_merge", "pi.change.merge_proposed", timestamp);
    return { proposal: stored.proposal, outbox, created: stored.created };
  }

  async proposeRelease(context: RequestContext, submissionId: string, input: PiReleaseProposalInput): Promise<{ proposal: PiReleaseProposal; outbox: PiDeliveryOutbox; created: boolean }> {
    assertPiPermission(context, "pi:change:release");
    const idempotencyKey = id(input.idempotencyKey, "PI_IDEMPOTENCY_KEY_INVALID");
    const existing = await this.store.findReleaseProposalByIdempotency(context, idempotencyKey);
    if (existing) return { proposal: existing, outbox: await this.requireOutboxForEntity(context, "propose_release", existing.id), created: false };
    const submission = await this.requireSubmission(context, submissionId);
    const pullRequest = input.pullRequestId ? await this.requirePullRequest(context, input.pullRequestId) : await this.store.getPullRequestForSubmission(context, submission.id);
    if (!pullRequest || pullRequest.submissionId !== submission.id || !["mergeable", "merged", "open"].includes(pullRequest.status)) throw new Error("PI_CHANGE_PULL_REQUEST_REQUIRED");
    const artifacts = await this.evidence.listArtifacts(context, submission.sessionId);
    const hasScan = submission.checks.some((check) => check.type === "scan" && check.status === "passed" && artifacts.some((artifact) => artifact.id === check.artifactId && artifact.status === "active"));
    if (!hasScan) throw new Error("PI_CHANGE_SCAN_REQUIRED");
    const releaseEnvironment = environment(input.environment);
    const artifactDigest = digest(input.artifactDigest, "PI_RELEASE_ARTIFACT_DIGEST_INVALID");
    const approval = await this.approvals.createProposal(context, {
      sessionId: submission.sessionId, runId: submission.runId, toolName: "change.propose_release", toolVersion: 1, profile: "release", riskLevel: "R3",
      preview: `为 ${releaseEnvironment} 创建发布提案`, inputDigest: artifactDigest,
      expectedObjectVersions: objectVersions({ workspaceRecordId: submission.workspaceRecordId, baseCommitSha: submission.baseCommitSha, headCommitSha: submission.headCommitSha, branch: submission.branch, targetBranch: submission.targetBranch, pullRequestVersion: pullRequest.version, submissionVersion: submission.version }),
      idempotencyKey: `pi-change-release-approval:${idempotencyKey}`,
    });
    const timestamp = now();
    const proposal: PiReleaseProposal = {
      id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, sessionId: submission.sessionId, runId: submission.runId, submissionId: submission.id, pullRequestId: pullRequest.id,
      environment: releaseEnvironment, artifactDigest, approvalId: approval.approval.id, proposalHash: digest(approval.approval.proposalHash, "PI_CHANGE_APPROVAL_HASH_INVALID"),
      expectedObjectVersions: objectVersions({ workspaceRecordId: submission.workspaceRecordId, baseCommitSha: submission.baseCommitSha, headCommitSha: submission.headCommitSha, branch: submission.branch, targetBranch: submission.targetBranch, pullRequestVersion: pullRequest.version, submissionVersion: submission.version }),
      status: "awaiting_approval", version: 1, idempotencyKey, createdAt: timestamp, updatedAt: timestamp,
    };
    const stored = await this.store.createReleaseProposal(proposal);
    const outbox = await this.queueOutbox(context, { actionType: "propose_release", entityId: stored.proposal.id, sessionId: proposal.sessionId, runId: proposal.runId, approvalId: proposal.approvalId, proposalHash: proposal.proposalHash, idempotencyKey: `pi-change-release:${proposal.id}`, payload: proposal });
    if (stored.created) await this.emit(context, proposal.sessionId, proposal.runId, proposal.id, proposal.proposalHash, "propose_release", "pi.change.release_proposed", timestamp);
    return { proposal: stored.proposal, outbox, created: stored.created };
  }

  async dispatchOutbox(context: RequestContext, outboxId: string): Promise<PiDeliveryOutbox> {
    if (context.channel !== "system") throw new Error("PI_CHANGE_DISPATCH_SYSTEM_ONLY");
    let current = await this.requireOutbox(context, outboxId);
    if (["succeeded", "failed", "unknown", "cancelled"].includes(current.status)) return current;
    const claimedAt = now();
    if (current.status === "leased") {
      if (!current.leaseExpiresAt || new Date(current.leaseExpiresAt) > new Date(claimedAt)) return current;
      const leaseToken = randomUUID();
      const reclaimed = await this.store.reclaimExpiredOutbox(context, current.id, current.version, claimedAt, context.traceId, leaseToken, this.leaseMs);
      if (!reclaimed) throw new Error("PI_CHANGE_OUTBOX_STATE_CONFLICT");
      const unknown: PiExternalActionResult = { status: "unknown", resultDigest: sha256(stableJson({ actionType: reclaimed.actionType, entityId: reclaimed.entityId, code: "PI_CHANGE_LEASE_EXPIRED" })), errorCode: "PI_CHANGE_LEASE_EXPIRED" };
      return this.recordExternalResultInternal(context, reclaimed, unknown, leaseToken);
    }
    if (["create_pull_request", "propose_merge", "propose_release"].includes(current.actionType)) {
      const ready = await this.prepareProtectedOutbox(context, current);
      if (!ready) return current;
      current = ready;
    }
    const leaseToken = randomUUID();
    const leased = await this.store.claimOutbox(context, current.id, current.version, claimedAt, context.traceId, leaseToken, this.leaseMs);
    if (!leased) throw new Error("PI_CHANGE_OUTBOX_STATE_CONFLICT");
    try {
      const result = await this.callGateway(context, leased);
      return await this.recordExternalResultInternal(context, leased, result, leaseToken);
    } catch (error) {
      const code = errorCode(error);
      const unknown: PiExternalActionResult = { status: "unknown", resultDigest: sha256(stableJson({ actionType: leased.actionType, entityId: leased.entityId, code })), errorCode: code };
      return this.recordExternalResultInternal(context, leased, unknown, leaseToken);
    }
  }

  async recordExternalResult(context: RequestContext, outboxId: string, result: PiExternalActionResult): Promise<PiDeliveryOutbox> {
    if (context.channel !== "system") throw new Error("PI_CHANGE_DISPATCH_SYSTEM_ONLY");
    const outbox = await this.requireOutbox(context, outboxId);
    if (outbox.status !== "leased" || !outbox.leaseToken) throw new Error("PI_CHANGE_OUTBOX_NOT_LEASED");
    return this.recordExternalResultInternal(context, outbox, result, outbox.leaseToken);
  }

  async snapshot(context: RequestContext): Promise<PiChangeDeliveryRuntimeSnapshot> {
    assertPiPermission(context, "pi:change:read");
    const [submissions, pullRequests, mergeProposals, releaseProposals, outbox, events] = await Promise.all([
      this.store.listSubmissions(context), this.store.listPullRequests(context), this.store.listMergeProposals(context), this.store.listReleaseProposals(context), this.store.listOutbox(context), this.store.listEvents(context),
    ]);
    return { submissions, pullRequests, mergeProposals, releaseProposals, outbox, events };
  }

  async getSubmission(context: RequestContext, submissionId: string): Promise<PiChangeSubmission> { assertPiPermission(context, "pi:change:read"); return this.requireSubmission(context, submissionId); }
  async getPullRequest(context: RequestContext, pullRequestId: string): Promise<PiPullRequest> { assertPiPermission(context, "pi:change:read"); return this.requirePullRequest(context, pullRequestId); }
  async getOutbox(context: RequestContext, outboxId: string): Promise<PiDeliveryOutbox> { assertPiPermission(context, "pi:change:read"); return this.requireOutbox(context, outboxId); }

  private async queueOutbox(context: RequestContext, input: { actionType: PiDeliveryOutbox["actionType"]; entityId: string; sessionId: string; runId: string; approvalId?: string; proposalHash?: string; approvalReady?: boolean; idempotencyKey: string; payload: unknown }): Promise<PiDeliveryOutbox> {
    const idempotencyKey = id(input.idempotencyKey, "PI_IDEMPOTENCY_KEY_INVALID");
    const existing = await this.store.findOutboxByIdempotency(context, idempotencyKey);
    if (existing) return existing;
    const protectedAction = ["create_pull_request", "propose_merge", "propose_release"].includes(input.actionType);
    const outbox: PiDeliveryOutbox = {
      id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, sessionId: uuid(input.sessionId, "PI_CHANGE_SESSION_INVALID"), runId: uuid(input.runId, "PI_CHANGE_RUN_INVALID"),
      actionType: input.actionType, entityId: id(input.entityId, "PI_CHANGE_ENTITY_INVALID"), ...(input.approvalId ? { approvalId: uuid(input.approvalId, "PI_CHANGE_APPROVAL_INVALID") } : {}), ...(input.proposalHash ? { proposalHash: digest(input.proposalHash, "PI_CHANGE_APPROVAL_HASH_INVALID") } : {}),
      status: protectedAction && !input.approvalReady ? "awaiting_approval" : "queued", attempts: 0, maxAttempts: 1, idempotencyKey, payloadDigest: sha256(stableJson(input.payload)), version: 1, createdAt: now(), updatedAt: now(),
    };
    return (await this.store.createOutbox(outbox)).outbox;
  }

  private async prepareProtectedOutbox(context: RequestContext, current: PiDeliveryOutbox): Promise<PiDeliveryOutbox | null> {
    if (!current.approvalId || !current.proposalHash) throw new Error("PI_CHANGE_APPROVAL_REQUIRED");
    const subject = await this.deliverySubject(context, current);
    let permit: PiApprovalExecutionPermit;
    try {
      permit = await this.approvals.resumeToolCall(context, current.approvalId);
    } catch (error) {
      const code = errorCode(error);
      // Pending, expired infrastructure, or a concurrent approval transition must
      // not be interpreted as an external side effect. Leave the fact untouched
      // so a later approval/worker cycle can decide it again.
      if (["PI_APPROVAL_NOT_APPROVED", "PI_APPROVAL_STATE_CONFLICT", "PI_APPROVAL_REVALIDATION_UNAVAILABLE"].includes(code)) return null;
      throw error;
    }
    this.assertPermit(permit, current, subject.changeSetDigest, subject.sessionId, subject.runId);
    if (current.status !== "awaiting_approval") return current;
    const activated = await this.store.activateOutbox(context, current.id, current.version, now());
    if (!activated) throw new Error("PI_CHANGE_OUTBOX_VERSION_CONFLICT");
    return activated;
  }

  private async callGateway(context: RequestContext, outbox: PiDeliveryOutbox): Promise<PiExternalActionResult> {
    const subject = await this.deliverySubject(context, outbox);
    const repository = await this.evidence.getRepository(context, subject.repositoryId);
    if (repository.tenantId !== context.tenantId || repository.status !== "active" || repository.provider !== subject.provider || repository.repositoryRef !== subject.repositoryRef) throw new Error("PI_CHANGE_SCOPE_MISMATCH");
    const input = { tenantId: context.tenantId, actorId: subject.actorId, sessionId: subject.sessionId, runId: subject.runId, repositoryId: subject.repositoryId, provider: repository.provider, repositoryRef: subject.repositoryRef, credentialRef: repository.credentialRef, branch: subject.branch, targetBranch: subject.targetBranch, baseCommitSha: subject.baseCommitSha, headCommitSha: subject.headCommitSha, changeSetDigest: subject.changeSetDigest, idempotencyKey: outbox.idempotencyKey, externalId: subject.externalId, traceId: context.traceId };
    if (outbox.actionType === "create_pull_request") return this.pullRequests.createPullRequest(input);
    if (outbox.actionType === "refresh_mergeability") return this.pullRequests.refreshMergeability(input);
    if (outbox.actionType === "propose_merge") return this.releases.proposeMerge({ ...input, pullRequestId: subject.pullRequestId, targetBranch: subject.targetBranch });
    return this.releases.proposeRelease({ ...input, pullRequestId: subject.pullRequestId, targetBranch: subject.targetBranch, environment: subject.environment, artifactDigest: subject.artifactDigest, releaseProposalId: subject.releaseProposalId });
  }

  private async recordExternalResultInternal(context: RequestContext, outbox: PiDeliveryOutbox, result: PiExternalActionResult, leaseToken: string): Promise<PiDeliveryOutbox> {
    if (!DIGEST.test(result.resultDigest)) throw new Error("PI_CHANGE_RESULT_DIGEST_INVALID");
    const status: PiDeliveryOutboxStatus = result.status;
    if (!["succeeded", "failed", "unknown"].includes(status)) throw new Error("PI_CHANGE_RESULT_STATUS_INVALID");
    const safeExternalUrl = externalUrl(result.externalUrl);
    const updatedEntity = await this.applyEntityResult(context, outbox, result);
    const updated = await this.store.completeOutbox(context, outbox.id, outbox.version, { leaseToken, status, resultDigest: result.resultDigest.toLowerCase(), externalId: result.externalId, externalUrl: safeExternalUrl, lastErrorCode: result.errorCode, updatedAt: now() });
    if (!updated) throw new Error("PI_CHANGE_OUTBOX_VERSION_CONFLICT");
    const eventType: PiDeliveryEventType = status === "unknown" ? "pi.change.external_result_unknown" : outbox.actionType === "create_pull_request" ? "pi.change.pull_request_result" : outbox.actionType === "refresh_mergeability" ? "pi.change.mergeability_queued" : outbox.actionType === "propose_merge" ? "pi.change.merge_proposed" : "pi.change.release_proposed";
    await this.emit(context, outbox.sessionId, outbox.runId, outbox.entityId, updated.resultDigest ?? result.resultDigest, outbox.actionType, eventType, updated.updatedAt, outbox.actorId);
    void updatedEntity;
    return updated;
  }

  private async applyEntityResult(context: RequestContext, outbox: PiDeliveryOutbox, result: PiExternalActionResult): Promise<unknown> {
    const status = result.status;
    if (outbox.actionType === "create_pull_request" || outbox.actionType === "refresh_mergeability") {
      const pullRequest = await this.requirePullRequest(context, outbox.entityId);
      const nextStatus = status === "unknown" ? "unknown" : status === "failed" ? (outbox.actionType === "create_pull_request" ? "failed" : pullRequest.status) : outbox.actionType === "refresh_mergeability" ? result.mergeability === "mergeable" ? "mergeable" : result.mergeability === "conflicted" ? "conflicted" : "open" : "open";
      const updatedPullRequest = await this.store.updatePullRequest(context, pullRequest.id, pullRequest.version, { status: nextStatus as PiPullRequest["status"], mergeability: result.mergeability ?? pullRequest.mergeability, externalId: result.externalId, externalUrl: result.externalUrl, updatedAt: now() });
      if (!updatedPullRequest) throw new Error("PI_CHANGE_PULL_REQUEST_VERSION_CONFLICT");
      const submission = await this.requireSubmission(context, pullRequest.submissionId);
      const nextSubmissionStatus: PiChangeSubmission["status"] = status === "unknown" ? "unknown" : status === "failed" ? "failed" : "submitted";
      const updatedSubmission = await this.store.updateSubmission(context, submission.id, submission.version, { status: nextSubmissionStatus, updatedAt: now() });
      if (!updatedSubmission) throw new Error("PI_CHANGE_SUBMISSION_VERSION_CONFLICT");
      return updatedPullRequest;
    }
    if (outbox.actionType === "propose_merge") {
      const proposal = await this.requireMergeProposal(context, outbox.entityId);
      const updated = await this.store.updateMergeProposal(context, proposal.id, proposal.version, { status, updatedAt: now() });
      if (!updated) throw new Error("PI_CHANGE_MERGE_PROPOSAL_VERSION_CONFLICT");
      if (status === "succeeded") {
        const pullRequest = await this.requirePullRequest(context, proposal.pullRequestId);
        const merged = await this.store.updatePullRequest(context, pullRequest.id, pullRequest.version, { status: "merged", updatedAt: now() });
        if (!merged) throw new Error("PI_CHANGE_PULL_REQUEST_VERSION_CONFLICT");
      }
      return updated;
    }
    const proposal = await this.requireReleaseProposal(context, outbox.entityId);
    const updated = await this.store.updateReleaseProposal(context, proposal.id, proposal.version, { status, updatedAt: now() });
    if (!updated) throw new Error("PI_CHANGE_RELEASE_PROPOSAL_VERSION_CONFLICT");
    return updated;
  }

  private async deliverySubject(context: RequestContext, outbox: PiDeliveryOutbox): Promise<{ actorId: string; sessionId: string; runId: string; repositoryId: string; provider: PiPullRequest["provider"]; repositoryRef: string; branch: string; targetBranch: string; baseCommitSha: string; headCommitSha: string; changeSetDigest: string; externalId?: string; pullRequestId: string; environment: string; artifactDigest: string; releaseProposalId: string }> {
    if (outbox.actionType === "create_pull_request" || outbox.actionType === "refresh_mergeability") {
      const pullRequest = await this.requirePullRequest(context, outbox.entityId);
      const submission = await this.requireSubmission(context, pullRequest.submissionId);
      return { actorId: submission.actorId, sessionId: submission.sessionId, runId: submission.runId, repositoryId: pullRequest.repositoryId, provider: pullRequest.provider, repositoryRef: pullRequest.repositoryRef, branch: pullRequest.branch, targetBranch: pullRequest.targetBranch, baseCommitSha: pullRequest.baseCommitSha, headCommitSha: pullRequest.headCommitSha, changeSetDigest: submission.changeSetDigest, externalId: pullRequest.externalId, pullRequestId: pullRequest.id, environment: "", artifactDigest: "", releaseProposalId: "" };
    }
    if (outbox.actionType === "propose_merge") {
      const proposal = await this.requireMergeProposal(context, outbox.entityId);
      const pullRequest = await this.requirePullRequest(context, proposal.pullRequestId);
      const submission = await this.requireSubmission(context, proposal.submissionId);
      return { actorId: submission.actorId, sessionId: submission.sessionId, runId: submission.runId, repositoryId: pullRequest.repositoryId, provider: pullRequest.provider, repositoryRef: pullRequest.repositoryRef, branch: pullRequest.branch, targetBranch: proposal.targetBranch, baseCommitSha: pullRequest.baseCommitSha, headCommitSha: pullRequest.headCommitSha, changeSetDigest: submission.changeSetDigest, externalId: pullRequest.externalId, pullRequestId: pullRequest.id, environment: "", artifactDigest: "", releaseProposalId: "" };
    }
    const proposal = await this.requireReleaseProposal(context, outbox.entityId);
    const submission = await this.requireSubmission(context, proposal.submissionId);
    const pullRequest = proposal.pullRequestId ? await this.requirePullRequest(context, proposal.pullRequestId) : undefined;
    if (!pullRequest) throw new Error("PI_CHANGE_PULL_REQUEST_REQUIRED");
    return { actorId: submission.actorId, sessionId: submission.sessionId, runId: submission.runId, repositoryId: submission.repositoryId, provider: pullRequest.provider, repositoryRef: pullRequest.repositoryRef, branch: submission.branch, targetBranch: submission.targetBranch, baseCommitSha: submission.baseCommitSha, headCommitSha: submission.headCommitSha, changeSetDigest: submission.changeSetDigest, externalId: pullRequest.externalId, pullRequestId: pullRequest.id, environment: proposal.environment, artifactDigest: proposal.artifactDigest, releaseProposalId: proposal.id };
  }

  private async requirePermit(context: RequestContext, approvalId: string, proposalHash: string, toolName: string, sessionId: string, runId: string, inputDigest: string): Promise<PiApprovalExecutionPermit> {
    const permit = await this.approvals.resumeToolCall(context, approvalId);
    this.assertPermit(permit, { tenantId: context.tenantId, actorId: context.actorId, approvalId, proposalHash }, inputDigest, sessionId, runId, toolName);
    return permit;
  }

  private assertPermit(permit: PiApprovalExecutionPermit, binding: { tenantId: string; actorId: string; approvalId?: string; proposalHash?: string; actionType?: PiDeliveryOutbox["actionType"] }, inputDigest: string, sessionId: string, runId: string, expectedToolName?: string): void {
    if (permit.tenantId !== binding.tenantId || permit.approvalId !== binding.approvalId || permit.requestedBy !== binding.actorId || permit.sessionId !== sessionId || permit.runId !== runId || permit.proposalHash !== binding.proposalHash || permit.toolName !== (expectedToolName ?? this.toolName(binding.actionType!)) || !inputDigest.trim()) throw new Error("PI_CHANGE_APPROVAL_SCOPE_MISMATCH");
  }

  private toolName(actionType: PiDeliveryOutbox["actionType"]): string {
    if (actionType === "create_pull_request") return "change.create_pull_request";
    if (actionType === "propose_merge") return "change.propose_merge";
    if (actionType === "propose_release") return "change.propose_release";
    return "change.refresh_mergeability";
  }

  private async requireSubmission(context: RequestContext, submissionId: string): Promise<PiChangeSubmission> {
    const record = await this.store.getSubmission(context, id(submissionId, "PI_CHANGE_SUBMISSION_ID_INVALID"));
    if (!record) throw new Error("PI_CHANGE_SUBMISSION_NOT_FOUND");
    return record;
  }

  private async requirePullRequest(context: RequestContext, pullRequestId: string): Promise<PiPullRequest> {
    const record = await this.store.getPullRequest(context, id(pullRequestId, "PI_CHANGE_PULL_REQUEST_ID_INVALID"));
    if (!record) throw new Error("PI_CHANGE_PULL_REQUEST_NOT_FOUND");
    return record;
  }

  private async requireMergeProposal(context: RequestContext, proposalId: string): Promise<PiMergeProposal> {
    const record = await this.store.getMergeProposal(context, id(proposalId, "PI_CHANGE_MERGE_PROPOSAL_ID_INVALID"));
    if (!record) throw new Error("PI_CHANGE_MERGE_PROPOSAL_NOT_FOUND");
    return record;
  }

  private async requireReleaseProposal(context: RequestContext, proposalId: string): Promise<PiReleaseProposal> {
    const record = await this.store.getReleaseProposal(context, id(proposalId, "PI_CHANGE_RELEASE_PROPOSAL_ID_INVALID"));
    if (!record) throw new Error("PI_CHANGE_RELEASE_PROPOSAL_NOT_FOUND");
    return record;
  }

  private async requireOutbox(context: RequestContext, outboxId: string): Promise<PiDeliveryOutbox> {
    const record = await this.store.getOutbox(context, id(outboxId, "PI_CHANGE_OUTBOX_ID_INVALID"));
    if (!record) throw new Error("PI_CHANGE_OUTBOX_NOT_FOUND");
    return record;
  }

  private async requireOutboxForEntity(context: RequestContext, actionType: PiDeliveryOutbox["actionType"], entityId: string): Promise<PiDeliveryOutbox> {
    const record = (await this.store.listOutbox(context)).find((item) => item.actionType === actionType && item.entityId === entityId);
    if (!record) throw new Error("PI_CHANGE_OUTBOX_MISSING");
    return record;
  }

  private async emit(context: RequestContext, sessionId: string, runId: string, entityId: string, subject: string, actionType: PiDeliveryEvent["actionType"], eventType: PiDeliveryEventType, createdAt: string, actorId = context.actorId): Promise<void> {
    const subjectDigest = DIGEST.test(subject) ? subject.toLowerCase() : sha256(subject);
    const event: PiDeliveryEvent = { id: randomUUID(), tenantId: context.tenantId, actorId, sessionId, runId, actionType, entityId, eventType, subjectDigest, traceId: context.traceId, createdAt };
    await this.store.appendEvent(event);
  }
}
