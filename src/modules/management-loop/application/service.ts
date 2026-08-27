import { randomUUID } from "node:crypto";
import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import { completeActionItem, type ActionItem } from "@/src/modules/collaboration/domain/action-item";
import { decide, markDecisionSuperseded, submitDecision, type Decision } from "@/src/modules/governance/domain/decision";
import { type Risk } from "@/src/modules/governance/domain/risk";
import { createDomainEvent, type DomainEvent } from "@/src/modules/events/domain/event-envelope";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { ManagementLoopRepository, ManagementSnapshot } from "@/src/modules/management-loop/application/contracts";
import { transitionTask as moveTask, type DeliveryTaskStatus } from "@/src/modules/delivery/domain/task";
import type { Issue } from "@/src/modules/governance/domain/issue";

function requireAllowed(allowed: boolean, reason: string): void {
  if (!allowed) throw new Error(`POLICY_DENIED:${reason}`);
}

export class ManagementLoopService {
  constructor(private readonly repository: ManagementLoopRepository) {}

  async getSnapshot(context: RequestContext, projectId: string): Promise<ManagementSnapshot> {
    const decision = evaluateAccess({
      context,
      action: "read",
      resource: { tenantId: context.tenantId, type: "project", id: projectId, projectId },
    });
    requireAllowed(decision.allowed, decision.reason);
    const snapshot = await this.repository.getSnapshot(context.tenantId, projectId);
    if (!snapshot) throw new Error("PROJECT_NOT_FOUND");
    return snapshot;
  }

  async identifyRisk(
    context: RequestContext,
    input: Pick<Risk, "projectId" | "title" | "description" | "ownerId" | "probability" | "impact" | "sourceType" | "sourceRef"> & { riskId?: string; eventId?: string },
  ): Promise<Risk> {
    const { riskId, eventId, ...riskInput } = input;
    const policy = evaluateAccess({
      context,
      action: "create",
      resource: { tenantId: context.tenantId, type: "risk", id: "new", projectId: input.projectId },
    });
    requireAllowed(policy.allowed, policy.reason);
    const risk: Risk = {
      ...riskInput,
      id: riskId ?? randomUUID(),
      tenantId: context.tenantId,
      status: "identified",
      version: 1,
    };
    await this.repository.saveRisk(
      risk,
      this.event(context, "risk.identified", "risk", risk.id, risk.version, { projectId: risk.projectId }, eventId),
    );
    return risk;
  }

  async recordDecision(
    context: RequestContext,
    input: {
      decisionId?: string;
      projectId: string;
      riskId?: string;
      sourceMeetingId?: string;
      title: string;
      decisionContext: string;
      options: string[];
      selectedOption: string;
      rationale: string;
      actionItems: Array<{ id?: string; title: string; ownerId: string; dueAt: string; acceptanceCriteria: string }>;
    },
  ): Promise<{ decision: Decision; actionItems: ActionItem[] }> {
    const policy = evaluateAccess({
      context,
      action: "approve",
      resource: { tenantId: context.tenantId, type: "decision", id: "new", projectId: input.projectId },
    });
    requireAllowed(policy.allowed, policy.reason);
    if (input.riskId) {
      const risk = await this.repository.getRisk(context.tenantId, input.riskId);
      if (!risk) throw new Error("RISK_NOT_FOUND");
      if (risk.projectId !== input.projectId) throw new Error("RISK_PROJECT_MISMATCH");
    }
    let decision: Decision = {
      id: input.decisionId ?? randomUUID(),
      tenantId: context.tenantId,
      projectId: input.projectId,
      riskId: input.riskId,
      sourceMeetingId: input.sourceMeetingId,
      title: input.title,
      context: input.decisionContext,
      options: input.options,
      ownerId: context.actorId,
      status: "draft",
      version: 1,
    };
    decision = submitDecision(decision);
    decision = decide(decision, {
      selectedOption: input.selectedOption,
      rationale: input.rationale,
      decidedBy: context.actorId,
    });
    const actionItems = input.actionItems.map((item) => ({
      ...item,
      id: item.id ?? randomUUID(),
      tenantId: context.tenantId,
      projectId: input.projectId,
      decisionId: decision.id,
      description: "",
      status: "open" as const,
      version: 1,
    }));
    await this.repository.saveDecision(decision, actionItems,
      this.event(context, "decision.decided", "decision", decision.id, decision.version, {
        projectId: input.projectId,
        sourceMeetingId: input.sourceMeetingId,
        actionItemIds: actionItems.map(({ id }) => id),
      }),
    );
    return { decision, actionItems };
  }

  async supersedeDecision(context: RequestContext, id: string, input: {
    version: number; title: string; decisionContext: string; options: string[]; selectedOption: string; rationale: string; reviewAt?: string;
  }): Promise<{ original: Decision; replacement: Decision }> {
    const current = await this.repository.getDecision(context.tenantId, id);
    if (!current) throw new Error("DECISION_NOT_FOUND");
    const policy = evaluateAccess({
      context, action: "approve",
      resource: { tenantId: current.tenantId, type: "decision", id: current.id, ownerId: current.ownerId, projectId: current.projectId },
    });
    requireAllowed(policy.allowed, policy.reason);
    const replacementId = randomUUID();
    const original = markDecisionSuperseded(current, replacementId, input.version);
    let replacement: Decision = {
      id: replacementId, tenantId: current.tenantId, projectId: current.projectId, riskId: current.riskId,
      sourceMeetingId: current.sourceMeetingId,
      title: input.title, context: input.decisionContext, options: input.options, ownerId: current.ownerId,
      supersedesId: current.id, status: "draft", version: 1,
    };
    replacement = decide(submitDecision(replacement), {
      selectedOption: input.selectedOption, rationale: input.rationale, decidedBy: context.actorId, reviewAt: input.reviewAt,
    });
    if (!(await this.repository.replaceDecision(
      original,
      replacement,
      input.version,
      this.event(context, "decision.superseded", "decision", original.id, original.version, {
        projectId: original.projectId, replacementDecisionId: replacement.id,
      }),
    ))) throw new Error("DECISION_VERSION_CONFLICT");
    return { original, replacement };
  }

  async completeAction(context: RequestContext, id: string, evidence: string, expectedVersion: number) {
    const current = await this.repository.getActionItem(context.tenantId, id);
    if (!current) throw new Error("ACTION_ITEM_NOT_FOUND");
    const policy = evaluateAccess({
      context,
      action: "update",
      resource: {
        tenantId: current.tenantId,
        type: "action_item",
        id: current.id,
        ownerId: current.ownerId,
        projectId: current.projectId,
      },
    });
    requireAllowed(policy.allowed, policy.reason);
    if (current.version !== expectedVersion) throw new Error("ACTION_ITEM_VERSION_CONFLICT");
    const completed = completeActionItem(current, evidence);
    if (!(await this.repository.saveActionItem(completed, expectedVersion,
      this.event(context, "action_item.completed", "action_item", completed.id, completed.version, {
        projectId: completed.projectId,
        decisionId: completed.decisionId,
      }),
    ))) throw new Error("ACTION_ITEM_VERSION_CONFLICT");
    return completed;
  }

  async transitionTask(context: RequestContext, id: string, next: DeliveryTaskStatus, expectedVersion: number) {
    const current = await this.repository.getTask(context.tenantId, id);
    if (!current) throw new Error("TASK_NOT_FOUND");
    const policy = evaluateAccess({
      context,
      action: "update",
      resource: {
        tenantId: current.tenantId,
        type: "task",
        id: current.id,
        ownerId: current.assigneeId,
        projectId: current.projectId,
      },
    });
    requireAllowed(policy.allowed, policy.reason);
    if (current.version !== expectedVersion) throw new Error("TASK_VERSION_CONFLICT");
    const task = moveTask(current, next);
    if (!(await this.repository.saveTask(task, expectedVersion,
      this.event(context, "task.status_changed", "task", task.id, task.version, {
        projectId: task.projectId,
        previousStatus: current.status,
        status: task.status,
      }),
    ))) throw new Error("TASK_VERSION_CONFLICT");
    return task;
  }

  async reportIssue(
    context: RequestContext,
    input: Pick<Issue, "projectId" | "riskId" | "title" | "description" | "ownerId" | "severity">,
  ): Promise<Issue> {
    const policy = evaluateAccess({
      context,
      action: "create",
      resource: { tenantId: context.tenantId, type: "issue", id: "new", projectId: input.projectId },
    });
    requireAllowed(policy.allowed, policy.reason);
    if (input.riskId) {
      const risk = await this.repository.getRisk(context.tenantId, input.riskId);
      if (!risk) throw new Error("RISK_NOT_FOUND");
      if (risk.projectId !== input.projectId) throw new Error("RISK_PROJECT_MISMATCH");
    }
    const issue: Issue = {
      ...input,
      id: randomUUID(),
      tenantId: context.tenantId,
      status: "open",
      version: 1,
    };
    await this.repository.saveIssue(issue,
      this.event(context, "issue.reported", "issue", issue.id, issue.version, {
        projectId: issue.projectId,
        riskId: issue.riskId,
        severity: issue.severity,
      }),
    );
    return issue;
  }

  private event(
    context: RequestContext,
    type: string,
    aggregateType: string,
    aggregateId: string,
    aggregateVersion: number,
    payload: Record<string, unknown>,
    eventId?: string,
  ): DomainEvent {
    return createDomainEvent({
      ...(eventId ? { id: eventId } : {}),
      type,
      version: 1,
      tenantId: context.tenantId,
      aggregateType,
      aggregateId,
      aggregateVersion,
      actor: { type: "user", id: context.actorId },
      traceId: context.traceId,
      payload,
    });
  }
}
