import { z } from "zod";
import { appendPoolFeedbackSchema, createTaskTemplateSchema, initiateTaskHandoffSchema, publishMissionSchema, publishPoolMessageSchema, respondToTaskHandoffSchema, taskHandoffTrailSchema, transitionPackageSchema, updateTaskTemplateSchema } from "@/src/modules/task-command/application/schemas";
import type { TaskCommandService } from "@/src/modules/task-command/application/service";
import { ToolRegistry } from "@/src/modules/agent/domain/tool";

const claimSchema = z.object({ taskId: z.uuid(), expectedVersion: z.number().int().positive() }).strict();
const updateSchema = transitionPackageSchema.extend({ taskId: z.uuid() }).strict();
const respondHandoffSchema = respondToTaskHandoffSchema.extend({ handoffId: z.uuid() }).strict();

const createTemplateJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    conversationId: { type: "string", format: "uuid" }, title: { type: "string" }, objective: { type: "string" }, description: { type: "string" }, acceptanceCriteria: { type: "string" },
    requiredSkills: { type: "array", items: { type: "string" } }, assignmentMode: { type: "string", enum: ["direct", "open_claim"] }, assigneeId: { type: "string", format: "uuid" }, targetOrgUnitId: { type: "string", format: "uuid" },
    priority: { type: "string", enum: ["critical", "high", "medium", "low"] }, dueAt: { type: "string", format: "date-time" }, capacityPoints: { type: "integer", minimum: 1, maximum: 40 },
  }, required: ["conversationId", "title"],
} as const;

const updateTemplateJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    taskId: { type: "string", format: "uuid" }, expectedVersion: { type: "integer", minimum: 1 }, title: { type: "string" }, objective: { type: "string" }, description: { type: "string" }, acceptanceCriteria: { type: "string" },
    requiredSkills: { type: "array", items: { type: "string" } }, assignmentMode: { type: "string", enum: ["direct", "open_claim"] }, assigneeId: { type: ["string", "null"], format: "uuid" }, targetOrgUnitId: { type: ["string", "null"], format: "uuid" },
    priority: { type: "string", enum: ["critical", "high", "medium", "low"] }, dueAt: { type: "string", format: "date-time" }, capacityPoints: { type: "integer", minimum: 1, maximum: 40 },
  }, required: ["taskId", "expectedVersion"],
} as const;

const publishJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    conversationId: { type: "string", format: "uuid" }, projectId: { type: "string", format: "uuid" }, title: { type: "string" }, objective: { type: "string" },
    priority: { type: "string", enum: ["critical", "high", "medium", "low"] }, dueAt: { type: "string", format: "date-time" },
    packages: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false, properties: {
      title: { type: "string" }, description: { type: "string" }, acceptanceCriteria: { type: "string" }, requiredSkills: { type: "array", items: { type: "string" } },
      assignmentMode: { type: "string", enum: ["direct", "open_claim"] }, assigneeId: { type: "string", format: "uuid" }, targetOrgUnitId: { type: "string", format: "uuid" }, priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
      dueAt: { type: "string", format: "date-time" }, capacityPoints: { type: "integer", minimum: 1, maximum: 40 },
    }, required: ["title", "description", "acceptanceCriteria", "requiredSkills", "assignmentMode", "priority", "dueAt", "capacityPoints"] } },
  }, required: ["conversationId", "title", "objective", "priority", "dueAt", "packages"],
} as const;

export function registerTaskCommandTools(registry: ToolRegistry, service: TaskCommandService) {
  registry.register({
    id: "work.create_task_template", skillId: "work-orchestration", version: 1,
    description: "根据用户已经提供的最少信息创建一个局部任务模板；未提供的目标、说明、负责人或承接范围、截止时间、验收标准、优先级、容量点和技能会标记为待补充，不会分派给个人或部门，也不会进入可承接任务池。该 Tool 不替代正式发布门禁。",
    requiredPermissions: ["work_task:create"], riskLevel: 1, confirmationPolicy: "never", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"], inputJsonSchema: createTemplateJsonSchema, inputSchema: createTaskTemplateSchema,
    preview(input) { const value = createTaskTemplateSchema.parse(input); return `将创建任务模板“${value.title}”，缺失字段会在模板中标记，暂不对外分派。`; },
    execute(context, input, execution) { return service.createTaskTemplate(context, createTaskTemplateSchema.parse(input), { source: "agent", sourceRunId: execution?.agentRunId }); },
  });
  registry.register({
    id: "work.update_task_template", skillId: "work-orchestration", version: 1,
    description: "补充或修改当前用户拥有的任务模板。只允许更新模板内容和分派草稿，不会把模板自动正式发送给个人或部门；每次更新都使用任务版本号，缺失字段会重新计算。",
    requiredPermissions: ["work_task:update"], riskLevel: 1, confirmationPolicy: "never", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"], inputJsonSchema: updateTemplateJsonSchema, inputSchema: updateTaskTemplateSchema,
    preview(input) { const value = updateTaskTemplateSchema.parse(input); return `将补充任务模板 ${value.taskId} 的内容，版本号为 ${value.expectedVersion}。`; },
    execute(context, input) { return service.updateTaskTemplate(context, updateTaskTemplateSchema.parse(input)); },
  });
  registry.register({
    id: "work.publish_task_bundle", skillId: "work-orchestration", version: 1,
    description: "正式发布一个工作使命并一次性创建多个可验收任务包；每包必须定向至已知成员，或定向至一个部门供该部门成员承接，二者不可同时填写：direct 只填 assigneeId，open_claim 只填 targetOrgUnitId。调用本 Tool 只生成待人工确认的提案，不会直接创建任务；用户明确要求正式发布且参数齐全时必须调用，不要改为纯文字预览。",
    requiredPermissions: ["work_task:create"], riskLevel: 2, confirmationPolicy: "always", sideEffect: "internal_idempotent", timeoutMs: 15_000, maxAttempts: 3,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"], inputJsonSchema: publishJsonSchema, inputSchema: publishMissionSchema,
    preview(input) { const value = publishMissionSchema.parse(input); return `将发布使命“${value.title}”，包含 ${value.packages.length} 个任务包。`; },
    execute(context, input, execution) { return service.publishMission(context, publishMissionSchema.parse(input), { source: "agent", sourceRunId: execution?.agentRunId }); },
  });
  registry.register({
    id: "work.claim_task_package", skillId: "work-orchestration", version: 1,
    description: "由当前用户主动承接一个仍然开放且版本未变化的任务包。",
    requiredPermissions: ["work_task:claim"], riskLevel: 1, confirmationPolicy: "never", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", format: "uuid" }, expectedVersion: { type: "integer", minimum: 1 } }, required: ["taskId", "expectedVersion"] },
    inputSchema: claimSchema,
    preview(input) { const value = claimSchema.parse(input); return `当前用户将承接任务包 ${value.taskId}。`; },
    execute(context, input) { const value = claimSchema.parse(input); return service.claimPackage(context, value.taskId, value.expectedVersion); },
  });
  registry.register({
    id: "work.update_my_task", skillId: "work-orchestration", version: 1,
    description: "推进当前用户负责或发布的任务包状态；完成时必须给出可核验的证据引用，阻塞时必须说明原因。",
    requiredPermissions: ["work_task:update"], riskLevel: 2, confirmationPolicy: "risk_based", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 3,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {
      taskId: { type: "string", format: "uuid" }, expectedVersion: { type: "integer", minimum: 1 },
      nextStatus: { type: "string", enum: ["in_progress", "blocked", "in_review", "completed", "cancelled"] },
      evidenceRefs: { type: "array", items: { type: "string" } }, blockedReason: { type: "string" },
    }, required: ["taskId", "expectedVersion", "nextStatus"] },
    inputSchema: updateSchema,
    preview(input) { const value = updateSchema.parse(input); return `将任务包 ${value.taskId} 推进为 ${value.nextStatus}。`; },
    execute(context, input) { const value = updateSchema.parse(input); const { taskId, ...transition } = value; return service.transitionPackage(context, taskId, transition); },
  });
  registry.register({
    id: "work.initiate_task_handoff", skillId: "work-orchestration", version: 1,
    description: "发起一项正式任务的交接。系统会冻结当前任务版本、任务说明、验收标准、已有证据和版本化交付物快照；原负责人会保持责任，直到目标接收人签收。交付物必须使用当前上下文中已登记的 artifactId，不能填写任意文件路径或 URL。",
    requiredPermissions: ["work_task:handoff"], riskLevel: 2, confirmationPolicy: "always", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 3,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {
      taskId: { type: "string", format: "uuid" }, expectedVersion: { type: "integer", minimum: 1 }, toAssigneeId: { type: "string", format: "uuid" }, note: { type: "string" }, artifactIds: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 40 },
    }, required: ["taskId", "expectedVersion", "toAssigneeId", "note", "artifactIds"] },
    inputSchema: initiateTaskHandoffSchema,
    preview(input) { const value = initiateTaskHandoffSchema.parse(input); return `发起任务 ${value.taskId} 的交接，冻结当前版本并交由 ${value.toAssigneeId} 签收。`; },
    execute(context, input, execution) { return service.initiateTaskHandoff(context, initiateTaskHandoffSchema.parse(input), { source: "agent", sourceRunId: execution?.agentRunId }); },
  });
  registry.register({
    id: "work.respond_to_task_handoff", skillId: "work-orchestration", version: 1,
    description: "由当前登录的目标接收人签收或退回一条待处理的任务交接。签收会在同一事务中将负责人切换到当前用户并保留完整交接链；退回不改变负责人且必须记录原因。",
    requiredPermissions: ["work_task:accept_handoff"], riskLevel: 2, confirmationPolicy: "always", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 3,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {
      handoffId: { type: "string", format: "uuid" }, expectedVersion: { type: "integer", minimum: 1 }, decision: { type: "string", enum: ["accept", "reject"] }, responseNote: { type: "string" },
    }, required: ["handoffId", "expectedVersion", "decision"] },
    inputSchema: respondHandoffSchema,
    preview(input) { const value = respondHandoffSchema.parse(input); return `${value.decision === "accept" ? "签收" : "退回"}任务交接 ${value.handoffId}。`; },
    execute(context, input, execution) { const value = respondHandoffSchema.parse(input); const { handoffId, ...response } = value; return service.respondToTaskHandoff(context, handoffId, response, { source: "agent", sourceRunId: execution?.agentRunId }); },
  });
  registry.register({
    id: "work.get_task_handoff_trail", skillId: "work-orchestration", version: 1,
    description: "查询当前用户有权读取的任务交接链，返回每一棒的交接说明、冻结任务快照、文件/资料引用、签收或退回结果。回答交接进度、责任归属或文件连续性前应优先使用本工具核验。",
    requiredPermissions: ["work_task:read"], riskLevel: 0, confirmationPolicy: "never", sideEffect: "none", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", format: "uuid" } }, required: ["taskId"] },
    inputSchema: taskHandoffTrailSchema,
    preview(input) { const value = taskHandoffTrailSchema.parse(input); return `查询任务 ${value.taskId} 的完整交接链。`; },
    execute(context, input) { return service.taskHandoffTrail(context, taskHandoffTrailSchema.parse(input).taskId); },
  });
  registry.register({
    id: "communication.publish_message", skillId: "company-communication", version: 1,
    description: "将沟通、同步、征询或反馈整理后放入当前用户可见的公司或部门消息池。它不是任务：不产生负责人、截止时间、验收、任务状态或确认门禁。",
    requiredPermissions: ["message_pool:publish"], riskLevel: 1, confirmationPolicy: "never", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {
      poolKey: { type: "string", description: "只能使用上下文中可见消息池的 key；company 为全公司，部门使用对应的 orgUnit UUID。" }, subject: { type: "string" }, content: { type: "string" },
    }, required: ["poolKey", "subject", "content"] },
    inputSchema: publishPoolMessageSchema,
    preview(input) { const value = publishPoolMessageSchema.parse(input); return `将沟通“${value.subject}”发送至消息池 ${value.poolKey}。`; },
    execute(context, input, execution) { return service.publishPoolMessage(context, publishPoolMessageSchema.parse(input), { source: "agent", sourceRunId: execution?.agentRunId }); },
  });
  registry.register({
    id: "communication.add_feedback", skillId: "company-communication", version: 1,
    description: "为当前用户可见的消息池内容补充沟通反馈。不会改变任务、项目、审批或其他业务对象。",
    requiredPermissions: ["message_pool:publish"], riskLevel: 1, confirmationPolicy: "never", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: { messageId: { type: "string", format: "uuid" }, content: { type: "string" } }, required: ["messageId", "content"] },
    inputSchema: appendPoolFeedbackSchema,
    preview(input) { const value = appendPoolFeedbackSchema.parse(input); return `为消息 ${value.messageId} 补充反馈。`; },
    execute(context, input) { return service.appendPoolFeedback(context, appendPoolFeedbackSchema.parse(input)); },
  });
}
