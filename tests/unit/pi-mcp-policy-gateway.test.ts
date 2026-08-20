// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { generateKeyPairSync, sign as signSignature } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import { stableJson, sha256 } from "@/src/modules/pi-agent/application/manifest";
import { canonicalMcpServerPayload, Ed25519McpServerSignatureVerifier, McpRegistryService } from "@/src/modules/pi-agent/application/mcp-registry";
import { McpBridge } from "@/src/modules/pi-agent/application/mcp-bridge";
import { PolicyDecisionPoint, ToolGateway } from "@/src/modules/pi-agent/application/tool-gateway";
import { InMemoryMcpAuditStore, InMemoryMcpRegistryStore } from "@/src/modules/pi-agent/infrastructure/mcp-store";
import type { McpCallResult, McpCredential, McpServerRecord, McpToolDefinition, McpTransport } from "@/src/modules/pi-agent/domain/mcp-contracts";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { InMemoryPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { createPiMcpTools } from "@/src/modules/pi-agent/infrastructure/mcp-tools";

const TENANT_A = "60000000-0000-4000-8000-000000000001";
const ACTOR_A = "60000000-0000-4000-8000-000000000002";
const TENANT_B = "60000000-0000-4000-8000-000000000011";
const ACTOR_B = "60000000-0000-4000-8000-000000000012";
const RUN_ID = "mcp-run-scope";

function context(tenantId = TENANT_A, actorId = ACTOR_A, permissions = ["pi:mcp:admin", "pi:mcp:bind", "pi:mcp:use", "pi:catalog:read"]): RequestContext {
  return { tenantId, actorId, sessionId: "mcp-session", channel: "web", traceId: `mcp-trace-${tenantId}`, roles: [], permissions, dataScopes: [{ type: "tenant" }] };
}

const inputSchema = { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 } }, required: ["query"], additionalProperties: false };
const tool = (): McpToolDefinition => ({ name: "search", description: "Search the approved test system", inputSchema, schemaDigest: sha256(stableJson(inputSchema)), requiredPermissions: ["mcp:test:read"], riskLevel: "R1", dataClassification: "internal" });

class TestCredentialBroker {
  async resolve(_context: RequestContext, _server: McpServerRecord): Promise<McpCredential> { void _context; void _server; return { headers: { authorization: "Bearer top-secret" }, secretValues: ["top-secret", "Bearer top-secret"] }; }
}

class TestTransport implements McpTransport {
  failures = 0;
  async probe(_server: McpServerRecord, _credential: McpCredential, _signal: AbortSignal) { void _server; void _credential; void _signal; return { tools: [tool()] }; }
  async call(_server: McpServerRecord, _tool: McpToolDefinition, _arguments: Record<string, unknown>, _credential: McpCredential, _signal: AbortSignal): Promise<McpCallResult> {
    void _server; void _tool; void _arguments; void _credential; void _signal;
    if (this.failures > 0) throw new Error("PI_MCP_UPSTREAM_ERROR");
    return { content: { result: "ok", authorization: "Bearer top-secret", nested: ["top-secret"] } };
  }
}

async function createGateway(transport = new TestTransport(), requestedOwner?: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const store = new InMemoryMcpRegistryStore();
  const registry = new McpRegistryService({ store, transport, credentialBroker: new TestCredentialBroker(), verifier: new Ed25519McpServerSignatureVerifier(publicKey), registryVersion: "mcp-test-v1" });
  const audit = new InMemoryMcpAuditStore();
  const gateway = new ToolGateway(new PolicyDecisionPoint(registry), new McpBridge(registry, transport, new TestCredentialBroker(), audit));
  const digest = sha256("test-mcp-server-descriptor");
  const networkPolicy = { allowedHosts: ["mcp.example.test"], allowedPorts: [443], timeoutMs: 5000, maxResponseBytes: 100_000 };
  const signature = signSignature(null, Buffer.from(canonicalMcpServerPayload({ serverId: "test-server", version: "1.0.0", digest, source: "internal-test", endpointRef: "https://mcp.example.test/mcp", networkPolicy })), privateKey).toString("base64url");
  const admin = context(undefined, undefined, ["pi:mcp:admin", "pi:mcp:bind", "pi:mcp:use", "pi:catalog:read", "mcp:test:read", "pi:session:create", "pi:session:read", "pi:session:write"]);
  const server = await registry.registerServer(admin, { id: "test-server", version: "1.0.0", source: "internal-test", endpointRef: "https://mcp.example.test/mcp", digest, signature, networkPolicy, ...(requestedOwner ? { ownerActorId: requestedOwner } : {}) });
  await registry.probeCapabilities(admin, server.id, server.version);
  await registry.approveServer(admin, server.id, server.version);
  const binding = await registry.bindTool(admin, { bindingId: "70000000-0000-4000-8000-000000000001", serverId: server.id, serverVersion: server.version, toolName: "search", schemaDigest: tool().schemaDigest, allowedProfiles: ["integration"], scope: { type: "tenant" } });
  return { registry, gateway, binding, transport, audit, admin, server };
}

describe("MCP Registry, Bridge and Tool Gateway", () => {
  it("freezes signed server and tool schema, exposes only safe catalog metadata, and redacts credentials", async () => {
    const { gateway, binding, admin, audit } = await createGateway();
    const catalog = await gateway.resolveCapabilities(admin, "integration");
    expect(catalog[0]).toMatchObject({ exposedName: "mcp.test-server.search", schemaDigest: tool().schemaDigest, inputSchemaDigest: tool().schemaDigest });
    expect(JSON.stringify(catalog)).not.toContain("top-secret");

    const result = await gateway.execute({ context: admin, profile: "integration", exposedName: binding.exposedName, expectedSchemaDigest: binding.schemaDigest, arguments: { query: "status" }, sessionId: admin.sessionId, runId: "80000000-0000-4000-8000-000000000001" });
    expect(result).toMatchObject({ ok: true, resultClassification: "internal", outputDigest: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(audit.items.map((item) => item.status)).toEqual(["authorized", "succeeded"]);
  });

  it("fails closed for missing required permissions, schema drift, invalid arguments and cross-tenant access", async () => {
    const { gateway, registry, binding, admin } = await createGateway();
    await expect(gateway.execute({ context: context(TENANT_A, ACTOR_A, ["pi:mcp:use"]), profile: "integration", bindingId: binding.id, arguments: { query: "status" }, sessionId: "mcp-session", runId: RUN_ID })).rejects.toThrow("POLICY_DENIED:mcp:test:read");
    await expect(gateway.execute({ context: admin, profile: "integration", bindingId: binding.id, expectedSchemaDigest: sha256("wrong"), arguments: { query: "status" }, sessionId: admin.sessionId, runId: RUN_ID })).rejects.toThrow("PI_MCP_SCHEMA_VERSION_CONFLICT");
    await expect(gateway.execute({ context: admin, profile: "integration", bindingId: binding.id, arguments: {}, sessionId: admin.sessionId, runId: RUN_ID })).rejects.toThrow("PI_MCP_ARGUMENTS_INVALID");
    await expect(gateway.execute({ context: context(TENANT_B, ACTOR_B, ["pi:mcp:use", "mcp:test:read"]), profile: "integration", bindingId: binding.id, arguments: { query: "status" }, sessionId: "mcp-session", runId: RUN_ID })).rejects.toThrow("PI_MCP_BINDING_NOT_FOUND");
    await registry.revokeBinding(admin, binding.id);
    await expect(gateway.execute({ context: admin, profile: "integration", bindingId: binding.id, arguments: { query: "status" }, sessionId: admin.sessionId, runId: RUN_ID })).rejects.toThrow("PI_MCP_BINDING_REVOKED");
    await expect(gateway.execute({ context: admin, profile: "integration", bindingId: binding.id, arguments: { query: "status" }, sessionId: "", runId: RUN_ID })).rejects.toThrow("PI_MCP_EXECUTION_SCOPE_REQUIRED");
    await expect(gateway.execute({ context: admin, profile: "integration", bindingId: binding.id, arguments: { query: "status" }, sessionId: "other-session", runId: RUN_ID })).rejects.toThrow("PI_MCP_SESSION_SCOPE_MISMATCH");
  });

  it("opens a per-server circuit after repeated upstream failures and preserves audit summaries", async () => {
    const transport = new TestTransport();
    const { gateway, binding, admin, audit } = await createGateway(transport);
    transport.failures = 1;
    for (let index = 0; index < 3; index++) {
      const result = await gateway.execute({ context: admin, profile: "integration", bindingId: binding.id, arguments: { query: "status" }, sessionId: admin.sessionId, runId: RUN_ID });
      expect(result).toMatchObject({ ok: false, errorCode: "PI_MCP_UPSTREAM_ERROR" });
    }
    await expect(gateway.execute({ context: admin, profile: "integration", bindingId: binding.id, arguments: { query: "status" }, sessionId: admin.sessionId, runId: RUN_ID })).rejects.toThrow("PI_MCP_CIRCUIT_OPEN");
    expect(audit.items.filter((item) => item.status === "failed")).toHaveLength(3);
    expect(audit.items.every((item) => !("content" in item))).toBe(true);
  });

  it("pins selected MCP bindings into the Session and RunManifest and does not broaden them at runtime", async () => {
    const { registry, binding, admin } = await createGateway();
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const agent = new PiAgentService(sessions, new VirtualSandboxProvider(), runs, undefined, registry);
    const session = await agent.createSession(admin, { profile: "integration", workspaceId: "mcp-workspace", mcpBindingIds: [binding.id] });
    expect(session.mcpBindingIds).toEqual([binding.id]);
    expect(session.mcpBindings).toMatchObject([{ bindingId: binding.id, exposedName: binding.exposedName, schemaDigest: binding.schemaDigest }]);
    const accepted = await agent.sendMessage(admin, session.id, "查询状态", "mcp-session-run-1");
    const manifest = await runs.getManifest(admin, accepted.runId);
    expect(manifest?.mcpBindings).toMatchObject([{ bindingId: binding.id, exposedName: binding.exposedName, schemaDigest: binding.schemaDigest }]);
    expect(manifest?.toolSnapshot.names).toContain(binding.exposedName);
  });

  it("binds Pi MCP tool execution to the authoritative Session and Run scope", async () => {
    const { gateway, binding, admin, audit } = await createGateway();
    const scopeContext = { ...admin, sessionId: "pi-session-scope" };
    const tools = await createPiMcpTools({
      context: scopeContext,
      profile: "integration",
      gateway,
      bindingIds: [binding.id],
      sessionId: "pi-session-scope",
      runId: "pi-run-scope",
    });
    const result = await tools[0].execute("pi-tool-call", { query: "scope" }, undefined, undefined, undefined as never);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining('"ok":true') }]);
    expect(audit.items.filter((item) => item.status === "authorized" || item.status === "succeeded")).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "pi-session-scope", runId: "pi-run-scope" }),
    ]));
  });

  it("fails closed when a Session with MCP bindings has no Tool Gateway", async () => {
    const { registry, binding, admin } = await createGateway();
    const sessions = new InMemoryPiSessionStore();
    const runs = new InMemoryPiRunStore();
    const agent = new PiAgentService(sessions, new VirtualSandboxProvider(), runs, undefined, registry);
    const session = await agent.createSession(admin, { profile: "integration", workspaceId: "mcp-scope-workspace", mcpBindingIds: [binding.id] });
    await agent.sendMessage(admin, session.id, "缺少 Tool Gateway 时失败关闭", "mcp-scope-run-1");
    const worker = new (await import("@/src/modules/pi-agent/application/runner")).PiRunnerWorker(sessions, runs, new VirtualSandboxProvider(), { runtimeFactory: vi.fn(async () => { throw new Error("RUNTIME_MUST_NOT_START"); }) });
    const result = await worker.processTenant(TENANT_A, "mcp-scope-runner");
    expect(result.status).toBe("failed");
    expect((await sessions.getEvents(admin, session.id, 0, 100)).map((event) => event.type)).toContain("resource_rejected");
  });

  it("rejects unsafe endpoint and network policy declarations before a probe", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const digest = sha256("descriptor");
    const networkPolicy = { allowedHosts: ["169.254.169.254"], allowedPorts: [80], timeoutMs: 5000, maxResponseBytes: 100_000 };
    const registry = new McpRegistryService({ store: new InMemoryMcpRegistryStore(), verifier: new Ed25519McpServerSignatureVerifier(publicKey) });
    const signature = signSignature(null, Buffer.from(canonicalMcpServerPayload({ serverId: "metadata", version: "1.0.0", digest, source: "test", endpointRef: "http://169.254.169.254/mcp", networkPolicy })), privateKey).toString("base64url");
    await expect(registry.registerServer(context(), { id: "metadata", version: "1.0.0", source: "test", endpointRef: "http://169.254.169.254/mcp", digest, signature, networkPolicy })).rejects.toThrow("PI_MCP_NETWORK_POLICY_INVALID");
  });

  it("does not trust a client-supplied MCP owner and rejects an unscoped credential reference", async () => {
    const { server, admin } = await createGateway(new TestTransport(), ACTOR_B);
    expect(server.ownerActorId).toBe(admin.actorId);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const digest = sha256("unscoped-credential");
    const networkPolicy = { allowedHosts: ["mcp.example.test"], allowedPorts: [443], timeoutMs: 5000, maxResponseBytes: 100_000 };
    const registry = new McpRegistryService({ store: new InMemoryMcpRegistryStore(), verifier: new Ed25519McpServerSignatureVerifier(publicKey) });
    const signature = signSignature(null, Buffer.from(canonicalMcpServerPayload({ serverId: "credential-server", version: "1.0.0", digest, source: "test", endpointRef: "https://mcp.example.test/mcp", networkPolicy })), privateKey).toString("base64url");
    await expect(registry.registerServer(admin, { id: "credential-server", version: "1.0.0", source: "test", endpointRef: "https://mcp.example.test/mcp", credentialRef: "secret://other-tenant/mcp", digest, signature, networkPolicy })).rejects.toThrow("PI_MCP_CREDENTIAL_SCOPE_INVALID");
  });
});
