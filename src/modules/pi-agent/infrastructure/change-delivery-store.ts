import type { RequestContext } from "@/src/platform/context/request-context";
import type {
  PiChangeApprovalGateway,
  PiChangeDeliveryStore,
  PiChangeSubmission,
  PiDeliveryEvent,
  PiDeliveryOutbox,
  PiMergeProposal,
  PiProposalStatus,
  PiPullRequest,
  PiReleaseProposal,
  PiDeliveryOutboxStatus,
  PiChangeReleaseGateway,
  PiPullRequestGateway,
} from "@/src/modules/pi-agent/domain/change-delivery-contracts";

function clone<T>(value: T): T { return structuredClone(value); }

function canSee(context: RequestContext, tenantId: string, actorId: string): boolean {
  return context.tenantId === tenantId && (context.channel === "system" || context.actorId === actorId || context.permissions.includes("pi:change:admin"));
}

function visible<T extends { tenantId: string; actorId: string }>(context: RequestContext, value: T): boolean {
  return canSee(context, value.tenantId, value.actorId);
}

function updateVersion<T extends { version: number }>(value: T, expectedVersion: number): T {
  if (value.version !== expectedVersion) throw new Error("PI_CHANGE_VERSION_CONFLICT");
  return { ...value, version: value.version + 1 };
}

export class InMemoryPiChangeDeliveryStore implements PiChangeDeliveryStore {
  private readonly submissions = new Map<string, PiChangeSubmission>();
  private readonly pullRequests = new Map<string, PiPullRequest>();
  private readonly mergeProposals = new Map<string, PiMergeProposal>();
  private readonly releaseProposals = new Map<string, PiReleaseProposal>();
  private readonly outbox = new Map<string, PiDeliveryOutbox>();
  private readonly events: PiDeliveryEvent[] = [];

  private submissionKey(tenantId: string, id: string): string { return `${tenantId}:${id}`; }
  private idemKey(tenantId: string, key: string): string { return `${tenantId}:${key}`; }

  async findSubmissionByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiChangeSubmission | null> {
    const value = [...this.submissions.values()].find((item) => item.tenantId === context.tenantId && item.idempotencyKey === idempotencyKey && canSee(context, item.tenantId, item.actorId));
    return value ? clone(value) : null;
  }

  async createSubmission(submission: PiChangeSubmission): Promise<{ submission: PiChangeSubmission; created: boolean }> {
    const key = this.submissionKey(submission.tenantId, submission.id);
    const existing = [...this.submissions.values()].find((item) => item.tenantId === submission.tenantId && item.idempotencyKey === submission.idempotencyKey);
    if (existing) return { submission: clone(existing), created: false };
    this.submissions.set(key, clone(submission));
    return { submission: clone(submission), created: true };
  }

  async getSubmission(context: RequestContext, submissionId: string): Promise<PiChangeSubmission | null> {
    const value = this.submissions.get(this.submissionKey(context.tenantId, submissionId));
    return value && visible(context, value) ? clone(value) : null;
  }

  async listSubmissions(context: RequestContext): Promise<PiChangeSubmission[]> {
    return [...this.submissions.values()].filter((item) => visible(context, item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async updateSubmission(context: RequestContext, submissionId: string, expectedVersion: number, patch: { status: PiChangeSubmission["status"]; updatedAt: string }): Promise<PiChangeSubmission | null> {
    const key = this.submissionKey(context.tenantId, submissionId);
    const current = this.submissions.get(key);
    if (!current || !visible(context, current)) return null;
    const updated = { ...updateVersion(current, expectedVersion), status: patch.status, updatedAt: patch.updatedAt };
    this.submissions.set(key, updated);
    return clone(updated);
  }

  async getPullRequest(context: RequestContext, pullRequestId: string): Promise<PiPullRequest | null> {
    const value = this.pullRequests.get(this.submissionKey(context.tenantId, pullRequestId));
    return value && visible(context, value) ? clone(value) : null;
  }

  async getPullRequestForSubmission(context: RequestContext, submissionId: string): Promise<PiPullRequest | null> {
    const value = [...this.pullRequests.values()].find((item) => item.tenantId === context.tenantId && item.submissionId === submissionId && visible(context, item));
    return value ? clone(value) : null;
  }

  async listPullRequests(context: RequestContext): Promise<PiPullRequest[]> {
    return [...this.pullRequests.values()].filter((item) => visible(context, item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async createPullRequest(pullRequest: PiPullRequest): Promise<{ pullRequest: PiPullRequest; created: boolean }> {
    const existing = [...this.pullRequests.values()].find((item) => item.tenantId === pullRequest.tenantId && item.submissionId === pullRequest.submissionId);
    if (existing) return { pullRequest: clone(existing), created: false };
    this.pullRequests.set(this.submissionKey(pullRequest.tenantId, pullRequest.id), clone(pullRequest));
    return { pullRequest: clone(pullRequest), created: true };
  }

  async updatePullRequest(context: RequestContext, pullRequestId: string, expectedVersion: number, patch: Partial<Pick<PiPullRequest, "status" | "mergeability" | "externalId" | "externalUrl" | "updatedAt">>): Promise<PiPullRequest | null> {
    const key = this.submissionKey(context.tenantId, pullRequestId);
    const current = this.pullRequests.get(key);
    if (!current || !visible(context, current)) return null;
    const updated = { ...updateVersion(current, expectedVersion), ...patch };
    this.pullRequests.set(key, updated);
    return clone(updated);
  }

  async findMergeProposalByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiMergeProposal | null> {
    const value = [...this.mergeProposals.values()].find((item) => item.tenantId === context.tenantId && item.idempotencyKey === idempotencyKey && visible(context, item));
    return value ? clone(value) : null;
  }

  async createMergeProposal(proposal: PiMergeProposal): Promise<{ proposal: PiMergeProposal; created: boolean }> {
    const existing = [...this.mergeProposals.values()].find((item) => item.tenantId === proposal.tenantId && item.idempotencyKey === proposal.idempotencyKey);
    if (existing) return { proposal: clone(existing), created: false };
    this.mergeProposals.set(this.submissionKey(proposal.tenantId, proposal.id), clone(proposal));
    return { proposal: clone(proposal), created: true };
  }

  async getMergeProposal(context: RequestContext, proposalId: string): Promise<PiMergeProposal | null> {
    const value = this.mergeProposals.get(this.submissionKey(context.tenantId, proposalId));
    return value && visible(context, value) ? clone(value) : null;
  }

  async listMergeProposals(context: RequestContext): Promise<PiMergeProposal[]> {
    return [...this.mergeProposals.values()].filter((item) => visible(context, item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async updateMergeProposal(context: RequestContext, proposalId: string, expectedVersion: number, patch: { status: PiProposalStatus; updatedAt: string }): Promise<PiMergeProposal | null> {
    const key = this.submissionKey(context.tenantId, proposalId);
    const current = this.mergeProposals.get(key);
    if (!current || !visible(context, current)) return null;
    const updated = { ...updateVersion(current, expectedVersion), ...patch };
    this.mergeProposals.set(key, updated);
    return clone(updated);
  }

  async findReleaseProposalByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiReleaseProposal | null> {
    const value = [...this.releaseProposals.values()].find((item) => item.tenantId === context.tenantId && item.idempotencyKey === idempotencyKey && visible(context, item));
    return value ? clone(value) : null;
  }

  async createReleaseProposal(proposal: PiReleaseProposal): Promise<{ proposal: PiReleaseProposal; created: boolean }> {
    const existing = [...this.releaseProposals.values()].find((item) => item.tenantId === proposal.tenantId && item.idempotencyKey === proposal.idempotencyKey);
    if (existing) return { proposal: clone(existing), created: false };
    this.releaseProposals.set(this.submissionKey(proposal.tenantId, proposal.id), clone(proposal));
    return { proposal: clone(proposal), created: true };
  }

  async getReleaseProposal(context: RequestContext, proposalId: string): Promise<PiReleaseProposal | null> {
    const value = this.releaseProposals.get(this.submissionKey(context.tenantId, proposalId));
    return value && visible(context, value) ? clone(value) : null;
  }

  async listReleaseProposals(context: RequestContext): Promise<PiReleaseProposal[]> {
    return [...this.releaseProposals.values()].filter((item) => visible(context, item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async updateReleaseProposal(context: RequestContext, proposalId: string, expectedVersion: number, patch: { status: PiProposalStatus; updatedAt: string }): Promise<PiReleaseProposal | null> {
    const key = this.submissionKey(context.tenantId, proposalId);
    const current = this.releaseProposals.get(key);
    if (!current || !visible(context, current)) return null;
    const updated = { ...updateVersion(current, expectedVersion), ...patch };
    this.releaseProposals.set(key, updated);
    return clone(updated);
  }

  async findOutboxByIdempotency(context: RequestContext, idempotencyKey: string): Promise<PiDeliveryOutbox | null> {
    const value = [...this.outbox.values()].find((item) => item.tenantId === context.tenantId && item.idempotencyKey === idempotencyKey && visible(context, item));
    return value ? clone(value) : null;
  }

  async createOutbox(outbox: PiDeliveryOutbox): Promise<{ outbox: PiDeliveryOutbox; created: boolean }> {
    const existing = [...this.outbox.values()].find((item) => item.tenantId === outbox.tenantId && item.idempotencyKey === outbox.idempotencyKey);
    if (existing) return { outbox: clone(existing), created: false };
    this.outbox.set(this.submissionKey(outbox.tenantId, outbox.id), clone(outbox));
    return { outbox: clone(outbox), created: true };
  }

  async getOutbox(context: RequestContext, outboxId: string): Promise<PiDeliveryOutbox | null> {
    const value = this.outbox.get(this.submissionKey(context.tenantId, outboxId));
    return value && visible(context, value) ? clone(value) : null;
  }

  async listOutbox(context: RequestContext): Promise<PiDeliveryOutbox[]> {
    return [...this.outbox.values()].filter((item) => visible(context, item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async activateOutbox(context: RequestContext, outboxId: string, expectedVersion: number, updatedAt: string): Promise<PiDeliveryOutbox | null> {
    const key = this.submissionKey(context.tenantId, outboxId);
    const current = this.outbox.get(key);
    if (!current || !visible(context, current) || current.status !== "awaiting_approval") return null;
    const updated: PiDeliveryOutbox = { ...updateVersion(current, expectedVersion), status: "queued", updatedAt };
    this.outbox.set(key, updated);
    return clone(updated);
  }

  async claimOutbox(context: RequestContext, outboxId: string, expectedVersion: number, now: string, leaseOwner: string, leaseToken: string, leaseMs: number): Promise<PiDeliveryOutbox | null> {
    const key = this.submissionKey(context.tenantId, outboxId);
    const current = this.outbox.get(key);
    if (!current || !visible(context, current)) return null;
    if (!["queued", "awaiting_approval"].includes(current.status)) return null;
    const updated: PiDeliveryOutbox = { ...updateVersion(current, expectedVersion), status: "leased", attempts: current.attempts + 1, leaseOwner, leaseToken, leaseExpiresAt: new Date(new Date(now).getTime() + leaseMs).toISOString(), updatedAt: now };
    this.outbox.set(key, updated);
    return clone(updated);
  }

  async reclaimExpiredOutbox(context: RequestContext, outboxId: string, expectedVersion: number, now: string, leaseOwner: string, leaseToken: string, leaseMs: number): Promise<PiDeliveryOutbox | null> {
    const key = this.submissionKey(context.tenantId, outboxId);
    const current = this.outbox.get(key);
    if (!current || !visible(context, current) || current.status !== "leased" || !current.leaseExpiresAt || new Date(current.leaseExpiresAt) > new Date(now)) return null;
    const updated: PiDeliveryOutbox = { ...updateVersion(current, expectedVersion), status: "leased", attempts: current.attempts + 1, leaseOwner, leaseToken, leaseExpiresAt: new Date(new Date(now).getTime() + leaseMs).toISOString(), updatedAt: now };
    this.outbox.set(key, updated);
    return clone(updated);
  }

  async completeOutbox(context: RequestContext, outboxId: string, expectedVersion: number, input: { leaseToken: string; status: PiDeliveryOutboxStatus; resultDigest: string; externalId?: string; externalUrl?: string; lastErrorCode?: string; updatedAt: string }): Promise<PiDeliveryOutbox | null> {
    const key = this.submissionKey(context.tenantId, outboxId);
    const current = this.outbox.get(key);
    if (!current || !visible(context, current)) return null;
    if (current.status !== "leased" || current.leaseToken !== input.leaseToken || !current.leaseExpiresAt || new Date(current.leaseExpiresAt) <= new Date(input.updatedAt)) return null;
    const updated: PiDeliveryOutbox = { ...updateVersion(current, expectedVersion), status: input.status, resultDigest: input.resultDigest, ...(input.externalId ? { externalId: input.externalId } : {}), ...(input.externalUrl ? { externalUrl: input.externalUrl } : {}), ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {}), leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: input.updatedAt };
    this.outbox.set(key, updated);
    return clone(updated);
  }

  async appendEvent(event: PiDeliveryEvent): Promise<void> { this.events.push(clone(event)); }

  async listEvents(context: RequestContext, limit = 200): Promise<PiDeliveryEvent[]> {
    return this.events.filter((item) => item.tenantId === context.tenantId && (context.channel === "system" || item.actorId === context.actorId || context.permissions.includes("pi:change:admin"))).slice(-Math.min(Math.max(limit, 1), 500)).map(clone);
  }
}

export class FailClosedPiPullRequestGateway implements PiPullRequestGateway {
  async createPullRequest(): Promise<never> { throw new Error("PI_CHANGE_PULL_REQUEST_GATEWAY_UNAVAILABLE"); }
  async refreshMergeability(): Promise<never> { throw new Error("PI_CHANGE_PULL_REQUEST_GATEWAY_UNAVAILABLE"); }
}

export class FailClosedPiChangeReleaseGateway implements PiChangeReleaseGateway {
  async proposeMerge(): Promise<never> { throw new Error("PI_CHANGE_RELEASE_GATEWAY_UNAVAILABLE"); }
  async proposeRelease(): Promise<never> { throw new Error("PI_CHANGE_RELEASE_GATEWAY_UNAVAILABLE"); }
}

export class FailClosedPiChangeApprovalGateway implements PiChangeApprovalGateway {
  async createProposal(): Promise<never> { throw new Error("PI_APPROVAL_RUNTIME_NOT_READY"); }
  async resumeToolCall(): Promise<never> { throw new Error("PI_APPROVAL_RUNTIME_NOT_READY"); }
}
