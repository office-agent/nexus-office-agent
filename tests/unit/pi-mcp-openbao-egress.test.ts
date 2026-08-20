// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { describe, expect, it } from "vitest";
import type { McpEgressClient, McpServerRecord } from "@/src/modules/pi-agent/domain/mcp-contracts";
import { HttpMcpTransport } from "@/src/modules/pi-agent/application/mcp-bridge";
import { OpenBaoSecretClient } from "@/src/platform/secrets/openbao-secret-client";

const tenantId = "60000000-0000-4000-8000-000000000001";
const actorId = "60000000-0000-4000-8000-000000000002";

function server(): McpServerRecord {
  return {
    id: "test-server",
    tenantId,
    version: "1.0.0",
    source: "test",
    endpointRef: "https://mcp.example.test/mcp",
    digest: "a".repeat(64),
    signature: "signature",
    networkPolicy: { allowedHosts: ["mcp.example.test"], allowedPorts: [443], timeoutMs: 5_000, maxResponseBytes: 100_000, proxyRef: "egress:/mcp" },
    approvalStatus: "approved",
    tools: [],
    circuitState: "closed",
    failureCount: 0,
    createdAt: new Date().toISOString(),
  };
}

describe("MCP OpenBao and egress adapters", () => {
  it("reads a tenant-scoped OpenBao response without exposing the token", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const client = new OpenBaoSecretClient({
      endpoint: "https://openbao.example.test",
      tokenProvider: async () => "short-lived-token",
      fetcher: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ data: { data: { value: JSON.stringify({ token: "mcp-secret" }) } } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const value = await client.resolveString(`secret://kv/data/tenants/${tenantId}/mcp/test`, "mcp:test-server:1.0.0");
    expect(value).toBe(JSON.stringify({ token: "mcp-secret" }));
    expect(requests[0].url).toBe(`https://openbao.example.test/v1/kv/data/tenants/${tenantId}/mcp/test`);
    expect(requests[0].headers.get("x-vault-token")).toBe("short-lived-token");
    expect(requests[0].headers.get("x-nexus-purpose")).toBe("mcp:test-server:1.0.0");
    expect(JSON.stringify(requests)).not.toContain("mcp-secret");
  });

  it("requires an injected egress adapter when direct MCP networking is disabled", async () => {
    const transport = new HttpMcpTransport(async () => { throw new Error("direct fetch must not be called"); }, false);
    await expect(transport.probe(server(), { headers: {}, secretValues: [] }, AbortSignal.timeout(500))).rejects.toThrow("PI_MCP_EGRESS_UNAVAILABLE");
  });

  it("passes tenant, actor and trace identity to the egress boundary", async () => {
    const calls: Array<{ headers: Headers; proxyRef?: string }> = [];
    const egress: McpEgressClient = {
      async request(input) {
        calls.push({ headers: new Headers(input.init.headers), proxyRef: input.server.networkPolicy.proxyRef });
        return new Response(JSON.stringify({ result: { tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } }), { status: 200 });
      },
    };
    const transport = new HttpMcpTransport(async () => { throw new Error("injected egress must be used"); }, false, egress);
    await transport.probe(server(), { headers: { authorization: "Bearer secret" }, secretValues: ["secret"] }, AbortSignal.timeout(500), { tenantId, actorId, sessionId: "session", channel: "system", traceId: "trace", roles: [], permissions: [], dataScopes: [{ type: "tenant" }] });
    expect(calls[0].proxyRef).toBe("egress:/mcp");
    expect(calls[0].headers.get("x-nexus-tenant-id")).toBe(tenantId);
    expect(calls[0].headers.get("x-nexus-actor-id")).toBe(actorId);
    expect(calls[0].headers.get("x-nexus-trace-id")).toBe("trace");
    expect(calls[0].headers.get("authorization")).toBe("Bearer secret");
  });
});
