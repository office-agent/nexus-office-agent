import type { ToolRegistry } from "@/src/modules/agent/domain/tool";
import { createLongTermMemorySchema, recallMemorySchema } from "@/src/modules/agent-memory/application/schemas";
import type { AgentMemoryService } from "@/src/modules/agent-memory/application/service";

const rememberJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 2, maxLength: 2000, description: "仅保存用户明确要求长期记住、且已确认的稳定事实、偏好或约束。" },
    scopeType: { type: "string", enum: ["user", "project", "tenant"] }, scopeId: { type: "string", format: "uuid" },
    visibility: { type: "string", enum: ["private", "shared"] }, classification: { type: "string", enum: ["public", "internal", "confidential", "restricted"] },
    importance: { type: "integer", minimum: 0, maximum: 100 }, confidence: { type: "integer", minimum: 0, maximum: 100 },
    sourceRefs: { type: "array", items: { type: "string" }, maxItems: 40 }, expiresAt: { type: "string", format: "date-time" },
  }, required: ["summary"],
} as const;

const recallJsonSchema = {
  type: "object", additionalProperties: false,
  properties: { query: { type: "string", maxLength: 400 }, limit: { type: "integer", minimum: 1, maximum: 20 }, includeShared: { type: "boolean" } },
} as const;

export function registerAgentMemoryTools(registry: ToolRegistry, service: AgentMemoryService): void {
  registry.register({
    id: "memory.recall", skillId: "enterprise-memory", version: 1,
    description: "检索当前用户可读的长期记忆。只返回本人私有记忆，以及具有权限时的共享企业记忆；不会读取其他人的私有会话。",
    requiredPermissions: ["memory:read"], riskLevel: 0, confirmationPolicy: "never", sideEffect: "none", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"], inputJsonSchema: recallJsonSchema, inputSchema: recallMemorySchema,
    preview() { return "检索当前用户可读的长期记忆。"; },
    async execute(context, input) {
      const value = recallMemorySchema.parse(input);
      const entries = await service.recall(context, { ...value, forModel: true });
      return entries.map(({ id, tier, kind, scopeType, visibility, classification, summary, importance, confidence, expiresAt, updatedAt, version, sourceRefs }) => ({
        id, tier, kind, scopeType, visibility, classification, summary, importance, confidence, expiresAt, updatedAt, version, sourceRefs,
      }));
    },
  });
  registry.register({
    id: "memory.remember", skillId: "enterprise-memory", version: 1,
    description: "把用户明确确认的稳定事实、工作偏好或企业约束写入长期记忆。默认只对当前用户私有；共享到项目或企业必须有额外权限并经人工确认。",
    requiredPermissions: ["memory:write"], riskLevel: 2, confirmationPolicy: "always", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"], inputJsonSchema: rememberJsonSchema, inputSchema: createLongTermMemorySchema,
    preview(input) {
      const value = createLongTermMemorySchema.parse(input);
      const scope = value.visibility === "shared" ? "共享" : "仅自己可见";
      return `将长期记忆“${value.summary}”保存为${scope}。请确认该信息稳定、准确且适合留存。`;
    },
    execute(context, input) { return service.remember(context, createLongTermMemorySchema.parse(input)); },
  });
}
