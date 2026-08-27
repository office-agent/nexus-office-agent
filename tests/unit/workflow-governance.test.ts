// Requirements: PR-005, PR-008, MR-016, MR-017, MR-018, MR-019, MR-020, AR-003, AC-004
import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { WorkflowService } from "@/src/modules/workflow/application/service";
import { InMemoryWorkflowRepository, DEMO_APPROVAL_ID, DEMO_PROCESS_INSTANCE_ID, DEMO_REQUESTER_ID } from "@/src/modules/workflow/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";
import type { RequestContext } from "@/src/platform/context/request-context";

function context(actorId: string, permissions: string[]): RequestContext {
  return { ...createDevelopmentRequestContext(), actorId, permissions, dataScopes: [{ type: "tenant" }] };
}

describe("workflow governance", () => {
  it("pins a running instance to the published definition version", async () => {
    const repository = new InMemoryWorkflowRepository(false);
    const service = new WorkflowService(repository, new InMemoryEventStore());
    const admin = context(DEMO_MANAGER_ID, ["process_definition:admin","approval:approve","process_instance:read"]);
    const requester = context(DEMO_REQUESTER_ID, ["process_instance:create","process_instance:read"]);
    const v1 = await service.publishDefinition(admin, {
      code: "CHANGE", name: "变更审批", startNodeKey: "review",
      nodes: [
        { key: "review", type: "approval", name: "审批", approverIds: [DEMO_MANAGER_ID], mode: "all", next: "done", slaHours: 12 },
        { key: "done", type: "end", name: "完成", outcome: "approved" },
      ],
    });
    const started = await service.startProcess(requester, { definitionId: v1.definition.id, title: "上线变更", form: { scope: "east" }, riskLevel: 3 });
    const v2 = await service.publishDefinition(admin, {
      definitionId: v1.definition.id, code: "CHANGE", name: "变更审批", startNodeKey: "security",
      nodes: [
        { key: "security", type: "approval", name: "安全审批", approverIds: [DEMO_MANAGER_ID], mode: "all", next: "done", slaHours: 8 },
        { key: "done", type: "end", name: "完成", outcome: "approved" },
      ],
    });
    const nextStarted = await service.startProcess(requester, { definitionId: v1.definition.id, title: "新版本变更", form: {}, riskLevel: 1 });
    const result = await service.decide(admin, started.approvals[0].id, { decision: "approve", comment: "同意", version: 1 });
    expect(started.instance.definitionVersion).toBe(1);
    expect(v2.version.version).toBe(2);
    expect(nextStarted.instance).toMatchObject({ definitionVersion: 2, currentNodeKey: "security" });
    expect(result.instance.status).toBe("approved");
    expect(result.instance.currentNodeKey).toBe("done");
  });

  it("rejects unreachable nodes in a published process definition", async () => {
    const service = new WorkflowService(new InMemoryWorkflowRepository(false), new InMemoryEventStore());
    const admin = context(DEMO_MANAGER_ID, ["process_definition:admin"]);
    await expect(service.publishDefinition(admin, {
      code: "BROKEN", name: "不完整流程", startNodeKey: "review",
      nodes: [
        { key: "review", type: "approval", name: "审批", approverIds: [DEMO_MANAGER_ID], mode: "all", next: "done", slaHours: 4 },
        { key: "done", type: "end", name: "完成", outcome: "approved" },
        { key: "orphan", type: "end", name: "不可达结束", outcome: "rejected" },
      ],
    })).rejects.toThrow("PROCESS_NODE_UNREACHABLE");
  });

  it("enforces separation of duties for high-risk requests", async () => {
    const repository = new InMemoryWorkflowRepository(false);
    const service = new WorkflowService(repository, new InMemoryEventStore());
    const self = context(DEMO_MANAGER_ID, ["process_definition:admin","process_instance:create"]);
    const published = await service.publishDefinition(self, {
      code: "SELF", name: "自批流程", startNodeKey: "review",
      nodes: [
        { key: "review", type: "approval", name: "自批", approverIds: [DEMO_MANAGER_ID], mode: "all", next: "done", slaHours: 4 },
        { key: "done", type: "end", name: "完成", outcome: "approved" },
      ],
    });
    await expect(service.startProcess(self, { definitionId: published.definition.id, title: "高风险申请", form: {}, riskLevel: 4 }))
      .rejects.toThrow("SEPARATION_OF_DUTIES_REQUIRED");
  });

  it("allows only one concurrent decision for the same approval version", async () => {
    const service = new WorkflowService(new InMemoryWorkflowRepository(), new InMemoryEventStore());
    const manager = createDevelopmentRequestContext();
    const outcomes = await Promise.allSettled([
      service.decide(manager, DEMO_APPROVAL_ID, { decision: "approve", comment: "同意", version: 1 }),
      service.decide(manager, DEMO_APPROVAL_ID, { decision: "approve", comment: "重复", version: 1 }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("delegates explicitly and disables re-delegation", async () => {
    const repository = new InMemoryWorkflowRepository();
    const service = new WorkflowService(repository, new InMemoryEventStore());
    const manager = createDevelopmentRequestContext();
    const delegateId = "10000000-0000-4000-8000-000000000005";
    const delegated = await service.delegate(manager, DEMO_APPROVAL_ID, { delegateId, version: 1 });
    expect(delegated.delegated.status).toBe("delegated");
    expect(delegated.replacement.delegatedFromId).toBe(DEMO_APPROVAL_ID);
    const delegateContext = context(delegateId, ["approval:update"]);
    await expect(service.delegate(delegateContext, delegated.replacement.id, { delegateId: DEMO_MANAGER_ID, version: 1 }))
      .rejects.toThrow("APPROVAL_REDELEGATION_DISABLED");
  });

  it("keeps high-risk delegation separated from the requester and requires a running process", async () => {
    const repository = new InMemoryWorkflowRepository();
    const service = new WorkflowService(repository, new InMemoryEventStore());
    const manager = createDevelopmentRequestContext();
    await expect(service.delegate(manager, DEMO_APPROVAL_ID, { delegateId: DEMO_REQUESTER_ID, version: 1 }))
      .rejects.toThrow("SEPARATION_OF_DUTIES_REQUIRED");

    const requester = context(DEMO_REQUESTER_ID, ["process_instance:update"]);
    await service.withdraw(requester, DEMO_PROCESS_INSTANCE_ID, { version: 1, reason: "申请终止" });
    await expect(service.delegate(manager, DEMO_APPROVAL_ID, {
      delegateId: "10000000-0000-4000-8000-000000000005", version: 2,
    })).rejects.toThrow("PROCESS_INSTANCE_INVALID_TRANSITION");
  });

  it("adds an explicit countersigner without duplicating an existing pending approver", async () => {
    const repository = new InMemoryWorkflowRepository();
    const service = new WorkflowService(repository, new InMemoryEventStore());
    const manager = createDevelopmentRequestContext();
    const countersignerId = "10000000-0000-4000-8000-000000000005";
    const added = await service.addApprover(manager, DEMO_PROCESS_INSTANCE_ID, { approverId: countersignerId });
    expect(added).toMatchObject({ instanceId: DEMO_PROCESS_INSTANCE_ID, approverId: countersignerId, status: "pending" });
    await expect(service.addApprover(manager, DEMO_PROCESS_INSTANCE_ID, { approverId: countersignerId })).rejects.toThrow("APPROVER_ALREADY_PENDING");
  });

  it("returns the seeded pending approval only to its assignee", async () => {
    const repository = new InMemoryWorkflowRepository();
    const service = new WorkflowService(repository, new InMemoryEventStore());
    const snapshot = await service.snapshot(createDevelopmentRequestContext());
    expect(snapshot.instances.find(({ id }) => id === DEMO_PROCESS_INSTANCE_ID)?.definitionVersion).toBe(1);
    expect(snapshot.pendingApprovals.map(({ id }) => id)).toContain(DEMO_APPROVAL_ID);
    expect((await repository.getSnapshot(DEMO_TENANT_ID, DEMO_REQUESTER_ID)).pendingApprovals).toHaveLength(0);
  });

  it("cancels the remaining parallel approvals after any approver passes", async () => {
    const repository = new InMemoryWorkflowRepository(false);
    const service = new WorkflowService(repository, new InMemoryEventStore());
    const secondApproverId = "10000000-0000-4000-8000-000000000003";
    const admin = context(DEMO_MANAGER_ID, ["process_definition:admin","approval:approve"]);
    const requester = context(DEMO_REQUESTER_ID, ["process_instance:create"]);
    const published = await service.publishDefinition(admin, {
      code: "ANY", name: "并行或签", startNodeKey: "review",
      nodes: [
        { key: "review", type: "approval", name: "任一通过", approverIds: [DEMO_MANAGER_ID, secondApproverId], mode: "any", next: "done", slaHours: 8 },
        { key: "done", type: "end", name: "完成", outcome: "approved" },
      ],
    });
    const started = await service.startProcess(requester, { definitionId: published.definition.id, title: "并行审批", form: {}, riskLevel: 1 });
    const mine = started.approvals.find(({ approverId }) => approverId === DEMO_MANAGER_ID)!;
    await service.decide(admin, mine.id, { decision: "approve", comment: "同意", version: 1 });
    const approvals = await repository.listApprovals(DEMO_TENANT_ID, started.instance.id);
    expect(approvals.find(({ approverId }) => approverId === secondApproverId)?.status).toBe("cancelled");
  });

  it("lets only the requester withdraw a running process and closes its pending approvals", async () => {
    const repository = new InMemoryWorkflowRepository();
    const service = new WorkflowService(repository, new InMemoryEventStore());
    const requester = context(DEMO_REQUESTER_ID, ["process_instance:update"]);
    const result = await service.withdraw(requester, DEMO_PROCESS_INSTANCE_ID, { version: 1, reason: "业务条件变化" });
    expect(result.instance.status).toBe("withdrawn");
    expect(result.cancelledApprovals).toHaveLength(1);
    expect(result.cancelledApprovals[0].status).toBe("cancelled");
    await expect(service.withdraw(requester, DEMO_PROCESS_INSTANCE_ID, { version: 2, reason: "重复撤回" }))
      .rejects.toThrow("PROCESS_INSTANCE_INVALID_TRANSITION");
    await expect(service.withdraw(createDevelopmentRequestContext(), DEMO_PROCESS_INSTANCE_ID, { version: 2, reason: "越权尝试" }))
      .rejects.toThrow("POLICY_DENIED:REQUESTER_MISMATCH");
  });

  it("escalates overdue approvals to configured owners without weakening separation of duties", async () => {
    const repository = new InMemoryWorkflowRepository(false);
    const events = new InMemoryEventStore();
    const service = new WorkflowService(repository, events);
    const escalationOwnerId = "10000000-0000-4000-8000-000000000004";
    const admin = context(DEMO_MANAGER_ID, ["process_definition:admin"]);
    const requester = context(DEMO_REQUESTER_ID, ["process_instance:create"]);
    const published = await service.publishDefinition(admin, {
      code: "SLA", name: "超时升级", startNodeKey: "review",
      nodes: [
        { key: "review", type: "approval", name: "负责人审批", approverIds: [DEMO_MANAGER_ID], mode: "all", next: "done", slaHours: 4, escalationApproverIds: [escalationOwnerId, DEMO_REQUESTER_ID] },
        { key: "done", type: "end", name: "完成", outcome: "approved" },
      ],
    });
    const started = await service.startProcess(requester, { definitionId: published.definition.id, title: "高风险升级", form: {}, riskLevel: 3 });
    const early = await service.escalateOverdue(admin, { now: "2020-01-01T00:00:00.000Z", limit: 10 });
    expect(early.escalated).toEqual([]);
    const result = await service.escalateOverdue(admin, { now: "2099-01-01T00:00:00.000Z", limit: 10 });
    const entry = result.escalated.find(({ source }) => source.id === started.approvals[0].id)!;
    expect(entry.source.status).toBe("escalated");
    expect(entry.replacements.map(({ approverId }) => approverId)).toEqual([escalationOwnerId]);
    expect(entry.replacements[0]).toMatchObject({ escalatedFromId: started.approvals[0].id, escalationLevel: 1, status: "pending" });
  });
});
