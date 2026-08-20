// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { afterEach, describe, expect, it } from "vitest";
import type { PiWorkspaceSupervisorService } from "@/src/modules/pi-agent/workspace-supervisor/service";
import { createPiWorkspaceSupervisorServer } from "@/src/modules/pi-agent/workspace-supervisor/http-server";

const servers: Array<ReturnType<typeof createPiWorkspaceSupervisorServer>> = [];

async function startServer(service: Partial<PiWorkspaceSupervisorService>): Promise<string> {
  const server = createPiWorkspaceSupervisorServer({ service: service as PiWorkspaceSupervisorService });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
  return `http://127.0.0.1:${address.port}`;
}

const headers = {
  "content-type": "application/json",
  "x-tenant-id": "tenant-a",
  "x-actor-id": "actor-a",
  "x-session-id": "session-a",
  "x-run-id": "run-a",
  "x-trace-id": "trace-a",
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Pi Workspace Supervisor HTTP boundary", () => {
  it("rejects identity and credential fields in request bodies", async () => {
    const base = await startServer({ readiness: async () => ({ ready: true }), issueCredential: async () => ({ leaseRef: "openbao://lease/test", scopeDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
    const identity = await fetch(`${base}/v1/git/credential-leases`, { method: "POST", headers, body: JSON.stringify({ repositoryId: "repo", repositoryRef: "owner/repo", workspaceId: "workspace", branch: "pi/session/run", ttlMs: 60_000, tenantId: "tenant-b" }) });
    expect(identity.status).toBe(400);
    await expect(identity.json()).resolves.toMatchObject({ error: { code: "PI_WORKSPACE_IDENTITY_IN_BODY" } });

    const secret = await fetch(`${base}/v1/git/credential-leases`, { method: "POST", headers, body: JSON.stringify({ repositoryId: "repo", repositoryRef: "owner/repo", workspaceId: "workspace", branch: "pi/session/run", ttlMs: 60_000, token: "should-not-be-here" }) });
    expect(secret.status).toBe(400);
    await expect(secret.json()).resolves.toMatchObject({ error: { code: "PI_WORKSPACE_IDENTITY_IN_BODY" } });
  });

  it("requires all server-derived scope headers", async () => {
    const base = await startServer({ readiness: async () => ({ ready: true }), issueCredential: async () => ({ leaseRef: "openbao://lease/test", scopeDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
    const missing = await fetch(`${base}/v1/git/credential-leases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryId: "repo", repositoryRef: "owner/repo", workspaceId: "workspace", branch: "pi/session/run", ttlMs: 60_000 }) });
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "PI_WORKSPACE_SCOPE_INVALID" } });
  });

  it("rejects query-string routes to keep opaque references out of cache keys", async () => {
    const base = await startServer({ readiness: async () => ({ ready: true }) });
    const response = await fetch(`${base}/healthz?grantRef=opaque`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "PI_WORKSPACE_URL_QUERY_NOT_ALLOWED" } });
  });
});
