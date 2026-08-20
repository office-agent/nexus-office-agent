import { randomUUID } from "node:crypto";
import type { Citation } from "@/src/modules/agent/domain/agent-run";
import type { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { DEMO_PROJECT_ID } from "@/src/platform/context/development-context";
import type { RequestContext } from "@/src/platform/context/request-context";
import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import type { TaskCommandService } from "@/src/modules/task-command/application/service";
import type { AgentMemoryService } from "@/src/modules/agent-memory/application/service";
import { classifyUntrustedText, mostRestrictiveClassification, type DataClassification } from "@/src/platform/security/data-classification";

export type AgentContextPackage = {
  projectId: string;
  summary: string;
  citations: Citation[];
  expectedVersions: Record<string, number>;
  dataClassification: DataClassification;
};

function citation(input: Omit<Citation, "id" | "retrievedAt">): Citation {
  return { ...input, id: randomUUID(), retrievedAt: new Date().toISOString() };
}

function projectIdFromRefs(refs: string[]): string {
  const reference = refs.find((item) => item.startsWith("project:"));
  return reference?.slice("project:".length) || DEMO_PROJECT_ID;
}

export class ManagementContextProvider {
  constructor(private readonly management: ManagementLoopService, private readonly taskCommand?: TaskCommandService, private readonly memory?: AgentMemoryService) {}

  async build(context: RequestContext, refs: string[], input?: { conversationId?: string; message: string; runId: string }): Promise<AgentContextPackage> {
    const projectId = projectIdFromRefs(refs);
    const snapshot = await this.management.getSnapshot(context, projectId);
    const canRead = (type: string, id: string, projectReference?: string) => evaluateAccess({
      context, action: "read", resource: { tenantId: context.tenantId, type, id, projectId: projectReference },
    }).allowed;
    const readableRisks = canRead("risk", "collection", projectId) ? snapshot.risks : [];
    const readableActions = canRead("action_item", "collection", projectId) ? snapshot.actionItems : [];
    const readableTasks = canRead("task", "collection", projectId) ? snapshot.tasks : [];
    const highestRisk = [...readableRisks].sort((left, right) => right.probability * right.impact - left.probability * left.impact)[0];
    const citations: Citation[] = [];
    if (canRead("objective", snapshot.objective.id)) citations.push(citation({ objectType: "objective", objectId: snapshot.objective.id, objectVersion: snapshot.objective.version,
      label: `目标 · ${snapshot.objective.title}`, excerpt: `当前 ${snapshot.objective.currentValue ?? "未设置"}${snapshot.objective.unit ?? ""}，目标 ${snapshot.objective.targetValue ?? "未设置"}${snapshot.objective.unit ?? ""}。`, classification: "internal" }));
    citations.push(citation({ objectType: "project", objectId: snapshot.project.id, objectVersion: snapshot.project.version,
      label: `项目 · ${snapshot.project.name}`, excerpt: `健康度 ${snapshot.project.health}，承诺日期 ${snapshot.project.targetEndAt}，状态 ${snapshot.project.status}。`, classification: "internal" }));
    if (highestRisk) citations.push(citation({
      objectType: "risk", objectId: highestRisk.id, objectVersion: highestRisk.version, label: `风险 · ${highestRisk.title}`,
      excerpt: `${highestRisk.description} 暴露度 ${highestRisk.probability * highestRisk.impact}/25。`, classification: "internal",
    }));
    for (const item of readableActions.filter(({ status }) => status !== "completed").slice(0, 3)) {
      citations.push(citation({ objectType: "action_item", objectId: item.id, objectVersion: item.version,
        label: `行动 · ${item.title}`, excerpt: `状态 ${item.status}，截止 ${item.dueAt}，验收标准：${item.acceptanceCriteria}`, classification: "internal" }));
    }
    let taskSummary = "";
    if (this.taskCommand && (context.permissions.includes("*") || context.permissions.includes("work_task:read") || context.permissions.includes("work_task:*"))) {
      const taskContext = await this.taskCommand.agentContext(context);
      taskSummary = taskContext.summary;
      for (const item of taskContext.packages) {
        citations.push(citation({
          objectType: "work_package", objectId: item.id, objectVersion: item.version, label: `任务包 · ${item.title}`,
          excerpt: `状态 ${item.status}，截止 ${item.dueAt}，验收标准：${item.acceptanceCriteria}`, classification: "internal",
        }));
      }
      for (const item of taskContext.handoffs) {
        const handoffClassification = mostRestrictiveClassification(item.artifactSnapshots.map((snapshot) => snapshot.classification));
        citations.push(citation({
          objectType: "work_task_handoff", objectId: item.id, label: `任务交接 · ${item.snapshot.title}`,
          excerpt: `${item.fromAssigneeId} → ${item.toAssigneeId}，状态 ${item.status}，冻结交付物 ${item.artifactSnapshots.length} 项${item.artifactRefs.length ? `，旧式引用 ${item.artifactRefs.length} 项` : ""}。`, classification: handoffClassification,
        }));
      }
      for (const item of taskContext.poolMessages) {
        citations.push(citation({
          objectType: "message_pool_message", objectId: item.id, label: `消息池 · ${item.subject}`,
          excerpt: item.content.slice(0, 240), classification: "internal",
        }));
      }
      if (this.memory && input) {
        await Promise.all([
          ...taskContext.packages.map((item) => this.memory!.captureTask(context, {
            taskId: item.id, taskVersion: item.version, runId: input.runId,
            summary: `任务“${item.title}”处于 ${item.status}；截止 ${item.dueAt}；负责人 ${item.assigneeId ?? "待承接"}；验收：${item.acceptanceCriteria}`,
            sourceRefs: [`work_package:${item.id}`, ...item.evidenceRefs.map((ref) => `evidence:${ref}`)],
          })),
          ...taskContext.handoffs.map((item) => this.memory!.captureTaskHandoff(context, {
            taskId: item.packageId, handoffId: item.id, runId: input.runId,
            summary: `任务交接：${item.fromAssigneeId} → ${item.toAssigneeId}，状态 ${item.status}；说明：${item.note}；冻结版本 v${item.snapshot.packageVersion}；冻结交付物 ${item.artifactSnapshots.length} 项。`,
            sourceRefs: [`work_task_handoff:${item.id}`, ...item.artifactSnapshots.map((artifact) => `artifact_version:${artifact.artifactId}:${artifact.version}`)],
            classification: mostRestrictiveClassification(item.artifactSnapshots.map((artifact) => artifact.classification)),
          })),
        ]);
      }
    }
    const businessSummary = [
      "<untrusted_business_context>",
      `项目：${snapshot.project.name}；状态：${snapshot.project.status}；健康度：${snapshot.project.health}；承诺日期：${snapshot.project.targetEndAt}。`,
      canRead("objective", snapshot.objective.id) ? `目标：${snapshot.objective.title}；当前：${snapshot.objective.currentValue ?? "未知"}${snapshot.objective.unit ?? ""}；目标值：${snapshot.objective.targetValue ?? "未知"}${snapshot.objective.unit ?? ""}。` : "目标：当前身份无读取权限。",
      highestRisk ? `最高风险：${highestRisk.title}；暴露度：${highestRisk.probability * highestRisk.impact}/25；事实：${highestRisk.description}` : "当前没有登记风险。",
      `未完成行动：${readableActions.filter(({ status }) => status !== "completed").length}；未完成任务：${readableTasks.filter(({ status }) => !["completed", "cancelled"].includes(status)).length}。`,
      "</untrusted_business_context>",
      taskSummary,
    ].join("\n");
    const memory = this.memory ? await this.memory.context(context, {
      conversationId: input?.conversationId, projectId, query: input?.message ?? "",
      taskIds: citations.filter(({ objectType }) => objectType === "work_package").map(({ objectId }) => objectId),
      situationScopeIds: [projectId], limit: 12,
    }) : undefined;
    if (memory) citations.push(...memory.citations);
    const summary = [businessSummary, memory?.summary].filter(Boolean).join("\n");
    if (this.memory && input) {
      await Promise.all([
        this.memory.captureSituation(context, { projectId, runId: input.runId, summary: businessSummary, citations }),
        this.memory.captureContext(context, { conversationId: input.conversationId, projectId, runId: input.runId, summary: businessSummary, citations }),
      ]);
    }
    const expectedVersions = { [snapshot.project.id]: snapshot.project.version };
    for (const item of citations.filter(({ objectType }) => objectType === "work_package")) if (item.objectVersion) expectedVersions[item.objectId] = item.objectVersion;
    return { projectId, summary, citations, expectedVersions, dataClassification: mostRestrictiveClassification([
      ...citations.map(({ classification }) => classification),
      classifyUntrustedText(summary),
    ]) };
  }
}
