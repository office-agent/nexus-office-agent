// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import { ApprovalPolicyResolver, InMemoryPiApprovalEventSink, PiApprovalService, StaticPiApprovalApproverDirectory, StaticPiApprovalObjectVersionReader } from "@/src/modules/pi-agent/application/approval-service";
import { InMemoryPiApprovalStore } from "@/src/modules/pi-agent/infrastructure/approval-store";

const TENANT_A = "71000000-0000-4000-8000-000000000001";
const REQUESTER = "71000000-0000-4000-8000-000000000002";
const APPROVER_1 = "71000000-0000-4000-8000-000000000003";
const APPROVER_2 = "71000000-0000-4000-8000-000000000004";

function context(actorId = REQUESTER, tenantId = TENANT_A, permissions = ["pi:approval:create", "pi:approval:read", "pi:approval:decide:r2", "pi:approval:decide:r3", "pi:approval:resume", "pi:approval:cancel"]): RequestContext {
  return { tenantId, actorId, sessionId: "71000000-0000-4000-8000-000000000099", channel: "web", traceId: `approval-${actorId}`, roles: [], permissions, dataScopes: [{ type: "tenant" }] };
}

function service(reader = new StaticPiApprovalObjectVersionReader({ project: "v3" })) {
  const events = new InMemoryPiApprovalEventSink();
  const store = new InMemoryPiApprovalStore();
  const policy = new ApprovalPolicyResolver(new StaticPiApprovalApproverDirectory([APPROVER_2, APPROVER_1]), { policyVersion: 7 });
  return { service: new PiApprovalService(store, policy, events, reader), store, events };
}

async function createR3(input?: Partial<Parameters<PiApprovalService["createProposal"]>[1]>) {
  const runtime = service();
  const result = await runtime.service.createProposal(context(), {
    sessionId: "71000000-0000-4000-8000-000000000101",
    toolName: "mcp.release.propose",
    toolVersion: 2,
    profile: "release",
    riskLevel: "R3",
    preview: "为变更集创建发布提案",
    inputDigest: "a".repeat(64),
    expectedObjectVersions: { project: "v3" },
    idempotencyKey: "approval-create-r3",
    ...input,
  });
  return { ...runtime, approval: result.approval };
}

describe("Pi approval gateway", () => {
  it("binds proposal hash to actor, tool, policy, TTL and object versions, and disables R4", async () => {
    const { service: approval } = service();
    const created = await approval.createProposal(context(), {
      sessionId: "71000000-0000-4000-8000-000000000102", toolName: "change.submit", toolVersion: 1, profile: "coding", riskLevel: "R2",
      preview: "提交变更集", inputDigest: "b".repeat(64), expectedObjectVersions: { branch: 8 }, idempotencyKey: "approval-hash-r2", now: new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(created.approval.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.approval.requiredApproverIds).toEqual([APPROVER_1]);
    expect(created.approval.expiresAt).toBe("2026-08-20T00:10:00.000Z");
    expect(approval.computeProposalHash({
      tenantId: TENANT_A, actorId: REQUESTER, sessionId: created.approval.sessionId, toolName: created.approval.toolName, toolVersion: created.approval.toolVersion,
      profile: created.approval.profile, riskLevel: created.approval.riskLevel, inputDigest: created.approval.inputDigest, expectedObjectVersions: { branch: 9 },
      requiredApproverIds: created.approval.requiredApproverIds, policySnapshot: created.approval.policySnapshot, expiresAt: created.approval.expiresAt,
    })).not.toBe(created.approval.proposalHash);
    await expect(approval.createProposal(context(), {
      sessionId: "71000000-0000-4000-8000-000000000103", toolName: "release.deploy", toolVersion: 1, profile: "release", riskLevel: "R4",
      preview: "部署", inputDigest: "c".repeat(64), expectedObjectVersions: {}, idempotencyKey: "approval-r4",
    })).rejects.toThrow("PI_R4_DISABLED");
  });

  it("keeps R3 approval pending after one decision, then issues a revalidated execution permit", async () => {
    const runtime = await createR3();
    const { approval } = runtime;
    await expect(runtime.service.recordDecision(context(), approval.id, { proposalHash: approval.proposalHash, idempotencyKey: "decision-self" })).rejects.toThrow("PI_APPROVER_FORBIDDEN");
    const first = await runtime.service.recordDecision(context(APPROVER_1), approval.id, { proposalHash: approval.proposalHash, idempotencyKey: "decision-one" });
    expect(first.approval.status).toBe("pending");
    const second = await runtime.service.recordDecision(context(APPROVER_2), approval.id, { proposalHash: approval.proposalHash, idempotencyKey: "decision-two" });
    expect(second.approval.status).toBe("approved");
    expect((await runtime.service.decisions(context(), approval.id)).map((item) => item.actorId)).toEqual([APPROVER_1, APPROVER_2]);
    const permit = await runtime.service.resumeToolCall(context(), approval.id);
    expect(permit).toMatchObject({ approvalId: approval.id, toolName: "mcp.release.propose", proposalHash: approval.proposalHash, policyVersion: 7 });
    expect(runtime.events.events.map((event) => event.eventType)).toContain("pi.tool.started");
  });

  it("supersedes an approved proposal when object versions drift and fails closed", async () => {
    const runtime = await createR3();
    const { approval } = runtime;
    await runtime.service.recordDecision(context(APPROVER_1), approval.id, { proposalHash: approval.proposalHash, idempotencyKey: "decision-drift-one" });
    await runtime.service.recordDecision(context(APPROVER_2), approval.id, { proposalHash: approval.proposalHash, idempotencyKey: "decision-drift-two" });
    const drifted = new PiApprovalService(runtime.store, new ApprovalPolicyResolver(new StaticPiApprovalApproverDirectory([APPROVER_1, APPROVER_2]), { policyVersion: 7 }), runtime.events, new StaticPiApprovalObjectVersionReader({ project: "v4" }));
    const result = await drifted.revalidate(context(), approval.id);
    expect(result).toMatchObject({ valid: false, reason: "PI_APPROVAL_OBJECT_VERSION_CHANGED", approval: { status: "superseded", revalidationStatus: "failed" } });
    await expect(drifted.resumeToolCall(context(), approval.id)).rejects.toThrow("PI_APPROVAL_NOT_APPROVED:superseded");
  });

  it("expires, cancels and rejects pending proposals without changing immutable decision facts", async () => {
    const runtime = service();
    const expired = await runtime.service.createProposal(context(), {
      sessionId: "71000000-0000-4000-8000-000000000104", toolName: "change.submit", toolVersion: 1, profile: "coding", riskLevel: "R2", preview: "提交", inputDigest: "d".repeat(64), expectedObjectVersions: {}, idempotencyKey: "approval-expire", now: new Date("2026-08-20T00:00:00.000Z"),
    });
    await expect(runtime.service.recordDecision(context(APPROVER_1), expired.approval.id, { proposalHash: expired.approval.proposalHash, idempotencyKey: "decision-expired", now: new Date("2026-08-20T00:11:00.000Z") })).rejects.toThrow("PI_APPROVAL_EXPIRED");
    expect((await runtime.service.get(context(), expired.approval.id)).status).toBe("expired");

    const cancelled = await runtime.service.createProposal(context(), {
      sessionId: "71000000-0000-4000-8000-000000000105", toolName: "change.submit", toolVersion: 1, profile: "coding", riskLevel: "R2", preview: "提交", inputDigest: "e".repeat(64), expectedObjectVersions: {}, idempotencyKey: "approval-cancel",
    });
    expect((await runtime.service.cancel(context(), cancelled.approval.id)).status).toBe("cancelled");

    const rejected = await runtime.service.createProposal(context(), {
      sessionId: "71000000-0000-4000-8000-000000000106", toolName: "change.submit", toolVersion: 1, profile: "coding", riskLevel: "R2", preview: "提交", inputDigest: "f".repeat(64), expectedObjectVersions: {}, idempotencyKey: "approval-reject",
    });
    const decision = await runtime.service.reject(context(APPROVER_1), rejected.approval.id, { proposalHash: rejected.approval.proposalHash, idempotencyKey: "decision-reject", comment: "检查未通过" });
    expect(decision.approval.status).toBe("rejected");
    expect(decision.decision.commentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.decision.decisionDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
