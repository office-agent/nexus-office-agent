import { z } from "zod";
import { identifyRiskSchema } from "@/src/modules/management-loop/application/schemas";
import type { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { ToolRegistry } from "@/src/modules/agent/domain/tool";

const identifyRiskToolSchema = identifyRiskSchema.extend({ riskId: z.uuid(), eventId: z.uuid() }).strict();

export function registerManagementTools(registry: ToolRegistry, management: ManagementLoopService): void {
  registry.register({
    id: "management.create_risk",
    skillId: "management-risk",
    version: 1,
    description: "在授权项目中登记一项风险。",
    requiredPermissions: ["risk:create"],
    riskLevel: 3,
    confirmationPolicy: "always",
    sideEffect: "internal_idempotent",
    timeoutMs: 15_000,
    maxAttempts: 3,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: {
      type: "object", additionalProperties: false,
      properties: {
        projectId: { type: "string", format: "uuid" }, title: { type: "string" }, description: { type: "string" }, ownerId: { type: "string", format: "uuid" },
        probability: { type: "integer", minimum: 1, maximum: 5 }, impact: { type: "integer", minimum: 1, maximum: 5 },
        sourceType: { type: "string", enum: ["human", "agent", "event", "import"] }, sourceRef: { type: "string" }, riskId: { type: "string", format: "uuid" }, eventId: { type: "string", format: "uuid" },
      },
      required: ["projectId", "title", "description", "ownerId", "probability", "impact", "sourceType", "riskId", "eventId"],
    },
    inputSchema: identifyRiskToolSchema,
    preview(input) {
      const value = identifyRiskToolSchema.parse(input);
      return `将在项目中登记风险“${value.title}”，概率 ${value.probability}/5、影响 ${value.impact}/5；将影响项目风险视图和后续管理提醒。`;
    },
    execute(context, input) { return management.identifyRisk(context, identifyRiskToolSchema.parse(input)); },
  });

  registry.register({
    id: "admin.assign_role",
    skillId: "identity-administration",
    version: 1,
    description: "变更企业角色；首期禁用 Agent 执行。",
    requiredPermissions: ["role:admin"],
    riskLevel: 4,
    confirmationPolicy: "disabled",
    sideEffect: "external_non_idempotent",
    timeoutMs: 10_000,
    maxAttempts: 1,
    allowedChannels: ["web"],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: { userId: { type: "string", format: "uuid" }, roleId: { type: "string", format: "uuid" } }, required: ["userId", "roleId"] },
    inputSchema: z.object({ userId: z.uuid(), roleId: z.uuid() }),
    preview() { return "将变更企业权限角色。"; },
    async execute() { throw new Error("TOOL_DISABLED_BY_POLICY"); },
  });
}
