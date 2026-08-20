import { z } from "zod";
import type { AcceptanceRepository } from "@/src/modules/integration/application/acceptance";
import type { RequestContext } from "@/src/platform/context/request-context";

export type WecomApplicationSnapshot = {
  agentId: string;
  name: string;
  description: string;
  squareLogoUrl?: string;
  visibleUserCount: number;
  visibleDepartmentIds: number[];
  visibleTagIds: number[];
  closed: boolean;
  redirectDomain?: string;
  homeUrl?: string;
  reportsLocation: boolean;
  reportsEnterEvent: boolean;
};

export const wecomApplicationPatchSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  description: z.string().trim().min(1).max(120).optional(),
  redirectDomain: z.string().trim().min(1).max(253).regex(/^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/).optional(),
  homeUrl: z.url().optional(),
  reportsLocation: z.boolean().optional(),
  reportsEnterEvent: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "WECOM_APP_PATCH_REQUIRED" });

export type WecomApplicationPatch = z.infer<typeof wecomApplicationPatchSchema>;

export interface WecomAppControlGateway {
  getApplication(connectionId: string): Promise<WecomApplicationSnapshot>;
  updateApplication(connectionId: string, patch: WecomApplicationPatch): Promise<WecomApplicationSnapshot>;
}

export type WecomPermissionBoundary = {
  capability: string;
  label: string;
  controlMode: "app_api" | "admin_console" | "contact_sync_credential" | "user_oauth" | "internal_policy";
  aiExecution: "read" | "confirm_required" | "disabled";
  boundary: string;
  officialDocument: string;
};

const PERMISSION_BOUNDARIES: WecomPermissionBoundary[] = [
  {
    capability: "application.profile",
    label: "应用名称、说明、首页、可信域名和上报开关",
    controlMode: "app_api",
    aiExecution: "confirm_required",
    boundary: "普通自建应用 Secret 只能读取和修改与该凭据绑定的应用；AI 不接触 Secret，变更必须人工确认。",
    officialDocument: "https://developer.work.weixin.qq.com/document/path/90228",
  },
  {
    capability: "application.visible_scope",
    label: "应用可见范围",
    controlMode: "admin_console",
    aiExecution: "disabled",
    boundary: "普通自建应用没有通用的可见范围修改 API；由企业微信系统管理员在管理后台调整。",
    officialDocument: "https://developer.work.weixin.qq.com/document/path/90665",
  },
  {
    capability: "directory.read",
    label: "通讯录读取",
    controlMode: "app_api",
    aiExecution: "read",
    boundary: "普通自建应用只能读取应用可见范围内的成员和部门，且部分敏感字段不会直接返回。",
    officialDocument: "https://developer.work.weixin.qq.com/document/path/90329",
  },
  {
    capability: "directory.write",
    label: "成员、部门和标签写入",
    controlMode: "contact_sync_credential",
    aiExecution: "disabled",
    boundary: "必须单独启用“通讯录同步 API”并使用独立同步 Secret；该凭据拥有高风险的全局通讯录写权限。",
    officialDocument: "https://developer.work.weixin.qq.com/document/path/91143",
  },
  {
    capability: "directory.sensitive_fields",
    label: "手机号、邮箱、头像等敏感字段",
    controlMode: "user_oauth",
    aiExecution: "disabled",
    boundary: "新建自建应用读取敏感字段时通常需要成员通过 OAuth 手工授权，不能由管理员或 AI 代替用户同意。",
    officialDocument: "https://developer.work.weixin.qq.com/document/path/90196",
  },
  {
    capability: "application.permission_catalog",
    label: "应用权限字符串清单",
    controlMode: "admin_console",
    aiExecution: "disabled",
    boundary: "get_permissions 接口面向企业授权的代开发或第三方应用，不用于普通自建应用。",
    officialDocument: "https://developer.work.weixin.qq.com/document/path/99052",
  },
  {
    capability: "nexus.roles",
    label: "管理系统内部角色与数据权限",
    controlMode: "internal_policy",
    aiExecution: "disabled",
    boundary: "企业微信管理员身份不自动等于本系统管理员；内部角色变更继续走独立审批、职责分离和审计。",
    officialDocument: "internal://authorization-policy",
  },
];

function hasPermission(context: RequestContext, required: string): boolean {
  const [resource, action] = required.split(":");
  return context.permissions.some((permission) => permission === "*" || permission === required || permission === `${resource}:*` || permission === `*:${action}`);
}

function requirePermission(context: RequestContext, required: string): void {
  if (!hasPermission(context, required)) throw new Error(`POLICY_DENIED:${required}`);
}

function safeCode(error: unknown): string {
  if (!(error instanceof Error)) return "WECOM_CONTROL_FAILED";
  return error.message.split(":")[0] || "WECOM_CONTROL_FAILED";
}

function trustedHosts(): Set<string> {
  const hosts = new Set(
    (process.env.WECOM_ALLOWED_REDIRECT_DOMAINS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const origin = process.env.PUBLIC_APP_ORIGIN;
  if (origin) {
    try { hosts.add(new URL(origin).hostname.toLowerCase()); } catch { throw new Error("PUBLIC_APP_ORIGIN_INVALID"); }
  }
  return hosts;
}

function assertTrustedDestinations(patch: WecomApplicationPatch): void {
  if (!patch.redirectDomain && !patch.homeUrl) return;
  const hosts = trustedHosts();
  if (hosts.size === 0) throw new Error("WECOM_TRUSTED_ORIGIN_UNCONFIGURED");
  if (patch.redirectDomain && !hosts.has(patch.redirectDomain.toLowerCase())) throw new Error("WECOM_REDIRECT_DOMAIN_NOT_ALLOWED");
  if (patch.homeUrl) {
    const url = new URL(patch.homeUrl);
    if (url.protocol !== "https:" || !hosts.has(url.hostname.toLowerCase())) throw new Error("WECOM_HOME_URL_NOT_ALLOWED");
  }
}

export class WecomAccessControlService {
  constructor(
    private readonly connections: AcceptanceRepository,
    private readonly gateway: WecomAppControlGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async inspect(context: RequestContext, connectionId: string) {
    requirePermission(context, "wecom_app:read");
    const connection = await this.connections.getConnection(context.tenantId, "wecom", connectionId);
    if (!connection) throw new Error("INTEGRATION_CONNECTION_NOT_FOUND");

    let liveApplication: WecomApplicationSnapshot | undefined;
    let liveCheck: { status: "not_ready" | "passed" | "blocked" | "failed"; code?: string };
    if (!['active', 'degraded'].includes(connection.status)) {
      liveCheck = { status: "not_ready", code: `WECOM_CONNECTION_${connection.status.toUpperCase()}` };
    } else {
      try {
        liveApplication = await this.gateway.getApplication(connectionId);
        liveCheck = { status: "passed" };
      } catch (error) {
        const code = safeCode(error);
        liveCheck = {
          status: /UNCONFIGURED|REQUIRED/.test(code) ? "blocked" : "failed",
          code,
        };
      }
    }

    return {
      connection: { id: connection.id, name: connection.name, status: connection.status },
      liveCheck,
      liveApplication,
      boundaries: PERMISSION_BOUNDARIES.map((item) => ({ ...item })),
      secretExposed: false,
      generatedAt: this.now().toISOString(),
    };
  }

  async updateApplication(context: RequestContext, connectionId: string, input: WecomApplicationPatch) {
    requirePermission(context, "wecom_app:admin");
    const patch = wecomApplicationPatchSchema.parse(input);
    assertTrustedDestinations(patch);
    const connection = await this.connections.getConnection(context.tenantId, "wecom", connectionId);
    if (!connection) throw new Error("INTEGRATION_CONNECTION_NOT_FOUND");
    if (connection.status !== "active") throw new Error("WECOM_CONNECTION_NOT_ACTIVE");
    const application = await this.gateway.updateApplication(connectionId, patch);
    return {
      connectionId,
      appliedFields: Object.keys(patch),
      application,
      secretExposed: false,
      verifiedAt: this.now().toISOString(),
    };
  }
}

export function wecomPermissionBoundaries(): WecomPermissionBoundary[] {
  return PERMISSION_BOUNDARIES.map((item) => ({ ...item }));
}
