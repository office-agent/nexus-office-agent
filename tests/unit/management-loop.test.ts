// Requirements: PR-001, PR-003, MR-005, MR-006, MR-012, MR-022, MR-023, MR-024, AR-003, AR-007, AC-002
import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { InMemoryManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { completeActionItem } from "@/src/modules/collaboration/domain/action-item";
import { decide, submitDecision } from "@/src/modules/governance/domain/decision";
import { riskExposure } from "@/src/modules/governance/domain/risk";
import { transitionMilestone } from "@/src/modules/delivery/domain/milestone";
import { transitionTask } from "@/src/modules/delivery/domain/task";
import { transitionIssue } from "@/src/modules/governance/domain/issue";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_PROJECT_ID } from "@/src/platform/context/development-context";

describe("management loop domain", () => {
  it("enforces decision review before deciding", () => {
    const draft = {
      id: crypto.randomUUID(),
      tenantId: "tenant",
      title: "灰度范围决策",
      context: "交付窗口缩短",
      options: ["30% 灰度", "延期上线"],
      ownerId: "owner",
      status: "draft" as const,
      version: 1,
    };
    expect(() => decide(draft, { selectedOption: "30% 灰度", rationale: "控制风险", decidedBy: "owner" })).toThrow(
      "DECISION_CANNOT_DECIDE:draft",
    );
    const decided = decide(submitDecision(draft), {
      selectedOption: "30% 灰度",
      rationale: "控制风险",
      decidedBy: "owner",
    });
    expect(decided.status).toBe("decided");
    expect(decided.version).toBe(3);
  });

  it("requires evidence and calculates risk exposure", () => {
    expect(riskExposure({ probability: 4, impact: 5 } as Parameters<typeof riskExposure>[0])).toBe(20);
    expect(() =>
      completeActionItem(
        {
          id: "action",
          tenantId: "tenant",
          title: "确认人力",
          description: "",
          ownerId: "owner",
          dueAt: new Date().toISOString(),
          acceptanceCriteria: "名单确认",
          status: "open",
          version: 1,
        },
        " ",
      ),
    ).toThrow("ACTION_ITEM_EVIDENCE_REQUIRED");
  });

  it("enforces milestone, task and issue lifecycles", () => {
    const milestone = {
      id: "milestone", tenantId: "tenant", projectId: "project", name: "灰度验收", ownerId: "owner",
      dueAt: "2026-08-21", status: "active" as const, acceptanceCriteria: "客户签字", version: 1,
    };
    expect(transitionMilestone(milestone, "completed", new Date("2026-08-20T08:00:00Z"))).toMatchObject({
      status: "completed", version: 2, completedAt: "2026-08-20T08:00:00.000Z",
    });
    const task = {
      id: "task", tenantId: "tenant", projectId: "project", title: "联调", description: "",
      assigneeId: "owner", status: "todo" as const, priority: "high" as const, version: 1,
    };
    expect(transitionTask(transitionTask(task, "in_progress"), "in_review")).toMatchObject({ status: "in_review", version: 3 });
    const issue = {
      id: "issue", tenantId: "tenant", projectId: "project", title: "接口故障", description: "",
      ownerId: "owner", severity: "high" as const, status: "resolving" as const, version: 2,
    };
    expect(() => transitionIssue(issue, "resolved")).toThrow("ISSUE_RESOLUTION_REQUIRED");
    expect(transitionIssue(issue, "resolved", "切换备用接口")).toMatchObject({ status: "resolved", version: 3 });
  });
});

describe("management loop application service", () => {
  it("closes risk-to-decision-to-action with outbox evidence", async () => {
    const repository = new InMemoryManagementLoopRepository();
    const events = new InMemoryEventStore();
    const service = new ManagementLoopService(repository, events);
    const context = createDevelopmentRequestContext("trace-management-loop");

    const risk = await service.identifyRisk(context, {
      projectId: DEMO_PROJECT_ID,
      title: "灰度资源尚未确认",
      description: "上线窗口前需要明确临时支持人选。",
      ownerId: DEMO_MANAGER_ID,
      probability: 3,
      impact: 4,
      sourceType: "human",
    });
    const result = await service.recordDecision(context, {
      projectId: DEMO_PROJECT_ID,
      riskId: risk.id,
      title: "采用 30% 灰度方案",
      decisionContext: "联调延迟压缩了验证窗口。",
      options: ["30% 灰度", "全量上线", "延期上线"],
      selectedOption: "30% 灰度",
      rationale: "在不扩大故障面的前提下保住客户窗口。",
      actionItems: [
        {
          title: "确认临时支持人选",
          ownerId: DEMO_MANAGER_ID,
          dueAt: "2026-08-06T03:00:00.000Z",
          acceptanceCriteria: "负责人和排班均书面确认",
        },
      ],
    });
    const completed = await service.completeAction(context, result.actionItems[0].id, "排班单 OPS-2026-081 已确认");
    const movedTask = await service.transitionTask(context, "70000000-0000-4000-8000-000000000002", "completed");
    const issue = await service.reportIssue(context, {
      projectId: DEMO_PROJECT_ID,
      riskId: risk.id,
      title: "客户验收接口实际不可用",
      description: "风险已经发生，需要按问题流程处置。",
      ownerId: DEMO_MANAGER_ID,
      severity: "high",
    });
    const snapshot = await service.getSnapshot(context, DEMO_PROJECT_ID);

    expect(risk.status).toBe("identified");
    expect(result.decision.status).toBe("decided");
    expect(completed.status).toBe("completed");
    expect(movedTask.status).toBe("completed");
    expect(issue.status).toBe("open");
    expect(snapshot.risks).toHaveLength(2);
    expect(snapshot.decisions).toHaveLength(1);
    expect(snapshot.actionItems[0].completionEvidence).toContain("OPS-2026-081");
    expect(events.outbox.map(({ type }) => type)).toEqual([
      "risk.identified",
      "decision.decided",
      "action_item.completed",
      "task.status_changed",
      "issue.reported",
    ]);
  });

  it("denies write access without the matching permission", async () => {
    const service = new ManagementLoopService(new InMemoryManagementLoopRepository(), new InMemoryEventStore());
    const context = createDevelopmentRequestContext();
    context.permissions = ["project:read"];
    await expect(
      service.identifyRisk(context, {
        projectId: DEMO_PROJECT_ID,
        title: "缺少权限的风险",
        description: "该写入应被策略拒绝。",
        ownerId: DEMO_MANAGER_ID,
        probability: 2,
        impact: 2,
        sourceType: "human",
      }),
    ).rejects.toThrow("POLICY_DENIED:PERMISSION_MISSING");
  });

  it("retains a superseded decision and links the independently versioned replacement", async () => {
    const repository = new InMemoryManagementLoopRepository();
    const events = new InMemoryEventStore();
    const service = new ManagementLoopService(repository, events);
    const context = createDevelopmentRequestContext("trace-decision-supersession");
    const created = await service.recordDecision(context, {
      projectId: DEMO_PROJECT_ID, title: "原发布策略", decisionContext: "客户窗口有限",
      options: ["一次发布", "分批发布"], selectedOption: "一次发布", rationale: "按原计划执行", actionItems: [{ title: "准备发布", ownerId: DEMO_MANAGER_ID, dueAt: "2026-08-07T00:00:00.000Z", acceptanceCriteria: "发布清单完成" }],
    });
    const result = await service.supersedeDecision(context, created.decision.id, {
      version: created.decision.version, title: "调整为分批发布", decisionContext: "新风险证据出现",
      options: ["一次发布", "分批发布"], selectedOption: "分批发布", rationale: "缩小故障影响面", reviewAt: "2026-08-20T00:00:00.000Z",
    });
    const snapshot = await repository.getSnapshot(context.tenantId, DEMO_PROJECT_ID);
    expect(result.original).toMatchObject({ id: created.decision.id, status: "superseded", version: 4 });
    expect(result.replacement).toMatchObject({ status: "decided", supersedesId: created.decision.id, version: 3 });
    expect(snapshot?.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.decision.id, status: "superseded" }),
      expect.objectContaining({ id: result.replacement.id, supersedesId: created.decision.id }),
    ]));
  });
});
