// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { createServer as createNetServer } from "node:net";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PiWorkspaceContext } from "@/src/modules/pi-agent/domain/workspace-contracts";
import { HttpWorkspaceSupervisorClient } from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { createPiWorkspaceSupervisorServer } from "@/src/modules/pi-agent/workspace-supervisor/http-server";
import { PiWorkspaceSupervisorService } from "@/src/modules/pi-agent/workspace-supervisor/service";
import type { PiWorkspaceSupervisorConfig } from "@/src/modules/pi-agent/workspace-supervisor/contracts";

const enabled = process.env.REAL_PI_WORKSPACE_E2E === "1" && process.env.REAL_PI_WORKSPACE_HTTP_E2E === "1";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name}_REQUIRED`);
  return value;
}

function config(publicBaseUrl: string): PiWorkspaceSupervisorConfig {
  return {
    rootDirectory: required("NEXUS_PI_WORKSPACE_ROOT"),
    forgejoBaseUrl: required("NEXUS_PI_FORGEJO_BASE_URL"),
    forgejoUsername: required("NEXUS_PI_FORGEJO_USERNAME"),
    forgejoToken: required("NEXUS_PI_FORGEJO_TOKEN"),
    s3Endpoint: required("NEXUS_PI_S3_ENDPOINT"),
    s3AccessKey: required("NEXUS_PI_S3_ACCESS_KEY"),
    s3SecretKey: required("NEXUS_PI_S3_SECRET_KEY"),
    s3Bucket: process.env.NEXUS_PI_S3_BUCKET ?? "pi-artifacts",
    s3Region: process.env.NEXUS_PI_S3_REGION ?? "us-east-1",
    publicBaseUrl,
  };
}

async function reservePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function listen(server: ReturnType<typeof createPiWorkspaceSupervisorServer>, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server: ReturnType<typeof createPiWorkspaceSupervisorServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const context = (tenantId = "10000000-0000-4000-8000-000000000001", actorId = "10000000-0000-4000-8000-000000000002"): PiWorkspaceContext => ({
  tenantId,
  actorId,
  sessionId: "http-contract-session",
  runId: "http-contract-run",
  channel: "system",
  traceId: `trace-${randomUUID()}`,
  roles: ["pi-runner"],
  permissions: [],
  dataScopes: [{ type: "tenant" }],
});

describe.skipIf(!enabled)("real HTTPS Workspace Supervisor contract", () => {
  it("serves health, Git lifecycle, object grant and scope-bound cleanup over HTTPS", async () => {
    const port = await reservePort();
    const endpoint = `https://127.0.0.1:${port}/`;
    const service = new PiWorkspaceSupervisorService(config(endpoint));
    const server = createPiWorkspaceSupervisorServer({
      service,
      tls: { key: await readFile(required("NEXUS_PI_WORKSPACE_TLS_KEY")), cert: await readFile(required("NEXUS_PI_WORKSPACE_TLS_CERT")) },
    });
    const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await listen(server, port);
      const client = new HttpWorkspaceSupervisorClient(endpoint);
      const scope = context();
      const repoRef = required("NEXUS_PI_E2E_REPOSITORY_REF");
      const baseCommitSha = required("NEXUS_PI_E2E_BASE_COMMIT");
      const branch = `pi/http-contract-${randomUUID()}`;
      const repositoryId = "10000000-0000-4000-8000-000000000301";
      const workspaceId = "workspace-http-contract";

      await expect(fetch(`${endpoint}healthz`)).resolves.toMatchObject({ status: 200 });
      await expect(fetch(`${endpoint}readyz`)).resolves.toMatchObject({ status: 200 });
      await client.request("/v1/repositories/authorize", { repositoryId, repositoryRef: repoRef }, scope);

      const lease = await client.request<{ leaseRef: string; scopeDigest: string; expiresAt: string }>("/v1/git/credential-leases", {
        repositoryId,
        repositoryRef: repoRef,
        workspaceId,
        branch,
        ttlMs: 60_000,
      }, scope);
      expect(lease.leaseRef).toMatch(/^openbao:\/\/lease\//);

      const prepared = await client.request<{ providerWorkspaceRef: string; workspaceDigest: string }>("/v1/workspaces/prepare", {
        repositoryId,
        repositoryRef: repoRef,
        baseRef: "main",
        baseCommitSha,
        credentialLeaseRef: lease.leaseRef,
      }, scope);
      await client.request("/v1/workspaces/verify-base", { providerWorkspaceRef: prepared.providerWorkspaceRef, baseRef: "main", expectedCommitSha: baseCommitSha, credentialLeaseRef: lease.leaseRef }, scope);
      const branched = await client.request<{ branch: string; headCommitSha: string }>("/v1/workspaces/branch", { providerWorkspaceRef: prepared.providerWorkspaceRef, branch, baseCommitSha, credentialLeaseRef: lease.leaseRef }, scope);
      expect(branched.branch).toBe(branch);

      const workspace = service.git.get(prepared.providerWorkspaceRef, scope);
      await mkdir(join(workspace.directory, "http-contract"), { recursive: true });
      await writeFile(join(workspace.directory, "http-contract", "proof.ts"), "export const httpsContract = true;\n", "utf8");
      const diff = await client.request<{ diff: string; diffDigest: string }>("/v1/workspaces/diff", { providerWorkspaceRef: prepared.providerWorkspaceRef, baseCommitSha, branch, credentialLeaseRef: lease.leaseRef }, scope);
      expect(diff.diff).toContain("httpsContract");
      expect(diff.diffDigest).toBe(createHash("sha256").update(diff.diff).digest("hex"));
      const checkpoint = await client.request<{ commitSha: string }>("/v1/workspaces/checkpoint", { providerWorkspaceRef: prepared.providerWorkspaceRef, branch, label: "https-contract", credentialLeaseRef: lease.leaseRef }, scope);
      const pushed = await client.request<{ branch: string; headCommitSha: string }>("/v1/workspaces/push", { providerWorkspaceRef: prepared.providerWorkspaceRef, branch, credentialLeaseRef: lease.leaseRef }, scope);
      expect(pushed.headCommitSha).toBe(checkpoint.commitSha);

      const bytes = new TextEncoder().encode(JSON.stringify({ commit: checkpoint.commitSha }));
      const artifact = await client.request<{ storageRef: string; objectVersion: string; contentDigest: string; sizeBytes: number }>("/v1/objects/put", {
        artifactId: "https-contract-artifact",
        version: 1,
        bytesBase64: Buffer.from(bytes).toString("base64"),
        mediaType: "application/json",
        classification: "internal",
      }, scope);
      expect(artifact.contentDigest).toBe(createHash("sha256").update(bytes).digest("hex"));
      const grant = await client.request<{ grantRef: string; url: string }>("/v1/objects/download-grant", { artifactId: "https-contract-artifact", version: 1, storageRef: artifact.storageRef, ttlMs: 60_000 }, scope);
      const download = await fetch(grant.url);
      expect(download.status).toBe(200);
      expect(await download.text()).toContain(checkpoint.commitSha);

      const otherScope = context("10000000-0000-4000-8000-000000000011", "10000000-0000-4000-8000-000000000012");
      await expect(client.request("/v1/git/credential-leases/revoke", { leaseRef: lease.leaseRef }, otherScope)).rejects.toThrow("PI_WORKSPACE_SUPERVISOR_HTTP_403");
      await client.request("/v1/git/credential-leases/revoke", { leaseRef: lease.leaseRef }, scope);
      await client.request("/v1/workspaces/cleanup", { providerWorkspaceRef: prepared.providerWorkspaceRef, credentialLeaseRef: lease.leaseRef }, scope);
      await client.request("/v1/objects/download-grant/revoke", { grantRef: grant.grantRef }, scope);
      await expect(fetch(grant.url)).resolves.toMatchObject({ status: 404 });
      await client.request("/v1/objects/delete", { artifactId: "https-contract-artifact", version: 1, storageRef: artifact.storageRef }, scope);
    } finally {
      await close(server);
      if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
    }
  }, 180_000);
});
