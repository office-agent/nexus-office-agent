import { z } from "zod";
import type { ToolRegistry } from "@/src/modules/agent/domain/tool";
import {
  type WecomApplicationPatch,
  WecomAccessControlService,
  wecomApplicationPatchSchema,
} from "@/src/modules/integration/application/wecom-access-control";
import {
  WecomApplicationMessageService,
  wecomApplicationMessageSchema,
} from "@/src/modules/integration/application/wecom-application-message";

const connectionIdSchema = z.object({ connectionId: z.uuid() }).strict();
const updateSchema = z.object({
  connectionId: z.uuid(),
  name: z.string().trim().min(1).max(32).optional(),
  description: z.string().trim().min(1).max(120).optional(),
  redirectDomain: z.string().trim().min(1).max(253).optional(),
  homeUrl: z.url().optional(),
  reportsLocation: z.boolean().optional(),
  reportsEnterEvent: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "connectionId"), { message: "WECOM_APP_PATCH_REQUIRED" });

const updateJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connectionId: { type: "string", format: "uuid", description: "当前租户已经登记的企业微信连接 ID，不是 AgentId。" },
    name: { type: "string", minLength: 1, maxLength: 32 },
    description: { type: "string", minLength: 1, maxLength: 120 },
    redirectDomain: { type: "string", description: "仅填写域名，不含协议和路径；必须在服务端可信域名白名单内。" },
    homeUrl: { type: "string", format: "uri", description: "必须是服务端可信域名上的 HTTPS 地址。" },
    reportsLocation: { type: "boolean", description: "是否允许应用上报用户地理位置，属于敏感变更。" },
    reportsEnterEvent: { type: "boolean", description: "是否接收用户进入应用事件。" },
  },
  required: ["connectionId"],
} satisfies Record<string, unknown>;

function patchFromInput(value: z.infer<typeof updateSchema>): WecomApplicationPatch {
  return wecomApplicationPatchSchema.parse(
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== "connectionId")),
  );
}

export function registerWecomAccessControlTools(registry: ToolRegistry, service: WecomAccessControlService): void {
  registry.register({
    id: "wecom.inspect_access_control",
    skillId: "wecom-access-control",
    version: 1,
    description: "读取当前企业微信连接、本应用配置和权限边界；不会返回 CorpSecret、应用 Secret 或 access_token。",
    requiredPermissions: ["wecom_app:read"],
    riskLevel: 1,
    confirmationPolicy: "never",
    sideEffect: "none",
    timeoutMs: 15_000,
    maxAttempts: 1,
    allowedChannels: ["web", "wecom"],
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: { connectionId: { type: "string", format: "uuid" } },
      required: ["connectionId"],
    },
    inputSchema: connectionIdSchema,
    preview() { return "读取企业微信应用配置与权限边界，不执行任何变更。"; },
    execute(context, input) {
      const value = connectionIdSchema.parse(input);
      return service.inspect(context, value.connectionId);
    },
  });

  registry.register({
    id: "wecom.update_application",
    skillId: "wecom-access-control",
    version: 1,
    description: "修改与服务端凭据绑定的企业微信自建应用资料；仅网页管理员可发起，执行前必须人工确认。不能修改应用可见范围、通讯录或本系统角色。",
    requiredPermissions: ["wecom_app:admin"],
    riskLevel: 3,
    confirmationPolicy: "always",
    sideEffect: "external_idempotent",
    timeoutMs: 20_000,
    maxAttempts: 1,
    allowedChannels: ["web"],
    inputJsonSchema: updateJsonSchema,
    inputSchema: updateSchema,
    preview(input) {
      const value = updateSchema.parse(input);
      const fields = Object.keys(value).filter((key) => key !== "connectionId");
      const locationWarning = value.reportsLocation === true ? "；将启用地理位置上报，请重点核对隐私影响" : "";
      return `将修改企业微信连接 ${value.connectionId} 的应用配置：${fields.join("、")}${locationWarning}。不会修改可见范围、通讯录或内部角色。`;
    },
    execute(context, input) {
      const value = updateSchema.parse(input);
      return service.updateApplication(context, value.connectionId, patchFromInput(value));
    },
  });
}

const sendMessageSchema = wecomApplicationMessageSchema.extend({ connectionId: z.uuid() }).strict();

export function registerWecomApplicationMessageTools(registry: ToolRegistry, service: WecomApplicationMessageService): void {
  registry.register({
    id: "wecom.send_application_message",
    skillId: "wecom-application-messaging",
    version: 1,
    description: "通过当前租户已绑定的企业微信自建应用，按成员姓名精确解析并发送单人消息。成员 UserID、应用 Secret 和 access_token 始终只在服务端使用。",
    requiredPermissions: ["wecom_message:send"],
    riskLevel: 3,
    confirmationPolicy: "always",
    sideEffect: "external_idempotent",
    timeoutMs: 20_000,
    maxAttempts: 1,
    allowedChannels: ["web"],
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        connectionId: { type: "string", format: "uuid", description: "当前租户已登记的企业微信连接 ID，不是 AgentId。" },
        recipientName: { type: "string", minLength: 1, maxLength: 64, description: "企业微信通讯录中的完整成员姓名；零匹配或重名时拒绝发送。" },
        text: { type: "string", minLength: 1, maxLength: 1000, description: "待发送的纯文本内容。" },
      },
      required: ["connectionId", "recipientName", "text"],
    },
    inputSchema: sendMessageSchema,
    preview(input) {
      const value = sendMessageSchema.parse(input);
      return `将通过企业微信自建应用向成员“${value.recipientName}”发送消息：${value.text}`;
    },
    execute(context, input, execution) {
      if (!execution) throw new Error("TOOL_EXECUTION_CONTEXT_REQUIRED");
      const value = sendMessageSchema.parse(input);
      return service.send(context, value.connectionId, { recipientName: value.recipientName, text: value.text }, execution.idempotencyKey);
    },
  });
}
