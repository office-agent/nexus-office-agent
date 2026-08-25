import type { ManagementLoopRepository, ManagementSnapshot } from "@/src/modules/management-loop/application/contracts";
import type { Risk } from "@/src/modules/governance/domain/risk";
import type { Decision } from "@/src/modules/governance/domain/decision";
import type { ActionItem } from "@/src/modules/collaboration/domain/action-item";
import type { DeliveryTask } from "@/src/modules/delivery/domain/task";
import type { Issue } from "@/src/modules/governance/domain/issue";
import { InMemoryEventStore, type EventStore } from "@/src/modules/events/application/event-store";
import type { DomainEvent } from "@/src/modules/events/domain/event-envelope";
import {
  DEMO_MANAGER_ID,
  DEMO_OBJECTIVE_ID,
  DEMO_PROJECT_ID,
  DEMO_TENANT_ID,
} from "@/src/platform/context/development-context";

export { DEMO_MANAGER_ID, DEMO_OBJECTIVE_ID, DEMO_PROJECT_ID, DEMO_TENANT_ID };

function initialSnapshot(): ManagementSnapshot {
  return {
    objective: {
      id: DEMO_OBJECTIVE_ID,
      tenantId: DEMO_TENANT_ID,
      title: "核心客户按期交付率达到 95%",
      description: "通过交付标准化和风险前置管理提升企业客户体验。",
      ownerId: DEMO_MANAGER_ID,
      status: "active",
      baseline: 82,
      targetValue: 95,
      currentValue: 88,
      unit: "%",
      startsAt: "2026-07-01",
      endsAt: "2026-09-30",
      reviewCadence: "weekly",
      version: 1,
    },
    project: {
      id: DEMO_PROJECT_ID,
      tenantId: DEMO_TENANT_ID,
      code: "PRJ-2026-018",
      name: "智能客服 2.0 华东上线",
      description: "为华东核心客户交付智能客服升级和灰度上线。",
      ownerId: DEMO_MANAGER_ID,
      status: "active",
      priority: "critical",
      startsAt: "2026-07-15",
      targetEndAt: "2026-08-21",
      health: "at_risk",
      version: 3,
    },
    risks: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        tenantId: DEMO_TENANT_ID,
        projectId: DEMO_PROJECT_ID,
        title: "接口联调晚于基线 2 天",
        description: "客户侧接口环境交付延迟，压缩灰度验证窗口。",
        ownerId: DEMO_MANAGER_ID,
        probability: 4,
        impact: 4,
        status: "assessed",
        sourceType: "event",
        sourceRef: "demo:event:integration-delay",
        reviewAt: "2026-08-05T11:00:00+08:00",
        version: 1,
      },
    ],
    decisions: [],
    actionItems: [],
    milestones: [
      {
        id: "60000000-0000-4000-8000-000000000001",
        tenantId: DEMO_TENANT_ID,
        projectId: DEMO_PROJECT_ID,
        name: "华东客户灰度验收",
        ownerId: DEMO_MANAGER_ID,
        dueAt: "2026-08-21",
        status: "at_risk",
        acceptanceCriteria: "核心业务场景连续 48 小时稳定，客户签署灰度验收单。",
        version: 2,
      },
    ],
    tasks: [
      {
        id: "70000000-0000-4000-8000-000000000001",
        tenantId: DEMO_TENANT_ID,
        projectId: DEMO_PROJECT_ID,
        milestoneId: "60000000-0000-4000-8000-000000000001",
        title: "完成接口联调回归",
        description: "覆盖订单、工单和客户身份三个关键链路。",
        assigneeId: DEMO_MANAGER_ID,
        status: "in_progress",
        priority: "critical",
        dueAt: "2026-08-06T10:00:00+08:00",
        version: 2,
      },
      {
        id: "70000000-0000-4000-8000-000000000002",
        tenantId: DEMO_TENANT_ID,
        projectId: DEMO_PROJECT_ID,
        milestoneId: "60000000-0000-4000-8000-000000000001",
        title: "准备 30% 灰度发布脚本",
        description: "包含放量、观测和一键回滚步骤。",
        assigneeId: DEMO_MANAGER_ID,
        status: "in_review",
        priority: "high",
        dueAt: "2026-08-06T15:00:00+08:00",
        version: 3,
      },
      {
        id: "70000000-0000-4000-8000-000000000003",
        tenantId: DEMO_TENANT_ID,
        projectId: DEMO_PROJECT_ID,
        milestoneId: "60000000-0000-4000-8000-000000000001",
        title: "确认客户验收人与时间窗",
        description: "取得客户侧书面确认并同步上线群。",
        assigneeId: DEMO_MANAGER_ID,
        status: "blocked",
        priority: "high",
        dueAt: "2026-08-07T11:00:00+08:00",
        version: 2,
      },
    ],
    issues: [],
    generatedAt: new Date().toISOString(),
  };
}

export class InMemoryManagementLoopRepository implements ManagementLoopRepository {
  private readonly snapshots = new Map<string, ManagementSnapshot>();

  constructor(private readonly events: EventStore = new InMemoryEventStore()) {
    this.snapshots.set(`${DEMO_TENANT_ID}:${DEMO_PROJECT_ID}`, initialSnapshot());
  }

  async getSnapshot(tenantId: string, projectId: string): Promise<ManagementSnapshot | null> {
    const snapshot = this.snapshots.get(`${tenantId}:${projectId}`);
    return snapshot ? structuredClone({ ...snapshot, generatedAt: new Date().toISOString() }) : null;
  }

  async getRisk(tenantId: string, id: string): Promise<Risk | null> {
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.project.tenantId !== tenantId) continue;
      const risk = snapshot.risks.find((candidate) => candidate.id === id);
      if (risk) return structuredClone(risk);
    }
    return null;
  }

  async saveRisk(risk: Risk, event: DomainEvent): Promise<void> {
    const snapshot = this.requireSnapshot(risk.tenantId, risk.projectId);
    const before = structuredClone(snapshot.risks);
    const index = snapshot.risks.findIndex(({ id }) => id === risk.id);
    if (index >= 0) snapshot.risks[index] = structuredClone(risk);
    else snapshot.risks.push(structuredClone(risk));
    try { await this.events.appendOutbox(event); } catch (error) { snapshot.risks = before; throw error; }
  }

  async saveDecision(decision: Decision, actionItems: ActionItem[], event: DomainEvent): Promise<void> {
    if (!decision.projectId) throw new Error("DECISION_PROJECT_REQUIRED");
    const snapshot = this.requireSnapshot(decision.tenantId, decision.projectId);
    if (decision.riskId && !snapshot.risks.some(({ id }) => id === decision.riskId)) throw new Error("RISK_NOT_FOUND");
    if (actionItems.some((item) => item.projectId !== decision.projectId || item.decisionId !== decision.id)) {
      throw new Error("ACTION_ITEM_DECISION_MISMATCH");
    }
    const beforeDecisions = structuredClone(snapshot.decisions);
    const beforeActions = structuredClone(snapshot.actionItems);
    const index = snapshot.decisions.findIndex(({ id }) => id === decision.id);
    if (index >= 0) snapshot.decisions[index] = structuredClone(decision);
    else snapshot.decisions.push(structuredClone(decision));
    for (const item of actionItems) {
      const actionIndex = snapshot.actionItems.findIndex(({ id }) => id === item.id);
      if (actionIndex >= 0) snapshot.actionItems[actionIndex] = structuredClone(item);
      else snapshot.actionItems.push(structuredClone(item));
    }
    try { await this.events.appendOutbox(event); } catch (error) {
      snapshot.decisions = beforeDecisions;
      snapshot.actionItems = beforeActions;
      throw error;
    }
  }

  async getDecision(tenantId: string, id: string): Promise<Decision | null> {
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.project.tenantId !== tenantId) continue;
      const decision = snapshot.decisions.find((candidate) => candidate.id === id);
      if (decision) return structuredClone(decision);
    }
    return null;
  }

  async replaceDecision(original: Decision, replacement: Decision, expectedOriginalVersion: number, event: DomainEvent): Promise<boolean> {
    if (!original.projectId || original.projectId !== replacement.projectId) return false;
    const snapshot = this.requireSnapshot(original.tenantId, original.projectId);
    const index = snapshot.decisions.findIndex(({ id }) => id === original.id);
    if (index < 0 || snapshot.decisions[index].version !== expectedOriginalVersion || snapshot.decisions.some(({ id }) => id === replacement.id)) return false;
    const before = structuredClone(snapshot.decisions);
    snapshot.decisions[index] = structuredClone(original);
    snapshot.decisions.push(structuredClone(replacement));
    try { await this.events.appendOutbox(event); } catch (error) { snapshot.decisions = before; throw error; }
    return true;
  }

  async getActionItem(tenantId: string, id: string): Promise<ActionItem | null> {
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.project.tenantId !== tenantId) continue;
      const item = snapshot.actionItems.find((candidate) => candidate.id === id);
      if (item) return structuredClone(item);
    }
    return null;
  }

  async saveActionItem(item: ActionItem, expectedVersion: number, event: DomainEvent): Promise<boolean> {
    if (!item.projectId) throw new Error("ACTION_ITEM_PROJECT_REQUIRED");
    const snapshot = this.requireSnapshot(item.tenantId, item.projectId);
    const index = snapshot.actionItems.findIndex(({ id }) => id === item.id);
    if (index < 0 || snapshot.actionItems[index].version !== expectedVersion) return false;
    const before = structuredClone(snapshot.actionItems[index]);
    snapshot.actionItems[index] = structuredClone(item);
    try { await this.events.appendOutbox(event); } catch (error) { snapshot.actionItems[index] = before; throw error; }
    return true;
  }

  async getTask(tenantId: string, id: string): Promise<DeliveryTask | null> {
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.project.tenantId !== tenantId) continue;
      const task = snapshot.tasks.find((candidate) => candidate.id === id);
      if (task) return structuredClone(task);
    }
    return null;
  }

  async saveTask(task: DeliveryTask, expectedVersion: number, event: DomainEvent): Promise<boolean> {
    const snapshot = this.requireSnapshot(task.tenantId, task.projectId);
    const index = snapshot.tasks.findIndex(({ id }) => id === task.id);
    if (index < 0 || snapshot.tasks[index].version !== expectedVersion) return false;
    const before = structuredClone(snapshot.tasks[index]);
    snapshot.tasks[index] = structuredClone(task);
    try { await this.events.appendOutbox(event); } catch (error) { snapshot.tasks[index] = before; throw error; }
    return true;
  }

  async saveIssue(issue: Issue, event: DomainEvent): Promise<void> {
    const snapshot = this.requireSnapshot(issue.tenantId, issue.projectId);
    const before = structuredClone(snapshot.issues);
    const index = snapshot.issues.findIndex(({ id }) => id === issue.id);
    if (index >= 0) snapshot.issues[index] = structuredClone(issue);
    else snapshot.issues.push(structuredClone(issue));
    try { await this.events.appendOutbox(event); } catch (error) { snapshot.issues = before; throw error; }
  }

  private requireSnapshot(tenantId: string, projectId: string): ManagementSnapshot {
    const snapshot = this.snapshots.get(`${tenantId}:${projectId}`);
    if (!snapshot) throw new Error("PROJECT_NOT_FOUND");
    return snapshot;
  }
}

const globalManagementRepository = globalThis as typeof globalThis & {
  __nexusManagementRepository?: InMemoryManagementLoopRepository;
  __nexusManagementRepositoryVersion?: number;
};

export function getDevelopmentManagementRepository(events?: EventStore): InMemoryManagementLoopRepository {
  if (globalManagementRepository.__nexusManagementRepositoryVersion !== 3) {
    globalManagementRepository.__nexusManagementRepository = new InMemoryManagementLoopRepository(events);
    globalManagementRepository.__nexusManagementRepositoryVersion = 3;
  }
  return globalManagementRepository.__nexusManagementRepository!;
}
