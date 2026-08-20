import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiProfileId } from "@/src/modules/pi-agent/domain/contracts";
import type { ToolGateway } from "@/src/modules/pi-agent/application/tool-gateway";

function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} }; }

export async function createPiMcpTools(input: { context: RequestContext; profile: PiProfileId; gateway: ToolGateway; bindingIds: string[]; sessionId: string; runId: string }) {
  if (!input.bindingIds.length) return [];
  const catalog = await input.gateway.resolveCapabilities(input.context, input.profile, input.bindingIds);
  return catalog.map((item) => defineTool({
    name: item.exposedName,
    label: item.exposedName,
    promptSnippet: `Call the approved MCP tool ${item.exposedName} through the enterprise Tool Gateway.`,
    description: `Enterprise-approved MCP tool ${item.exposedName}. The server validates the frozen schema, permissions, data classification and network policy again before execution.`,
    parameters: Type.Unsafe<Record<string, unknown>>({ type: "object", additionalProperties: true }),
    async execute(_toolCallId, params) {
      const result = await input.gateway.execute({ context: input.context, profile: input.profile, exposedName: item.exposedName, expectedSchemaDigest: item.schemaDigest, arguments: params, sessionId: input.sessionId, runId: input.runId });
      return text(result);
    },
  }));
}
