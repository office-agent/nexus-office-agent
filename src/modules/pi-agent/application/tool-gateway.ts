import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { getPiProfile } from "@/src/modules/pi-agent/domain/profiles";
import { assertMcpExecutionScope, type McpInvocation, type McpToolCatalogItem, type McpToolExecutionResult } from "@/src/modules/pi-agent/domain/mcp-contracts";
import { assertJsonSchema, McpBridge } from "@/src/modules/pi-agent/application/mcp-bridge";
import { McpRegistryService } from "@/src/modules/pi-agent/application/mcp-registry";

function riskRank(value: string): number { return Number(value.slice(1)); }

export class RiskClassifier {
  classify(riskLevel: string): number {
    if (!/^R[0-4]$/.test(riskLevel)) throw new Error("PI_MCP_TOOL_RISK_INVALID");
    return riskRank(riskLevel);
  }
}

export type ToolPolicyDecision = {
  allowed: true;
  policyVersion: number;
  toolName: string;
  schemaDigest: string;
  riskLevel: string;
  dataClassification: string;
};

export type ToolQuotaReservation = { reservationId: string };
export interface ToolQuotaPort {
  reserve(input: { context: RequestContext; toolName: string; riskLevel: string }): Promise<ToolQuotaReservation | null>;
  release?(reservation: ToolQuotaReservation): Promise<void>;
}

export class PolicyDecisionPoint {
  constructor(private readonly registry: McpRegistryService, private readonly risk = new RiskClassifier()) {}

  async resolveCapabilities(context: RequestContext, profile: string, bindingIds?: string[]): Promise<McpToolCatalogItem[]> {
    return this.registry.listTools(context, profile, bindingIds);
  }

  async authorizeCall(input: McpInvocation): Promise<ToolPolicyDecision> {
    assertPiPermission(input.context, "pi:mcp:use");
    const profile = getPiProfile(input.profile);
    const resolved = await this.registry.resolveBinding(input.context, { bindingId: input.bindingId, exposedName: input.exposedName, profile: input.profile });
    for (const permission of resolved.binding.requiredPermissions) assertPiPermission(input.context, permission);
    const risk = this.risk.classify(resolved.binding.riskLevel);
    if (risk > profile.maxRiskLevel) throw new Error("PI_MCP_RISK_NOT_ALLOWED");
    if (input.expectedSchemaDigest && input.expectedSchemaDigest !== resolved.binding.schemaDigest) throw new Error("PI_MCP_SCHEMA_VERSION_CONFLICT");
    return { allowed: true, policyVersion: 1, toolName: resolved.tool.name, schemaDigest: resolved.binding.schemaDigest, riskLevel: resolved.binding.riskLevel, dataClassification: resolved.binding.dataClassification };
  }

  classifyRisk(riskLevel: string): number { return this.risk.classify(riskLevel); }

  async validateArguments(input: McpInvocation): Promise<void> {
    const resolved = await this.registry.resolveBinding(input.context, { bindingId: input.bindingId, exposedName: input.exposedName, profile: input.profile });
    assertJsonSchema(input.arguments, resolved.binding.inputSchema);
  }

  async validateDataFlow(input: McpInvocation): Promise<void> {
    const resolved = await this.registry.resolveBinding(input.context, { bindingId: input.bindingId, exposedName: input.exposedName, profile: input.profile });
    if (resolved.binding.dataClassification === "restricted" && !input.context.permissions.includes("pi:data:restricted")) throw new Error("PI_MCP_DATA_CLASSIFICATION_DENIED");
    if (resolved.binding.dataClassification === "confidential" && !input.context.permissions.includes("pi:data:confidential") && !input.context.permissions.includes("pi:data:restricted")) throw new Error("PI_MCP_DATA_CLASSIFICATION_DENIED");
  }
}

export class ToolGateway {
  constructor(private readonly decisionPoint: PolicyDecisionPoint, private readonly bridge: McpBridge, private readonly quota?: ToolQuotaPort) {}

  async resolveCapabilities(context: RequestContext, profile: string, bindingIds?: string[]): Promise<McpToolCatalogItem[]> { return this.decisionPoint.resolveCapabilities(context, profile, bindingIds); }

  async authorizeCall(input: McpInvocation): Promise<ToolPolicyDecision> { return this.decisionPoint.authorizeCall(input); }

  async classifyRisk(riskLevel: string): Promise<number> { return this.decisionPoint.classifyRisk(riskLevel); }
  async validateArguments(input: McpInvocation): Promise<void> { return this.decisionPoint.validateArguments(input); }
  async validateDataFlow(input: McpInvocation): Promise<void> { return this.decisionPoint.validateDataFlow(input); }
  async reserveQuota(input: McpInvocation, decision: ToolPolicyDecision): Promise<ToolQuotaReservation> {
    if (this.quota) {
      const reservation = await this.quota.reserve({ context: input.context, toolName: decision.toolName, riskLevel: decision.riskLevel });
      if (!reservation) throw new Error("PI_MCP_QUOTA_EXCEEDED");
      return reservation;
    }
    if (process.env.NODE_ENV === "production") throw new Error("PI_MCP_QUOTA_UNAVAILABLE");
    return { reservationId: "local-unmetered" };
  }
  async validateResult(result: McpToolExecutionResult): Promise<McpToolExecutionResult> {
    if (result.content !== undefined && JSON.stringify(result.content).length > 20_000_000) throw new Error("PI_MCP_RESULT_INVALID");
    return result;
  }
  async recordDecision(_input: McpInvocation, decision: ToolPolicyDecision): Promise<ToolPolicyDecision> { return decision; }

  async execute(input: McpInvocation): Promise<McpToolExecutionResult> {
    assertMcpExecutionScope(input);
    const decision = await this.decisionPoint.authorizeCall(input);
    await this.decisionPoint.validateArguments(input);
    await this.decisionPoint.validateDataFlow(input);
    const reservation = await this.reserveQuota(input, decision);
    await this.recordDecision(input, decision);
    try {
      return await this.validateResult(await this.bridge.executeTool(input));
    } finally {
      await this.quota?.release?.(reservation).catch(() => undefined);
    }
  }
}
