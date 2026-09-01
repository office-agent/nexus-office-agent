import type { AgentRiskLevel } from "@/src/modules/agent/domain/agent-run";
import type { RequestContext } from "@/src/platform/context/request-context";

export type AgentTool = {
  id: string;
  skillId: string;
  version: number;
  description: string;
  requiredPermissions: string[];
  riskLevel: AgentRiskLevel;
  confirmationPolicy: "never" | "risk_based" | "always" | "disabled";
  sideEffect: "none" | "internal_idempotent" | "external_idempotent" | "external_non_idempotent";
  timeoutMs: number;
  maxAttempts: number;
  allowedChannels: RequestContext["channel"][];
  inputJsonSchema: Record<string, unknown>;
  inputSchema: { parse(input: unknown): unknown };
  preview(input: unknown): string;
  execute(context: RequestContext, input: unknown, execution?: { signal: AbortSignal; idempotencyKey: string; agentRunId: string; conversationId?: string }): Promise<unknown>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.tools.has(tool.id)) throw new Error(`TOOL_ALREADY_REGISTERED:${tool.id}`);
    const modelName = modelToolName(tool.id);
    for (const existing of this.tools.values()) {
      if (modelToolName(existing.id) === modelName) throw new Error(`TOOL_MODEL_NAME_COLLISION:${tool.id}`);
    }
    this.tools.set(tool.id, tool);
  }

  get(id: string): AgentTool {
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`TOOL_NOT_FOUND:${id}`);
    return tool;
  }

  getByModelName(name: string): AgentTool {
    const tool = [...this.tools.values()].find((item) => modelToolName(item.id) === name);
    if (!tool) throw new Error(`TOOL_NOT_FOUND:${name}`);
    return tool;
  }

  list(): Array<Omit<AgentTool, "inputSchema" | "preview" | "execute">> {
    return [...this.tools.values()].map((tool) => ({
      id: tool.id,
      skillId: tool.skillId,
      version: tool.version,
      description: tool.description,
      requiredPermissions: [...tool.requiredPermissions],
      riskLevel: tool.riskLevel,
      confirmationPolicy: tool.confirmationPolicy,
      sideEffect: tool.sideEffect,
      timeoutMs: tool.timeoutMs,
      maxAttempts: tool.maxAttempts,
      allowedChannels: [...tool.allowedChannels],
      inputJsonSchema: structuredClone(tool.inputJsonSchema),
    }));
  }

  available(context: RequestContext): AgentTool[] {
    return [...this.tools.values()].filter((tool) => toolAvailable(context, tool));
  }
}

export function modelToolName(id: string): string { return id.replace(/[^a-zA-Z0-9_-]/g, "__"); }

function permissionMatches(granted: string[], required: string): boolean {
  const [resource, action] = required.split(":");
  return granted.some((permission) => permission === "*" || permission === required || permission === `${resource}:*` || permission === `*:${action}`);
}

export function assertToolPolicy(context: RequestContext, tool: AgentTool): { requiresConfirmation: boolean } {
  if (!tool.allowedChannels.includes(context.channel)) throw new Error("TOOL_CHANNEL_DENIED");
  if (tool.confirmationPolicy === "disabled" || tool.riskLevel === 4) throw new Error("TOOL_DISABLED_BY_POLICY");
  if (!tool.requiredPermissions.every((permission) => permissionMatches(context.permissions, permission))) {
    throw new Error("TOOL_PERMISSION_DENIED");
  }
  return { requiresConfirmation: tool.confirmationPolicy === "always" || tool.riskLevel >= 3 };
}

export function toolAvailable(context: RequestContext, tool: AgentTool): boolean {
  if (!tool.allowedChannels.includes(context.channel) || tool.confirmationPolicy === "disabled" || tool.riskLevel === 4) return false;
  return tool.requiredPermissions.every((permission) => permissionMatches(context.permissions, permission));
}
