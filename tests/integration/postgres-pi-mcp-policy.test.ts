// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { generateKeyPairSync, sign as signSignature } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { stableJson, sha256 } from "@/src/modules/pi-agent/application/manifest";
import { canonicalMcpServerPayload, Ed25519McpServerSignatureVerifier, McpRegistryService } from "@/src/modules/pi-agent/application/mcp-registry";
import { McpBridge } from "@/src/modules/pi-agent/application/mcp-bridge";
import { PolicyDecisionPoint, ToolGateway } from "@/src/modules/pi-agent/application/tool-gateway";
import { PostgresMcpAuditStore, PostgresMcpRegistryStore } from "@/src/modules/pi-agent/infrastructure/mcp-store";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import type { McpCallResult, McpCredential, McpServerRecord, McpToolDefinition, McpTransport } from "@/src/modules/pi-agent/domain/mcp-contracts";

const TENANT_A = "61000000-0000-4000-8000-000000000001";
const ACTOR_A = "61000000-0000-4000-8000-000000000002";
const TENANT_B = "61000000-0000-4000-8000-000000000011";
const ACTOR_B = "61000000-0000-4000-8000-000000000012";

function context(tenantId = TENANT_A, actorId = ACTOR_A): RequestContext {
  return { tenantId, actorId, sessionId: "61000000-0000-4000-8000-000000000099", channel: "web", traceId: `postgres-mcp-${tenantId}`, roles: [], permissions: ["pi:mcp:admin", "pi:mcp:bind", "pi:mcp:use", "pi:catalog:read", "mcp:test:read", "pi:session:create", "pi:session:read", "pi:session:write"], dataScopes: [{ type: "tenant" }] };
}

const inputSchema = { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false };
const tool = (): McpToolDefinition => ({ name: "search", description: "Postgres MCP test tool", inputSchema, schemaDigest: sha256(stableJson(inputSchema)), requiredPermissions: ["mcp:test:read"], riskLevel: "R1", dataClassification: "internal" });

class PostgresTestTransport implements McpTransport {
  async probe(_server: McpServerRecord, _credential: McpCredential, _signal: AbortSignal) { void _server; void _credential; void _signal; return { tools: [tool()] }; }
  async call(_server: McpServerRecord, _tool: McpToolDefinition, _arguments: Record<string, unknown>, _credential: McpCredential, _signal: AbortSignal): Promise<McpCallResult> { void _server; void _tool; void _arguments; void _credential; void _signal; return { content: { ok: true } }; }
}

describe("PostgreSQL MCP policy gateway", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const directory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) await database.exec(await readFile(path.join(directory, file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = { ...executor, async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]); return work(executor); }, async close() { await database.close(); } };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'mcp-a','MCP A','active'),($2,'mcp-b','MCP B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'MCP A','mcp-a@example.test','active'),($3,$4,'MCP B','mcp-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("applies 0029, persists signed schema/binding state, executes through the gateway and writes summary audit", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const networkPolicy = { allowedHosts: ["mcp.example.test"], allowedPorts: [443], timeoutMs: 5000, maxResponseBytes: 100_000 };
    const digest = sha256("postgres-mcp-descriptor");
    const signature = signSignature(null, Buffer.from(canonicalMcpServerPayload({ serverId: "postgres-server", version: "1.0.0", digest, source: "postgres-test", endpointRef: "https://mcp.example.test/mcp", networkPolicy })), privateKey).toString("base64url");
    const store = new PostgresMcpRegistryStore(adapter);
    const transport = new PostgresTestTransport();
    const registry = new McpRegistryService({ store, transport, verifier: new Ed25519McpServerSignatureVerifier(publicKey), registryVersion: "mcp-postgres-v1" });
    const admin = context();
    const server = await registry.registerServer(admin, { id: "postgres-server", version: "1.0.0", source: "postgres-test", endpointRef: "https://mcp.example.test/mcp", digest, signature, networkPolicy });
    await registry.probeCapabilities(admin, server.id, server.version);
    await registry.approveServer(admin, server.id, server.version);
    const binding = await registry.bindTool(admin, { bindingId: "62000000-0000-4000-8000-000000000001", serverId: server.id, serverVersion: server.version, toolName: "search", schemaDigest: tool().schemaDigest, allowedProfiles: ["integration"], scope: { type: "tenant" } });
    const persisted = await store.getBinding(admin, binding.id);
    expect(persisted).toMatchObject({ exposedName: "mcp.postgres-server.search", schemaDigest: tool().schemaDigest, serverDigest: digest });
    const agent = new PiAgentService(new PostgresPiSessionStore(adapter), new VirtualSandboxProvider(), new PostgresPiRunStore(adapter), undefined, registry);
    const session = await agent.createSession(admin, { profile: "integration", workspaceId: "postgres-mcp-workspace", mcpBindingIds: [binding.id] });
    expect(session.mcpBindings).toMatchObject([{ bindingId: binding.id, schemaDigest: tool().schemaDigest }]);
    const storedSession = await new PostgresPiSessionStore(adapter).getSession(admin, session.id);
    expect(storedSession?.mcpBindingIds).toEqual([binding.id]);
    expect(storedSession?.mcpBindings).toMatchObject([{ bindingId: binding.id, exposedName: binding.exposedName }]);
    const gateway = new ToolGateway(new PolicyDecisionPoint(registry), new McpBridge(registry, transport, { async resolve() { return { headers: {}, secretValues: [] }; } }, new PostgresMcpAuditStore(adapter)));
    const runtimeContext = { ...admin, sessionId: session.id };
    const result = await gateway.execute({ context: runtimeContext, profile: "integration", bindingId: binding.id, arguments: { query: "health" }, sessionId: session.id, runId: "63000000-0000-4000-8000-000000000001" });
    expect(result.ok).toBe(true);
    const audit = await database.query<{ status: string; tenant_id: string; binding_id: string }>("SELECT status,tenant_id,binding_id FROM pi_mcp_call_audits WHERE tenant_id=$1 ORDER BY created_at", [TENANT_A]);
    expect(audit.rows.map((row) => row.status)).toEqual(["authorized", "succeeded"]);
    expect(audit.rows.every((row) => row.tenant_id === TENANT_A && row.binding_id === binding.id)).toBe(true);
  });

  it("enforces Postgres tenant RLS for server, binding and call-audit rows", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const networkPolicy = { allowedHosts: ["mcp.example.test"], allowedPorts: [443], timeoutMs: 5000, maxResponseBytes: 100_000 };
    const digest = sha256("tenant-rules");
    const signature = signSignature(null, Buffer.from(canonicalMcpServerPayload({ serverId: "tenant-server", version: "1.0.0", digest, source: "tenant-test", endpointRef: "https://mcp.example.test/mcp", networkPolicy })), privateKey).toString("base64url");
    const registry = new McpRegistryService({ store: new PostgresMcpRegistryStore(adapter), verifier: new Ed25519McpServerSignatureVerifier(publicKey), transport: new PostgresTestTransport() });
    const server = await registry.registerServer(context(), { id: "tenant-server", version: "1.0.0", source: "tenant-test", endpointRef: "https://mcp.example.test/mcp", digest, signature, networkPolicy });
    expect(await new PostgresMcpRegistryStore(adapter).getServer(context(TENANT_B, ACTOR_B), server.id, server.version)).toBeNull();
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_B]);
    const rows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM mcp_servers WHERE tenant_id=$1 AND id=$2", [TENANT_B, server.id]);
    const bindingRows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM mcp_tool_bindings WHERE tenant_id=$1", [TENANT_B]);
    const auditRows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_mcp_call_audits WHERE tenant_id=$1", [TENANT_B]);
    const rlsRows = await database.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('mcp_servers','mcp_tool_bindings','pi_mcp_call_audits') ORDER BY relname");
    expect(rows.rows[0].count).toBe(0);
    expect(bindingRows.rows[0].count).toBe(0);
    expect(auditRows.rows[0].count).toBe(0);
    expect(rlsRows.rows).toHaveLength(3);
    expect(rlsRows.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
});
