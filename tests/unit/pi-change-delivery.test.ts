// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiApprovalExecutionPermit } from "@/src/modules/pi-agent/domain/approval-contracts";
import type { PiChangeApprovalGateway, PiChangeDeliveryEvidenceReader, PiChangeReleaseGateway, PiExternalActionResult, PiPullRequestGateway } from "@/src/modules/pi-agent/domain/change-delivery-contracts";
import { PiChangeDeliveryService } from "@/src/modules/pi-agent/application/change-delivery-service";
import { PiChangeDeliveryOutboxWorker } from "@/src/modules/pi-agent/application/change-delivery-worker";
import { InMemoryPiChangeDeliveryStore } from "@/src/modules/pi-agent/infrastructure/change-delivery-store";
import type { PiWorkspaceArtifact, PiWorkspaceDiff, PiWorkspaceRecord } from "@/src/modules/pi-agent/domain/workspace-contracts";

const TENANT = "81000000-0000-4000-8000-000000000001";
const ACTOR = "81000000-0000-4000-8000-000000000002";
const OTHER_ACTOR = "81000000-0000-4000-8000-000000000003";
const SESSION = "81000000-0000-4000-8000-000000000101";
const RUN = "81000000-0000-4000-8000-000000000102";
const WORKSPACE = "81000000-0000-4000-8000-000000000103";
const REPOSITORY = "81000000-0000-4000-8000-000000000104";
const CHECKPOINT = "81000000-0000-4000-8000-000000000105";
const TEST_ARTIFACT = "81000000-0000-4000-8000-000000000106";
const SCAN_ARTIFACT = "81000000-0000-4000-8000-000000000107";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const DIFF = "c".repeat(64);
const EVIDENCE = "d".repeat(64);

function context(actorId = ACTOR, channel: RequestContext["channel"] = "web"): RequestContext {
  return { tenantId: TENANT, actorId, sessionId: "81000000-0000-4000-8000-000000000199", channel, traceId: `change-${actorId}-${channel}`, roles: [], permissions: ["pi:change:read", "pi:change:submit", "pi:change:merge", "pi:change:release", "pi:change:admin"], dataScopes: [{ type: "tenant" }] };
}

function workspace(): PiWorkspaceRecord {
  return { id: WORKSPACE, tenantId: TENANT, actorId: ACTOR, sessionId: SESSION, runId: RUN, workspaceId: "project-a", repositoryId: REPOSITORY, provider: "forgejo", repositoryRef: "team/project-a", baseRef: "main", baseCommitSha: BASE, ephemeralBranch: `pi/${SESSION}/${RUN}`, status: "destroyed", providerWorkspaceRef: "workspace://forgejo/team/project-a", headCommitSha: HEAD, workspaceDigest: EVIDENCE, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:10:00.000Z", destroyedAt: "2026-08-20T00:11:00.000Z" };
}

function repository() {
  return { id: REPOSITORY, tenantId: TENANT, workspaceId: "project-a", provider: "forgejo" as const, repositoryRef: "team/project-a", defaultBranch: "main", credentialRef: `secret://tenants/${TENANT}/forgejo/project-a`, status: "active" as const, createdAt: "2026-08-20T00:00:00.000Z" };
}

function artifact(id: string, type: PiWorkspaceArtifact["type"]): PiWorkspaceArtifact {
  return { id, tenantId: TENANT, actorId: ACTOR, sessionId: SESSION, runId: RUN, workspaceId: WORKSPACE, type, fileName: `${type}.json`, mediaType: "application/json", storageRef: `artifact://${id}`, objectVersion: "v1", contentDigest: EVIDENCE, sizeBytes: 12, classification: "internal", version: 1, status: "active", createdAt: "2026-08-20T00:05:00.000Z", updatedAt: "2026-08-20T00:05:00.000Z" };
}

class Evidence implements PiChangeDeliveryEvidenceReader {
  readonly record = workspace();
  async getRepository(): Promise<ReturnType<typeof repository>> { return structuredClone(repository()); }
  async getWorkspace(): Promise<PiWorkspaceRecord> { return structuredClone(this.record); }
  async deliveryDiff(): Promise<PiWorkspaceDiff> { return { baseCommitSha: BASE, headCommitSha: HEAD, diff: "diff --git a/app.ts b/app.ts", diffDigest: DIFF, truncated: false }; }
  async checkpoints(): Promise<Array<{ id: string; sessionId: string; diffDigest: string; gitCommitSha?: string }>> { return [{ id: CHECKPOINT, sessionId: SESSION, diffDigest: DIFF, gitCommitSha: HEAD }]; }
  async listArtifacts(): Promise<PiWorkspaceArtifact[]> { return [artifact(TEST_ARTIFACT, "test_report"), artifact(SCAN_ARTIFACT, "scan_report")]; }
}

class ApprovalGateway implements PiChangeApprovalGateway {
  private readonly permits = new Map<string, PiApprovalExecutionPermit>();
  private sequence = 0;
  pending = false;

  async createProposal(context: RequestContext, input: Parameters<PiChangeApprovalGateway["createProposal"]>[1]): Promise<{ approval: { id: string; proposalHash: string } }> {
    const id = `81000000-0000-4000-8000-${String(300 + this.sequence).padStart(12, "0")}`;
    this.sequence += 1;
    const proposalHash = `${String(this.sequence).repeat(64).slice(0, 64)}`;
    this.permits.set(id, { approvalId: id, tenantId: context.tenantId, requestedBy: context.actorId, sessionId: input.sessionId, runId: input.runId, toolName: input.toolName, toolVersion: input.toolVersion, profile: input.profile, riskLevel: input.riskLevel, proposalHash, expectedObjectVersions: input.expectedObjectVersions, policyVersion: 1, issuedAt: "2026-08-20T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
    return { approval: { id, proposalHash } };
  }

  async resumeToolCall(_context: RequestContext, approvalId: string): Promise<PiApprovalExecutionPermit> {
    if (this.pending) throw new Error("PI_APPROVAL_NOT_APPROVED:pending");
    const permit = this.permits.get(approvalId);
    if (!permit) throw new Error("PI_APPROVAL_NOT_FOUND");
    return structuredClone(permit);
  }
}

class DeliveryGateway implements PiPullRequestGateway, PiChangeReleaseGateway {
  calls: string[] = [];
  failNext = false;
  async result(action: string, mergeability?: PiExternalActionResult["mergeability"]): Promise<PiExternalActionResult> {
    this.calls.push(action);
    if (this.failNext) { this.failNext = false; throw new Error("PI_EXTERNAL_TIMEOUT"); }
    return { status: "succeeded", resultDigest: EVIDENCE, externalId: action === "create_pull_request" ? "PR-7" : undefined, externalUrl: action === "create_pull_request" ? "https://forgejo.example/team/project-a/pulls/7" : undefined, mergeability };
  }
  async createPullRequest(): Promise<PiExternalActionResult> { return this.result("create_pull_request"); }
  async refreshMergeability(): Promise<PiExternalActionResult> { return this.result("refresh_mergeability", "mergeable"); }
  async proposeMerge(): Promise<PiExternalActionResult> { return this.result("propose_merge"); }
  async proposeRelease(): Promise<PiExternalActionResult> { return this.result("propose_release"); }
}

describe("Pi change delivery control plane", () => {
  function createRuntime() {
    const gateway = new DeliveryGateway();
    const approval = new ApprovalGateway();
    const store = new InMemoryPiChangeDeliveryStore();
    const service = new PiChangeDeliveryService(store, new Evidence(), approval, gateway, gateway);
    return { service, gateway, approval, store };
  }

  it("validates a destroyed workspace from checkpoint evidence and queues protected PR work without external side effects", async () => {
    const { service, gateway } = createRuntime();
    const submitted = await service.submitChange(context(), { sessionId: SESSION, runId: RUN, workspaceRecordId: WORKSPACE, repositoryId: REPOSITORY, baseCommitSha: BASE, targetBranch: "main", checkpointIds: [CHECKPOINT], artifactIds: [TEST_ARTIFACT, SCAN_ARTIFACT], idempotencyKey: "change-1" });
    expect(submitted.submission.status).toBe("awaiting_approval");
    const queued = await service.createPullRequest(context(), submitted.submission.id);
    expect(queued.outbox.status).toBe("queued");
    expect(gateway.calls).toEqual([]);
    const system = context(ACTOR, "system");
    const result = await service.dispatchOutbox(system, queued.outbox.id);
    expect(result.status).toBe("succeeded");
    expect((await service.getPullRequest(context(), queued.pullRequest.id)).status).toBe("open");
    expect(gateway.calls).toEqual(["create_pull_request"]);
  });

  it("keeps the merge/release chain approval-bound and records no raw external payload", async () => {
    const { service, gateway } = createRuntime();
    const submitted = await service.submitChange(context(), { sessionId: SESSION, runId: RUN, workspaceRecordId: WORKSPACE, repositoryId: REPOSITORY, baseCommitSha: BASE, targetBranch: "main", checkpointIds: [CHECKPOINT], artifactIds: [TEST_ARTIFACT, SCAN_ARTIFACT], idempotencyKey: "change-2" });
    const pullRequest = await service.createPullRequest(context(), submitted.submission.id);
    await service.dispatchOutbox(context(ACTOR, "system"), pullRequest.outbox.id);
    const mergeability = await service.refreshMergeability(context(), pullRequest.pullRequest.id);
    await service.dispatchOutbox(context(ACTOR, "system"), mergeability.id);
    const merge = await service.proposeMerge(context(), pullRequest.pullRequest.id, { idempotencyKey: "merge-2" });
    expect(merge.proposal.status).toBe("awaiting_approval");
    await service.dispatchOutbox(context(ACTOR, "system"), merge.outbox.id);
    expect((await service.getPullRequest(context(), pullRequest.pullRequest.id)).status).toBe("merged");
    const release = await service.proposeRelease(context(), submitted.submission.id, { idempotencyKey: "release-2", environment: "staging", artifactDigest: EVIDENCE });
    await service.dispatchOutbox(context(ACTOR, "system"), release.outbox.id);
    expect((await service.getOutbox(context(), release.outbox.id)).status).toBe("succeeded");
    expect(gateway.calls).toEqual(["create_pull_request", "refresh_mergeability", "propose_merge", "propose_release"]);
    expect(JSON.stringify(await service.snapshot(context()))).not.toContain("secret://");
  });

  it("turns a gateway exception into terminal unknown and never automatically replays it", async () => {
    const { service, gateway } = createRuntime();
    const submitted = await service.submitChange(context(), { sessionId: SESSION, runId: RUN, workspaceRecordId: WORKSPACE, repositoryId: REPOSITORY, baseCommitSha: BASE, targetBranch: "main", checkpointIds: [CHECKPOINT], artifactIds: [TEST_ARTIFACT], idempotencyKey: "change-3" });
    const pullRequest = await service.createPullRequest(context(), submitted.submission.id);
    gateway.failNext = true;
    const unknown = await service.dispatchOutbox(context(ACTOR, "system"), pullRequest.outbox.id);
    expect(unknown.status).toBe("unknown");
    expect((await service.getPullRequest(context(), pullRequest.pullRequest.id)).status).toBe("unknown");
    expect((await service.dispatchOutbox(context(ACTOR, "system"), pullRequest.outbox.id)).status).toBe("unknown");
    expect(gateway.calls).toEqual(["create_pull_request"]);
  });

  it("does not turn an unapproved protected outbox into an external unknown result", async () => {
    const { service, gateway, approval } = createRuntime();
    const submitted = await service.submitChange(context(), { sessionId: SESSION, runId: RUN, workspaceRecordId: WORKSPACE, repositoryId: REPOSITORY, baseCommitSha: BASE, targetBranch: "main", checkpointIds: [CHECKPOINT], artifactIds: [TEST_ARTIFACT, SCAN_ARTIFACT], idempotencyKey: "change-pending" });
    const pullRequest = await service.createPullRequest(context(), submitted.submission.id);
    await service.dispatchOutbox(context(ACTOR, "system"), pullRequest.outbox.id);
    const mergeability = await service.refreshMergeability(context(), pullRequest.pullRequest.id);
    await service.dispatchOutbox(context(ACTOR, "system"), mergeability.id);
    approval.pending = true;
    const merge = await service.proposeMerge(context(), pullRequest.pullRequest.id, { idempotencyKey: "merge-pending" });
    const waiting = await service.dispatchOutbox(context(ACTOR, "system"), merge.outbox.id);
    expect(waiting.status).toBe("awaiting_approval");
    expect((await service.getPullRequest(context(), pullRequest.pullRequest.id)).status).toBe("mergeable");
    expect(gateway.calls).toEqual(["create_pull_request", "refresh_mergeability"]);
  });

  it("keeps the durable worker idle until approval is visible, then dispatches exactly once", async () => {
    const { service, gateway, approval } = createRuntime();
    const submitted = await service.submitChange(context(), { sessionId: SESSION, runId: RUN, workspaceRecordId: WORKSPACE, repositoryId: REPOSITORY, baseCommitSha: BASE, targetBranch: "main", checkpointIds: [CHECKPOINT], artifactIds: [TEST_ARTIFACT, SCAN_ARTIFACT], idempotencyKey: "change-worker" });
    const pullRequest = await service.createPullRequest(context(), submitted.submission.id);
    await service.dispatchOutbox(context(ACTOR, "system"), pullRequest.outbox.id);
    const mergeability = await service.refreshMergeability(context(), pullRequest.pullRequest.id);
    await service.dispatchOutbox(context(ACTOR, "system"), mergeability.id);
    approval.pending = true;
    const merge = await service.proposeMerge(context(), pullRequest.pullRequest.id, { idempotencyKey: "merge-worker" });
    const worker = new PiChangeDeliveryOutboxWorker(service);

    expect(await worker.processTenant(TENANT, "worker-1")).toMatchObject({ role: "pi-change-delivery", status: "idle", workId: merge.outbox.id });
    expect((await service.getOutbox(context(), merge.outbox.id)).status).toBe("awaiting_approval");
    expect(gateway.calls).toEqual(["create_pull_request", "refresh_mergeability"]);

    approval.pending = false;
    expect(await worker.processTenant(TENANT, "worker-1")).toMatchObject({ role: "pi-change-delivery", status: "succeeded", workId: merge.outbox.id });
    expect((await service.getOutbox(context(), merge.outbox.id)).status).toBe("succeeded");
    expect(gateway.calls).toEqual(["create_pull_request", "refresh_mergeability", "propose_merge"]);
  });

  it("fences a crashed lease and records unknown without replaying the external action", async () => {
    const { service, gateway, store } = createRuntime();
    const submitted = await service.submitChange(context(), { sessionId: SESSION, runId: RUN, workspaceRecordId: WORKSPACE, repositoryId: REPOSITORY, baseCommitSha: BASE, targetBranch: "main", checkpointIds: [CHECKPOINT], artifactIds: [TEST_ARTIFACT], idempotencyKey: "change-lease-expired" });
    const pullRequest = await service.createPullRequest(context(), submitted.submission.id);
    const beforeLease = await store.getOutbox(context(), pullRequest.outbox.id);
    expect(beforeLease).not.toBeNull();
    const oldLease = await store.claimOutbox(context(ACTOR, "system"), pullRequest.outbox.id, beforeLease!.version, "2020-01-01T00:00:00.000Z", "old-worker", "81000000-0000-4000-8000-000000000301", 5_000);
    expect(oldLease?.status).toBe("leased");

    const recovered = await service.dispatchOutbox(context(ACTOR, "system"), pullRequest.outbox.id);
    expect(recovered.status).toBe("unknown");
    expect(recovered.lastErrorCode).toBe("PI_CHANGE_LEASE_EXPIRED");
    expect((await service.getPullRequest(context(), pullRequest.pullRequest.id)).status).toBe("unknown");
    expect(gateway.calls).toEqual([]);
    expect(await store.completeOutbox(context(ACTOR, "system"), pullRequest.outbox.id, oldLease!.version, { leaseToken: oldLease!.leaseToken!, status: "succeeded", resultDigest: EVIDENCE, updatedAt: new Date().toISOString() })).toBeNull();
  });

  it("rejects browser dispatch, protected target drift, and cross-actor reads", async () => {
    const { service } = createRuntime();
    const submitted = await service.submitChange(context(), { sessionId: SESSION, runId: RUN, workspaceRecordId: WORKSPACE, repositoryId: REPOSITORY, baseCommitSha: BASE, targetBranch: "main", checkpointIds: [CHECKPOINT], artifactIds: [TEST_ARTIFACT], idempotencyKey: "change-4" });
    const pullRequest = await service.createPullRequest(context(), submitted.submission.id);
    await expect(service.dispatchOutbox(context(), pullRequest.outbox.id)).rejects.toThrow("PI_CHANGE_DISPATCH_SYSTEM_ONLY");
    await expect(service.proposeMerge(context(), pullRequest.pullRequest.id, { idempotencyKey: "merge-4", targetBranch: "feature/not-protected" })).rejects.toThrow("PI_CHANGE_PULL_REQUEST_NOT_MERGEABLE");
    const other = context(OTHER_ACTOR);
    other.permissions = other.permissions.filter((permission) => permission !== "pi:change:admin");
    await expect(service.getSubmission(other, submitted.submission.id)).rejects.toThrow("PI_CHANGE_SUBMISSION_NOT_FOUND");
  });
});
