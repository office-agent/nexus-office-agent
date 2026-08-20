import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { assertPiPermission } from "@/src/modules/pi-agent/application/policy";
import { stableJson, sha256 } from "@/src/modules/pi-agent/application/manifest";
import type {
  McpAuditStore,
  McpCallResult,
  McpCredential,
  McpCredentialBroker,
  McpEgressClient,
  McpInvocation,
  McpServerRecord,
  McpToolExecutionResult,
  McpToolDefinition,
  McpTransport,
} from "@/src/modules/pi-agent/domain/mcp-contracts";
import { assertMcpExecutionScope } from "@/src/modules/pi-agent/domain/mcp-contracts";
import { McpRegistryService, validateMcpEndpoint } from "@/src/modules/pi-agent/application/mcp-registry";

export function assertJsonSchema(value: unknown, schema: Record<string, unknown>, path = "$", depth = 0): void {
  if (depth > 8) throw new Error("PI_MCP_SCHEMA_TOO_DEEP");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("PI_MCP_SCHEMA_INVALID");
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => stableJson(item) === stableJson(value))) throw new Error("PI_MCP_ARGUMENTS_INVALID");
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!(key in record)) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties as Record<string, unknown> : {};
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!(key in properties)) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    if (typeof schema.maxProperties === "number" && Object.keys(record).length > schema.maxProperties) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    for (const [key, child] of Object.entries(properties)) if (key in record) assertJsonSchema(record[key], child as Record<string, unknown>, `${path}.${key}`, depth + 1);
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) for (const [index, item] of value.entries()) assertJsonSchema(item, schema.items as Record<string, unknown>, `${path}[${index}]`, depth + 1);
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") throw new Error("PI_MCP_ARGUMENTS_INVALID");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    if (typeof schema.pattern === "string") {
      try { if (!new RegExp(schema.pattern).test(value)) throw new Error("PI_MCP_ARGUMENTS_INVALID"); } catch (error) { if (error instanceof Error && error.message === "PI_MCP_ARGUMENTS_INVALID") throw error; throw new Error("PI_MCP_SCHEMA_INVALID"); }
    }
    return;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error("PI_MCP_ARGUMENTS_INVALID");
    return;
  }
  if (type === "boolean" && typeof value !== "boolean") throw new Error("PI_MCP_ARGUMENTS_INVALID");
  if (type === "null" && value !== null) throw new Error("PI_MCP_ARGUMENTS_INVALID");
}

function scrub(value: unknown, secretValues: string[], maxBytes: number): unknown {
  const secretSet = secretValues.filter(Boolean).sort((left, right) => right.length - left.length);
  const scrubText = (text: string): string => {
    let result = text;
    for (const secret of secretSet) result = result.split(secret).join("[REDACTED]");
    return result;
  };
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 8) return "[TRUNCATED_DEPTH]";
    if (typeof item === "string") return scrubText(item.slice(0, 100_000));
    if (Array.isArray(item)) return item.slice(0, 512).map((child) => walk(child, depth + 1));
    if (item && typeof item === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (/^(?:authorization|cookie|password|secret|token|access_token|refresh_token|client_secret)$/i.test(key)) output[key] = "[REDACTED]";
        else output[key] = walk(child, depth + 1);
      }
      return output;
    }
    return item;
  };
  const sanitized = walk(value, 0);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= maxBytes) return sanitized;
  return { truncated: true, digest: sha256(serialized), bytes: serialized.length };
}

function errorCode(error: unknown): string { return error instanceof Error ? error.message.split(":")[0] || "PI_MCP_UPSTREAM_ERROR" : "PI_MCP_UPSTREAM_ERROR"; }
function classificationAllowed(context: RequestContext, classification: string): void {
  if (classification === "restricted" && !context.permissions.includes("pi:data:restricted")) throw new Error("PI_MCP_DATA_CLASSIFICATION_DENIED");
  if (classification === "confidential" && !context.permissions.includes("pi:data:confidential") && !context.permissions.includes("pi:data:restricted")) throw new Error("PI_MCP_DATA_CLASSIFICATION_DENIED");
}

export class HttpMcpTransport implements McpTransport {
  private readonly egress: McpEgressClient;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly allowLocalhost = process.env.NODE_ENV !== "production",
    egress?: McpEgressClient,
  ) {
    this.egress = egress ?? new DirectMcpEgressClient(fetcher, process.env.NODE_ENV !== "production" && allowLocalhost);
  }

  async probe(server: McpServerRecord, credential: McpCredential, signal: AbortSignal, context?: RequestContext): Promise<{ tools: McpToolDefinition[] }> {
    const response = await this.request(server, credential, { jsonrpc: "2.0", id: randomUUID(), method: "tools/list", params: {} }, signal, context);
    const tools = response.result && typeof response.result === "object" && !Array.isArray(response.result) ? (response.result as Record<string, unknown>).tools : undefined;
    if (!Array.isArray(tools)) throw new Error("PI_MCP_SCHEMA_INVALID");
    return {
      tools: tools.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("PI_MCP_SCHEMA_INVALID");
        const item = raw as Record<string, unknown>;
        const inputSchema = item.inputSchema && typeof item.inputSchema === "object" && !Array.isArray(item.inputSchema) ? item.inputSchema as Record<string, unknown> : { type: "object", properties: {}, additionalProperties: false };
        return {
          name: String(item.name ?? ""), description: typeof item.description === "string" ? item.description : "",
          inputSchema, schemaDigest: sha256(stableJson(inputSchema)), requiredPermissions: Array.isArray(item.requiredPermissions) ? item.requiredPermissions.filter((value): value is string => typeof value === "string") : [],
          riskLevel: /^R[0-4]$/.test(String(item.riskLevel)) ? String(item.riskLevel) as McpToolDefinition["riskLevel"] : "R1", dataClassification: ["public", "internal", "confidential", "restricted"].includes(String(item.dataClassification)) ? String(item.dataClassification) as McpToolDefinition["dataClassification"] : "internal",
        };
      }),
    };
  }

  async call(server: McpServerRecord, tool: McpToolDefinition, arguments_: Record<string, unknown>, credential: McpCredential, signal: AbortSignal, context?: RequestContext): Promise<McpCallResult> {
    return this.request(server, credential, { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: tool.name, arguments: arguments_ } }, signal, context).then((response) => {
      if (response.error) throw new Error("PI_MCP_UPSTREAM_ERROR");
      const result: Record<string, unknown> = response.result && typeof response.result === "object" && !Array.isArray(response.result) ? response.result as Record<string, unknown> : { content: response.result };
      return { content: result.content ?? result, isError: result.isError === true };
    });
  }

  private async request(server: McpServerRecord, credential: McpCredential, body: Record<string, unknown>, signal: AbortSignal, context?: RequestContext): Promise<{ result?: unknown; error?: unknown }> {
    const endpoint = validateMcpEndpoint(server.endpointRef, server.networkPolicy, this.allowLocalhost);
    const credentialHeaders = Object.fromEntries(Object.entries(credential.headers).filter(([key]) => !/^(?:host|content-length|connection|transfer-encoding|x-nexus-tenant-id|x-nexus-actor-id|x-nexus-trace-id)$/i.test(key)));
    const response = await this.egress.request({
      server,
      credential,
      endpoint,
      signal,
      context,
      init: {
        method: "POST",
        headers: {
          ...credentialHeaders,
          accept: "application/json",
          "content-type": "application/json",
          ...(context ? { "x-nexus-tenant-id": context.tenantId, "x-nexus-actor-id": context.actorId, "x-nexus-trace-id": context.traceId } : {}),
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
      },
    });
    if (!response.ok) throw new Error(`PI_MCP_UPSTREAM_HTTP_${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > server.networkPolicy.maxResponseBytes) throw new Error("PI_MCP_RESPONSE_TOO_LARGE");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("PI_MCP_RESPONSE_INVALID"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PI_MCP_RESPONSE_INVALID");
    return parsed as { result?: unknown; error?: unknown };
  }
}

class DirectMcpEgressClient implements McpEgressClient {
  constructor(private readonly fetcher: typeof fetch, private readonly allowDirect: boolean) {}

  async request(input: { endpoint: URL; init: RequestInit; signal: AbortSignal }): Promise<Response> {
    if (!this.allowDirect) throw new Error("PI_MCP_EGRESS_UNAVAILABLE");
    return this.fetcher(input.endpoint.toString(), { ...input.init, signal: input.signal });
  }
}

export class McpBridge {
  constructor(
    private readonly registry: McpRegistryService,
    private readonly transport: McpTransport,
    private readonly credentialBroker: McpCredentialBroker,
    private readonly audit: McpAuditStore,
  ) {}

  async executeTool(invocation: McpInvocation): Promise<McpToolExecutionResult> {
    return this.execute(invocation);
  }

  async execute(invocation: McpInvocation): Promise<McpToolExecutionResult> {
    assertMcpExecutionScope(invocation);
    const startedAt = Date.now();
    const authorized = await this.registry.resolveBinding(invocation.context, { bindingId: invocation.bindingId, exposedName: invocation.exposedName, profile: invocation.profile });
    const { binding, server, tool } = authorized;
    if (invocation.expectedSchemaDigest && invocation.expectedSchemaDigest !== binding.schemaDigest) throw new Error("PI_MCP_SCHEMA_VERSION_CONFLICT");
    assertPiPermission(invocation.context, "pi:mcp:use");
    for (const permission of binding.requiredPermissions) assertPiPermission(invocation.context, permission);
    classificationAllowed(invocation.context, binding.dataClassification);
    assertJsonSchema(invocation.arguments, binding.inputSchema);
    await this.audit.append({ id: randomUUID(), tenantId: invocation.context.tenantId, actorId: invocation.context.actorId, sessionId: invocation.sessionId, runId: invocation.runId, bindingId: binding.id, serverId: server.id, serverVersion: server.version, toolName: tool.name, schemaDigest: binding.schemaDigest, inputDigest: sha256(stableJson(invocation.arguments)), resultClassification: binding.dataClassification, status: "authorized", traceId: invocation.context.traceId, createdAt: new Date().toISOString() });
    const credential = await this.credentialBroker.resolve(invocation.context, server);
    let result: McpCallResult;
    try {
      result = await this.transport.call(server, tool, invocation.arguments, credential, AbortSignal.timeout(server.networkPolicy.timeoutMs), invocation.context);
    } catch (error) {
      await this.registry.recordCircuitFailure(invocation.context, server.id, server.version).catch(() => undefined);
      const code = errorCode(error);
      const latencyMs = Date.now() - startedAt;
      await this.audit.append({ id: randomUUID(), tenantId: invocation.context.tenantId, actorId: invocation.context.actorId, sessionId: invocation.sessionId, runId: invocation.runId, bindingId: binding.id, serverId: server.id, serverVersion: server.version, toolName: tool.name, schemaDigest: binding.schemaDigest, inputDigest: sha256(stableJson(invocation.arguments)), resultClassification: binding.dataClassification, status: "failed", errorCode: code, latencyMs, traceId: invocation.context.traceId, createdAt: new Date().toISOString() });
      return { ok: false, errorCode: code, resultClassification: binding.dataClassification, serverId: server.id, serverVersion: server.version, toolName: tool.name, schemaDigest: binding.schemaDigest, latencyMs };
    }
    if (!result.isError) await this.registry.recordCircuitSuccess(invocation.context, server.id, server.version).catch(() => undefined);
    const content = scrub(result.content, credential.secretValues, server.networkPolicy.maxResponseBytes);
    const outputDigest = sha256(stableJson(content));
    const latencyMs = Date.now() - startedAt;
    await this.audit.append({ id: randomUUID(), tenantId: invocation.context.tenantId, actorId: invocation.context.actorId, sessionId: invocation.sessionId, runId: invocation.runId, bindingId: binding.id, serverId: server.id, serverVersion: server.version, toolName: tool.name, schemaDigest: binding.schemaDigest, inputDigest: sha256(stableJson(invocation.arguments)), outputDigest, resultClassification: binding.dataClassification, status: result.isError ? "failed" : "succeeded", ...(result.isError ? { errorCode: "PI_MCP_TOOL_REPORTED_ERROR" } : {}), latencyMs, traceId: invocation.context.traceId, createdAt: new Date().toISOString() });
    return { ok: !result.isError, ...(result.isError ? { errorCode: "PI_MCP_TOOL_REPORTED_ERROR" } : { content }), resultClassification: binding.dataClassification, outputDigest, serverId: server.id, serverVersion: server.version, toolName: tool.name, schemaDigest: binding.schemaDigest, latencyMs };
  }
}
