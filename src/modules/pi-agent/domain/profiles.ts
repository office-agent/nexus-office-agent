import type { PiProfileId } from "./contracts";

export type PiProfile = {
  id: PiProfileId;
  version: number;
  description: string;
  allowedTools: string[];
  requiredPermissions: string[];
  maxRiskLevel: number;
  networkPolicy: "none" | "allowlist" | "restricted";
  canModifyWorkspace: boolean;
  canExecuteSandbox: boolean;
};

const READ_TOOLS = ["workspace_read", "workspace_list"];
const WRITE_TOOLS = ["workspace_write", "workspace_apply_patch"];

export const PI_PROFILES: Record<PiProfileId, PiProfile> = {
  coding: {
    id: "coding", version: 1, description: "在当前沙盒中阅读、修改和验证代码。",
    allowedTools: [...READ_TOOLS, ...WRITE_TOOLS, "workspace_run"],
    requiredPermissions: ["pi:session:create", "pi:workspace:read", "pi:workspace:write"],
    maxRiskLevel: 2, networkPolicy: "none", canModifyWorkspace: true, canExecuteSandbox: true,
  },
  review: {
    id: "review", version: 1, description: "只读代码审查和差异分析。",
    allowedTools: READ_TOOLS,
    requiredPermissions: ["pi:session:create", "pi:workspace:read"],
    maxRiskLevel: 1, networkPolicy: "none", canModifyWorkspace: false, canExecuteSandbox: false,
  },
  debug: {
    id: "debug", version: 1, description: "在临时分支和受控沙盒中分析失败。",
    allowedTools: [...READ_TOOLS, ...WRITE_TOOLS, "workspace_run"],
    requiredPermissions: ["pi:session:create", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute"],
    maxRiskLevel: 2, networkPolicy: "none", canModifyWorkspace: true, canExecuteSandbox: true,
  },
  refactor: {
    id: "refactor", version: 1, description: "执行项目范围内的受控重构和测试。",
    allowedTools: [...READ_TOOLS, ...WRITE_TOOLS, "workspace_run"],
    requiredPermissions: ["pi:session:create", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute"],
    maxRiskLevel: 2, networkPolicy: "none", canModifyWorkspace: true, canExecuteSandbox: true,
  },
  office: {
    id: "office", version: 1, description: "使用企业业务 Tool，不默认访问代码工作区。",
    allowedTools: [],
    requiredPermissions: ["pi:session:create"],
    maxRiskLevel: 2, networkPolicy: "restricted", canModifyWorkspace: false, canExecuteSandbox: false,
  },
  integration: {
    id: "integration", version: 1, description: "通过企业 MCP Bridge 访问已批准的连接器。",
    allowedTools: [],
    requiredPermissions: ["pi:session:create", "pi:mcp:use"],
    maxRiskLevel: 2, networkPolicy: "allowlist", canModifyWorkspace: false, canExecuteSandbox: false,
  },
  release: {
    id: "release", version: 1, description: "生成构建和发布提案，发布动作必须经审批。",
    allowedTools: [...READ_TOOLS, "workspace_run"],
    requiredPermissions: ["pi:session:create", "pi:sandbox:execute", "pi:release:propose"],
    maxRiskLevel: 3, networkPolicy: "allowlist", canModifyWorkspace: false, canExecuteSandbox: true,
  },
};

export function getPiProfile(profile: PiProfileId): PiProfile {
  return PI_PROFILES[profile];
}
