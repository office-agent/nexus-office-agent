import type {
  PiChangeDeliveryRuntimeSnapshot,
  PiChangeSubmission,
  PiDeliveryOutbox,
  PiMergeProposal,
  PiPullRequest,
  PiReleaseProposal,
} from "@/src/modules/pi-agent/domain/change-delivery-contracts";

export function presentChangeSubmission(value: PiChangeSubmission) {
  return {
    id: value.id, sessionId: value.sessionId, runId: value.runId, workspaceRecordId: value.workspaceRecordId, repositoryId: value.repositoryId,
    baseCommitSha: value.baseCommitSha, headCommitSha: value.headCommitSha, branch: value.branch, targetBranch: value.targetBranch, diffDigest: value.diffDigest,
    changeSetDigest: value.changeSetDigest, validationDigest: value.validationDigest, checkpointIds: value.checkpointIds, checks: value.checks, approvalId: value.approvalId,
    approvalHash: value.approvalHash, status: value.status, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

export function presentPullRequest(value: PiPullRequest) {
  return {
    id: value.id, submissionId: value.submissionId, provider: value.provider, repositoryId: value.repositoryId, branch: value.branch, targetBranch: value.targetBranch,
    baseCommitSha: value.baseCommitSha, headCommitSha: value.headCommitSha, externalId: value.externalId, externalUrl: value.externalUrl, status: value.status,
    mergeability: value.mergeability, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

export function presentMergeProposal(value: PiMergeProposal) {
  return { id: value.id, submissionId: value.submissionId, pullRequestId: value.pullRequestId, targetBranch: value.targetBranch, approvalId: value.approvalId, proposalHash: value.proposalHash, status: value.status, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

export function presentReleaseProposal(value: PiReleaseProposal) {
  return { id: value.id, submissionId: value.submissionId, pullRequestId: value.pullRequestId, environment: value.environment, artifactDigest: value.artifactDigest, approvalId: value.approvalId, proposalHash: value.proposalHash, status: value.status, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

export function presentOutbox(value: PiDeliveryOutbox) {
  return { id: value.id, actionType: value.actionType, entityId: value.entityId, approvalId: value.approvalId, proposalHash: value.proposalHash, status: value.status, attempts: value.attempts, maxAttempts: value.maxAttempts, payloadDigest: value.payloadDigest, externalId: value.externalId, externalUrl: value.externalUrl, resultDigest: value.resultDigest, lastErrorCode: value.lastErrorCode, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

export function presentChangeDeliverySnapshot(snapshot: PiChangeDeliveryRuntimeSnapshot) {
  return {
    submissions: snapshot.submissions.map(presentChangeSubmission), pullRequests: snapshot.pullRequests.map(presentPullRequest), mergeProposals: snapshot.mergeProposals.map(presentMergeProposal),
    releaseProposals: snapshot.releaseProposals.map(presentReleaseProposal), outbox: snapshot.outbox.map(presentOutbox), events: snapshot.events.map((event) => ({ id: event.id, sessionId: event.sessionId, runId: event.runId, actionType: event.actionType, entityId: event.entityId, eventType: event.eventType, subjectDigest: event.subjectDigest, traceId: event.traceId, createdAt: event.createdAt })),
  };
}
