import { randomUUID } from "node:crypto";
import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import type { EventStore } from "@/src/modules/events/application/event-store";
import { createDomainEvent } from "@/src/modules/events/domain/event-envelope";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { WorkflowRepository } from "@/src/modules/workflow/application/contracts";
import type { KnowledgeService } from "@/src/modules/knowledge/application/service";
import {
  decideApproval as applyDecision,
  delegateApproval as applyDelegation,
  nextNodeAfterApproval,
  resolveRuntimeNode,
  validateProcessGraph,
  type Approval,
  type ApprovalNode,
  type ProcessDefinition,
  type ProcessDefinitionVersion,
  type ProcessInstance,
  type ProcessNode,
} from "@/src/modules/workflow/domain/process";

function requirePolicy(context: RequestContext, action: "read" | "create" | "update" | "approve" | "admin", type: string, id: string, ownerId?: string) {
  const result = evaluateAccess({ context, action, resource: { tenantId: context.tenantId, type, id, ownerId } });
  if (!result.allowed) throw new Error(`POLICY_DENIED:${result.reason}`);
}

export class WorkflowService {
  constructor(private readonly repository: WorkflowRepository, private readonly events: EventStore) {}

  async snapshot(context: RequestContext) {
    requirePolicy(context, "read", "process_instance", "workspace");
    return this.repository.getSnapshot(context.tenantId, context.actorId);
  }

  async getInstance(context: RequestContext, id: string) {
    const instance = await this.repository.getInstance(context.tenantId, id);
    if (!instance) throw new Error("PROCESS_INSTANCE_NOT_FOUND");
    requirePolicy(context, "read", "process_instance", instance.id, instance.requesterId);
    return instance;
  }

  async preReview(context: RequestContext, id: string, knowledge: KnowledgeService) {
    const instance = await this.getInstance(context, id);
    const evidence = await knowledge.search(context, `${instance.title} ${JSON.stringify(instance.formSnapshot)}`, { forAgent: true, limit: 5 });
    const missingEvidence = Object.entries(instance.formSnapshot)
      .filter(([key, value]) => /evidence|report|attachment|material/i.test(key) && (!value || String(value).includes("待")))
      .map(([key]) => key);
    return {
      instanceId: instance.id,
      recommendation: missingEvidence.length > 0 ? "request_more_information" as const : "manual_review" as const,
      findings: [
        ...(instance.riskLevel >= 3 ? ["这是 R3/R4 流程，申请人与最终批准人必须职责分离。"] : []),
        ...missingEvidence.map((field) => `字段 ${field} 的证据不完整。`),
      ],
      citations: evidence,
      stateChanged: false as const,
    };
  }

  async publishDefinition(context: RequestContext, input: {
    definitionId?: string;
    code: string;
    name: string;
    description?: string;
    startNodeKey: string;
    nodes: ProcessNode[];
  }): Promise<{ definition: ProcessDefinition; version: ProcessDefinitionVersion }> {
    requirePolicy(context, "admin", "process_definition", input.definitionId ?? "new");
    validateProcessGraph(input.startNodeKey, input.nodes);
    const current = input.definitionId ? await this.repository.getDefinition(context.tenantId, input.definitionId) : null;
    if (input.definitionId && !current) throw new Error("PROCESS_DEFINITION_NOT_FOUND");
    const nextVersion = (current?.currentVersion ?? 0) + 1;
    const definition: ProcessDefinition = current ? {
      ...current,
      code: input.code,
      name: input.name,
      description: input.description ?? "",
      status: "published",
      currentVersion: nextVersion,
      version: current.version + 1,
    } : {
      id: randomUUID(), tenantId: context.tenantId, code: input.code, name: input.name,
      description: input.description ?? "", ownerId: context.actorId, status: "published",
      currentVersion: nextVersion, version: 1,
    };
    const version: ProcessDefinitionVersion = {
      id: randomUUID(), tenantId: context.tenantId, definitionId: definition.id, version: nextVersion,
      startNodeKey: input.startNodeKey, nodes: structuredClone(input.nodes), publishedBy: context.actorId,
      publishedAt: new Date().toISOString(),
    };
    await this.repository.savePublishedDefinition(definition, version);
    await this.events.appendOutbox(createDomainEvent({
      type: "process_definition.published", version: 1, tenantId: context.tenantId,
      aggregateType: "process_definition", aggregateId: definition.id, aggregateVersion: definition.version,
      actor: { type: "user", id: context.actorId }, traceId: context.traceId,
      payload: { definitionVersion: version.version },
    }));
    return { definition, version };
  }

  async startProcess(context: RequestContext, input: {
    definitionId: string;
    title: string;
    form: Record<string, unknown>;
    riskLevel: 0 | 1 | 2 | 3 | 4;
  }): Promise<{ instance: ProcessInstance; approvals: Approval[] }> {
    requirePolicy(context, "create", "process_instance", "new", context.actorId);
    const definition = await this.repository.getDefinition(context.tenantId, input.definitionId);
    if (!definition || definition.status !== "published") throw new Error("PROCESS_DEFINITION_NOT_FOUND");
    const pinned = await this.repository.getDefinitionVersion(context.tenantId, definition.id, definition.currentVersion);
    if (!pinned) throw new Error("PROCESS_DEFINITION_VERSION_NOT_FOUND");
    const runtimeNode = resolveRuntimeNode(pinned, pinned.startNodeKey, input.form);
    const now = new Date();
    const instance: ProcessInstance = {
      id: randomUUID(), tenantId: context.tenantId, definitionId: definition.id,
      definitionVersion: pinned.version, requesterId: context.actorId, title: input.title,
      formSnapshot: structuredClone(input.form), status: runtimeNode.type === "end" ? runtimeNode.outcome : "running",
      currentNodeKey: runtimeNode.key, riskLevel: input.riskLevel,
      ...(runtimeNode.type === "approval" ? { slaDueAt: new Date(now.getTime() + runtimeNode.slaHours * 3_600_000).toISOString() } : { completedAt: now.toISOString() }),
      version: 1, createdAt: now.toISOString(),
    };
    const approvals = runtimeNode.type === "approval" ? this.createApprovals(instance, runtimeNode, context.actorId) : [];
    await this.repository.saveInstance(instance);
    await this.repository.saveApprovals(approvals);
    await this.events.appendOutbox(createDomainEvent({
      type: "approval.requested", version: 1, tenantId: context.tenantId,
      aggregateType: "process_instance", aggregateId: instance.id, aggregateVersion: instance.version,
      actor: { type: "user", id: context.actorId }, traceId: context.traceId,
      payload: { definitionId: definition.id, definitionVersion: pinned.version, approvalIds: approvals.map(({ id }) => id) },
    }));
    return { instance, approvals };
  }

  async decide(context: RequestContext, approvalId: string, input: { decision: "approve" | "reject"; comment: string; version: number }) {
    const current = await this.repository.getApproval(context.tenantId, approvalId);
    if (!current) throw new Error("APPROVAL_NOT_FOUND");
    requirePolicy(context, "approve", "approval", current.id, current.approverId);
    if (current.approverId !== context.actorId) throw new Error("POLICY_DENIED:APPROVER_MISMATCH");
    if (current.version !== input.version) throw new Error("APPROVAL_VERSION_CONFLICT");
    const approval = applyDecision(current, input.decision, input.comment);
    if (!(await this.repository.saveApproval(approval, current.version))) throw new Error("APPROVAL_VERSION_CONFLICT");

    const instance = await this.repository.getInstance(context.tenantId, current.instanceId);
    if (!instance) throw new Error("PROCESS_INSTANCE_NOT_FOUND");
    if (input.decision === "reject") {
      const rejected = { ...instance, status: "rejected" as const, completedAt: new Date().toISOString(), version: instance.version + 1 };
      if (!(await this.repository.saveInstance(rejected, instance.version))) throw new Error("PROCESS_INSTANCE_VERSION_CONFLICT");
      await this.cancelPendingApprovals(context.tenantId, rejected.id, undefined, "PROCESS_REJECTED");
      await this.emitDecision(context, rejected, approval);
      return { approval, instance: rejected };
    }

    const definition = await this.repository.getDefinitionVersion(context.tenantId, instance.definitionId, instance.definitionVersion);
    if (!definition) throw new Error("PROCESS_DEFINITION_VERSION_NOT_FOUND");
    const node = definition.nodes.find((candidate) => candidate.key === current.nodeKey);
    if (!node || node.type !== "approval") throw new Error("PROCESS_APPROVAL_NODE_MISSING");
    const approvals = await this.repository.listApprovals(context.tenantId, instance.id, node.key);
    const nodeComplete = node.mode === "any" ? approvals.some(({ status }) => status === "approved") : approvals.every(({ status }) => status === "approved");
    if (!nodeComplete) return { approval, instance };
    const next = resolveRuntimeNode(definition, nextNodeAfterApproval(definition, node.key), instance.formSnapshot);
    const advanced: ProcessInstance = {
      ...instance,
      currentNodeKey: next.key,
      status: next.type === "end" ? next.outcome : "running",
      ...(next.type === "end"
        ? { completedAt: new Date().toISOString(), slaDueAt: undefined }
        : { completedAt: undefined, slaDueAt: new Date(Date.now() + next.slaHours * 3_600_000).toISOString() }),
      version: instance.version + 1,
    };
    if (!(await this.repository.saveInstance(advanced, instance.version))) throw new Error("PROCESS_INSTANCE_VERSION_CONFLICT");
    if (node.mode === "any") await this.cancelPendingApprovals(context.tenantId, instance.id, node.key, "PARALLEL_ANY_COMPLETED");
    if (next.type === "approval") await this.repository.saveApprovals(this.createApprovals(advanced, next, advanced.requesterId));
    await this.emitDecision(context, advanced, approval);
    return { approval, instance: advanced };
  }

  async delegate(context: RequestContext, approvalId: string, input: { delegateId: string; version: number }) {
    const current = await this.repository.getApproval(context.tenantId, approvalId);
    if (!current) throw new Error("APPROVAL_NOT_FOUND");
    requirePolicy(context, "update", "approval", current.id, current.approverId);
    if (current.approverId !== context.actorId) throw new Error("POLICY_DENIED:APPROVER_MISMATCH");
    if (current.version !== input.version) throw new Error("APPROVAL_VERSION_CONFLICT");
    const instance = await this.repository.getInstance(context.tenantId, current.instanceId);
    if (!instance) throw new Error("PROCESS_INSTANCE_NOT_FOUND");
    if (instance.status !== "running") throw new Error("PROCESS_INSTANCE_INVALID_TRANSITION");
    if (instance.riskLevel >= 3 && input.delegateId === instance.requesterId) throw new Error("SEPARATION_OF_DUTIES_REQUIRED");
    const delegated = applyDelegation(current, input.delegateId);
    if (!(await this.repository.saveApproval(delegated, current.version))) throw new Error("APPROVAL_VERSION_CONFLICT");
    const replacement: Approval = {
      ...current, id: randomUUID(), approverId: input.delegateId, status: "pending", decision: undefined,
      comment: undefined, delegatedFromId: current.id, delegatedToId: undefined, version: 1,
    };
    await this.repository.saveApprovals([replacement]);
    return { delegated, replacement };
  }

  async addApprover(context: RequestContext, instanceId: string, input: { approverId: string }) {
    const instance = await this.repository.getInstance(context.tenantId, instanceId);
    if (!instance) throw new Error("PROCESS_INSTANCE_NOT_FOUND");
    requirePolicy(context, "approve", "process_instance", instance.id);
    if (instance.status !== "running") throw new Error("PROCESS_INSTANCE_INVALID_TRANSITION");
    const existing = await this.repository.listApprovals(context.tenantId, instance.id, instance.currentNodeKey);
    if (existing.some(({ approverId, status }) => approverId === input.approverId && status === "pending")) throw new Error("APPROVER_ALREADY_PENDING");
    if (instance.riskLevel >= 3 && input.approverId === instance.requesterId) throw new Error("SEPARATION_OF_DUTIES_REQUIRED");
    const approval: Approval = {
      id: randomUUID(), tenantId: context.tenantId, instanceId: instance.id, nodeKey: instance.currentNodeKey,
      approverId: input.approverId, requestedBy: context.actorId, status: "pending",
      dueAt: instance.slaDueAt ?? new Date(Date.now() + 86_400_000).toISOString(), version: 1,
    };
    await this.repository.saveApprovals([approval]);
    return approval;
  }

  async withdraw(context: RequestContext, instanceId: string, input: { version: number; reason: string }) {
    const instance = await this.repository.getInstance(context.tenantId, instanceId);
    if (!instance) throw new Error("PROCESS_INSTANCE_NOT_FOUND");
    requirePolicy(context, "update", "process_instance", instance.id, instance.requesterId);
    if (instance.requesterId !== context.actorId) throw new Error("POLICY_DENIED:REQUESTER_MISMATCH");
    if (instance.version !== input.version) throw new Error("PROCESS_INSTANCE_VERSION_CONFLICT");
    if (instance.status !== "running") throw new Error("PROCESS_INSTANCE_INVALID_TRANSITION");
    const withdrawn: ProcessInstance = {
      ...instance,
      status: "withdrawn",
      completedAt: new Date().toISOString(),
      slaDueAt: undefined,
      version: instance.version + 1,
    };
    if (!(await this.repository.saveInstance(withdrawn, instance.version))) throw new Error("PROCESS_INSTANCE_VERSION_CONFLICT");
    const cancelledApprovals = await this.cancelPendingApprovals(context.tenantId, instance.id, undefined, `WITHDRAWN:${input.reason.trim()}`);
    await this.events.appendOutbox(createDomainEvent({
      type: "process_instance.withdrawn", version: 1, tenantId: context.tenantId,
      aggregateType: "process_instance", aggregateId: withdrawn.id, aggregateVersion: withdrawn.version,
      actor: { type: "user", id: context.actorId }, traceId: context.traceId,
      payload: { reason: input.reason.trim(), cancelledApprovalIds: cancelledApprovals.map(({ id }) => id) },
    }));
    return { instance: withdrawn, cancelledApprovals };
  }

  async escalateOverdue(context: RequestContext, input: { now?: string; limit: number }) {
    requirePolicy(context, "admin", "process_definition", "sla-maintenance");
    const now = input.now ? new Date(input.now) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error("PROCESS_ESCALATION_TIME_INVALID");
    const overdue = await this.repository.listOverdueApprovals(context.tenantId, now.toISOString(), input.limit);
    const escalated: Array<{ source: Approval; replacements: Approval[] }> = [];
    const needsConfiguration: string[] = [];

    for (const current of overdue) {
      const instance = await this.repository.getInstance(context.tenantId, current.instanceId);
      if (!instance || instance.status !== "running") continue;
      const definition = await this.repository.getDefinitionVersion(context.tenantId, instance.definitionId, instance.definitionVersion);
      const node = definition?.nodes.find((candidate) => candidate.key === current.nodeKey);
      if (!node || node.type !== "approval") continue;
      const existing = await this.repository.listApprovals(context.tenantId, instance.id, node.key);
      const targetIds = (node.escalationApproverIds ?? []).filter((targetId) =>
        targetId !== current.approverId &&
        !(instance.riskLevel >= 3 && targetId === instance.requesterId) &&
        !existing.some(({ approverId, status }) => approverId === targetId && status === "pending"),
      );
      if (targetIds.length === 0) {
        needsConfiguration.push(current.id);
        continue;
      }
      const source: Approval = {
        ...current,
        status: "escalated",
        comment: "SLA_EXPIRED",
        decidedAt: now.toISOString(),
        version: current.version + 1,
      };
      if (!(await this.repository.saveApproval(source, current.version))) continue;
      const replacements = targetIds.map<Approval>((approverId) => ({
        id: randomUUID(), tenantId: current.tenantId, instanceId: current.instanceId, nodeKey: current.nodeKey,
        approverId, requestedBy: context.actorId, status: "pending", escalatedFromId: current.id,
        escalationLevel: (current.escalationLevel ?? 0) + 1,
        dueAt: new Date(now.getTime() + node.slaHours * 3_600_000).toISOString(), version: 1,
      }));
      await this.repository.saveApprovals(replacements);
      escalated.push({ source, replacements });
      await this.events.appendOutbox(createDomainEvent({
        type: "approval.escalated", version: 1, tenantId: context.tenantId,
        aggregateType: "process_instance", aggregateId: instance.id, aggregateVersion: instance.version,
        actor: { type: "system", id: context.actorId }, traceId: context.traceId,
        payload: { sourceApprovalId: current.id, replacementApprovalIds: replacements.map(({ id }) => id), overdueAt: current.dueAt },
      }));
    }
    return { escalated, needsConfiguration, evaluatedAt: now.toISOString() };
  }

  private createApprovals(instance: ProcessInstance, node: ApprovalNode, requestedBy: string): Approval[] {
    const approverIds = instance.riskLevel >= 3 ? node.approverIds.filter((id) => id !== instance.requesterId) : node.approverIds;
    if (approverIds.length === 0) throw new Error("SEPARATION_OF_DUTIES_REQUIRED");
    const dueAt = new Date(Date.now() + node.slaHours * 3_600_000).toISOString();
    return approverIds.map((approverId) => ({
      id: randomUUID(), tenantId: instance.tenantId, instanceId: instance.id, nodeKey: node.key,
      approverId, requestedBy, status: "pending", dueAt, version: 1,
    }));
  }

  private async cancelPendingApprovals(tenantId: string, instanceId: string, nodeKey: string | undefined, reason: string) {
    const approvals = await this.repository.listApprovals(tenantId, instanceId, nodeKey);
    const cancelled: Approval[] = [];
    for (const current of approvals.filter(({ status }) => status === "pending")) {
      const next: Approval = {
        ...current,
        status: "cancelled",
        comment: reason,
        decidedAt: new Date().toISOString(),
        version: current.version + 1,
      };
      if (await this.repository.saveApproval(next, current.version)) cancelled.push(next);
    }
    return cancelled;
  }

  private async emitDecision(context: RequestContext, instance: ProcessInstance, approval: Approval) {
    await this.events.appendOutbox(createDomainEvent({
      type: "approval.decided", version: 1, tenantId: context.tenantId,
      aggregateType: "process_instance", aggregateId: instance.id, aggregateVersion: instance.version,
      actor: { type: "user", id: context.actorId }, traceId: context.traceId,
      payload: { approvalId: approval.id, decision: approval.decision, status: instance.status },
    }));
  }
}
