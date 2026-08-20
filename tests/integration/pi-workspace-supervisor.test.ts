// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { InMemoryPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { InMemoryPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";
import { HttpPiGitCredentialBroker, RemotePiWorkspaceProvider, type WorkspaceSupervisorClient } from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import type { PiWorkspaceContext } from "@/src/modules/pi-agent/domain/workspace-contracts";
import { HttpPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";
import { PiWorkspaceSupervisorService } from "@/src/modules/pi-agent/workspace-supervisor/service";
import type { PiWorkspaceSupervisorConfig } from "@/src/modules/pi-agent/workspace-supervisor/contracts";

const execFileAsync = promisify(execFile);
const enabled = process.env.REAL_PI_WORKSPACE_E2E === "1";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name}_REQUIRED`);
  return value;
}

function context(tenantId = "10000000-0000-4000-8000-000000000001", actorId = "10000000-0000-4000-8000-000000000002"): RequestContext {
  return {
    tenantId,
    actorId,
    sessionId: "http-session",
    channel: "system",
    traceId: `trace-${randomUUID()}`,
    roles: ["pi-runner"],
    permissions: [],
    dataScopes: [{ type: "tenant" }],
  };
}

function config(overrides: Partial<PiWorkspaceSupervisorConfig> = {}): PiWorkspaceSupervisorConfig {
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
    publicBaseUrl: process.env.NEXUS_PI_WORKSPACE_PUBLIC_URL ?? "https://workspace-supervisor.test",
    ...overrides,
  };
}

function clientFor(service: PiWorkspaceSupervisorService): WorkspaceSupervisorClient {
  return {
    async request<T>(path: string, payload: Record<string, unknown>, requestContext: PiWorkspaceContext) {
      if (path === "/v1/repositories/authorize") return await service.authorizeRepository({ repositoryId: String(payload.repositoryId), repositoryRef: String(payload.repositoryRef) }, requestContext) as T;
      if (path === "/v1/git/credential-leases") return await service.issueCredential({ repositoryId: String(payload.repositoryId), repositoryRef: String(payload.repositoryRef), workspaceId: String(payload.workspaceId), branch: String(payload.branch), ttlMs: Number(payload.ttlMs) }, requestContext) as T;
      if (path === "/v1/git/credential-leases/revoke") return await service.revokeCredential(String(payload.leaseRef), requestContext) as T;
      if (path === "/v1/workspaces/prepare") return await service.prepare({ repositoryId: String(payload.repositoryId), repositoryRef: String(payload.repositoryRef), baseRef: String(payload.baseRef), baseCommitSha: String(payload.baseCommitSha), credentialLeaseRef: String(payload.credentialLeaseRef) }, requestContext) as T;
      if (path === "/v1/workspaces/verify-base") return await service.verifyBase({ providerWorkspaceRef: String(payload.providerWorkspaceRef), baseRef: String(payload.baseRef), expectedCommitSha: String(payload.expectedCommitSha), credentialLeaseRef: String(payload.credentialLeaseRef) }, requestContext) as T;
      if (path === "/v1/workspaces/branch") return await service.createBranch({ providerWorkspaceRef: String(payload.providerWorkspaceRef), branch: String(payload.branch), baseCommitSha: String(payload.baseCommitSha), credentialLeaseRef: String(payload.credentialLeaseRef) }, requestContext) as T;
      if (path === "/v1/workspaces/checkpoint") return await service.checkpoint({ providerWorkspaceRef: String(payload.providerWorkspaceRef), branch: String(payload.branch), label: String(payload.label), credentialLeaseRef: String(payload.credentialLeaseRef) }, requestContext) as T;
      if (path === "/v1/workspaces/diff") return await service.diff({ providerWorkspaceRef: String(payload.providerWorkspaceRef), baseCommitSha: String(payload.baseCommitSha), branch: String(payload.branch), credentialLeaseRef: String(payload.credentialLeaseRef) }, requestContext) as T;
      if (path === "/v1/workspaces/push") return await service.push({ providerWorkspaceRef: String(payload.providerWorkspaceRef), branch: String(payload.branch), credentialLeaseRef: String(payload.credentialLeaseRef) }, requestContext) as T;
      if (path === "/v1/workspaces/cleanup") return await service.cleanup({ providerWorkspaceRef: String(payload.providerWorkspaceRef), credentialLeaseRef: typeof payload.credentialLeaseRef === "string" ? payload.credentialLeaseRef : undefined }, requestContext) as T;
      if (path === "/v1/objects/put") return await service.putObject({ artifactId: String(payload.artifactId), version: Number(payload.version), bytes: new Uint8Array(Buffer.from(String(payload.bytesBase64), "base64")), mediaType: String(payload.mediaType), classification: payload.classification as never }, requestContext) as T;
      if (path === "/v1/objects/download-grant") return await service.issueDownloadGrant({ artifactId: String(payload.artifactId), version: Number(payload.version), storageRef: String(payload.storageRef), ttlMs: Number(payload.ttlMs) }, requestContext) as T;
      if (path === "/v1/objects/download-grant/revoke") return await service.revokeDownloadGrant(String(payload.grantRef), requestContext) as T;
      if (path === "/v1/objects/delete") return await service.deleteObject({ artifactId: String(payload.artifactId), version: Number(payload.version), storageRef: String(payload.storageRef) }, requestContext) as T;
      throw new Error(`UNEXPECTED_PATH_${path}`);
    },
  };
}

describe.skipIf(!enabled)("real Forgejo/S3 Workspace Supervisor", () => {
  it("completes checkout, exact-base branch, diff, checkpoint, push, artifact grant, revoke and cleanup", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-supervisor-real-state-"));
    const supervisor = new PiWorkspaceSupervisorService(config({ stateFile: join(stateRoot, "supervisor-state.json") }));
    await expect(supervisor.readiness()).resolves.toMatchObject({ ready: true });
    const remoteClient = clientFor(supervisor);
    const provider = new RemotePiWorkspaceProvider(remoteClient);
    const credentials = new HttpPiGitCredentialBroker(remoteClient);
    const objects = new HttpPiObjectStorageGateway(remoteClient);
    const sessions = new InMemoryPiSessionStore();
    const agent = new PiAgentService(sessions, new VirtualSandboxProvider(), new InMemoryPiRunStore());
    const actorContext = context();
    const repoRef = required("NEXUS_PI_E2E_REPOSITORY_REF");
    const repo = {
      id: "10000000-0000-4000-8000-000000000101",
      tenantId: actorContext.tenantId,
      workspaceId: "workspace-e2e",
      provider: "forgejo" as const,
      repositoryRef: repoRef,
      defaultBranch: "main",
      credentialRef: "openbao://not-in-body",
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };
    const session = await agent.createSession(actorContext, { profile: "coding", workspaceId: repo.workspaceId, repositoryId: repo.id, baseRef: "main", baseCommit: required("NEXUS_PI_E2E_BASE_COMMIT") });
    const store = new InMemoryPiWorkspaceStore();
    await store.putRepository(repo);
    const workspaceService = new PiWorkspaceService({ store, provider, credentialBroker: credentials, objectStorage: objects, sessionStore: sessions });
    const prepared = await workspaceService.prepareWorkspace(actorContext, { sessionId: session.id, runId: "10000000-0000-4000-8000-000000000201", workspaceId: repo.workspaceId, repositoryId: repo.id, baseRef: "main", baseCommitSha: required("NEXUS_PI_E2E_BASE_COMMIT"), profile: "coding" });
    expect(prepared.status).toBe("ready");
    expect(prepared.providerWorkspaceRef).toMatch(/^forgejo:\/\/workspace\//);

    const lease = await workspaceService.issueCredential(actorContext, { workspaceRecordId: prepared.id });
    expect(lease).not.toHaveProperty("leaseRef");
    const internalWorkspace = supervisor.git.get(prepared.providerWorkspaceRef!, { ...actorContext, sessionId: prepared.sessionId, runId: prepared.runId });
    await mkdir(join(internalWorkspace.directory, "src"), { recursive: true });
    await writeFile(join(internalWorkspace.directory, "src", "pi-e2e.ts"), "export const piE2E = true;\n", "utf8");
    const diff = await workspaceService.computeDiff(actorContext, prepared.id);
    expect(diff.diff).toContain("piE2E");
    expect(diff.diffDigest).toBe(createHash("sha256").update(diff.diff).digest("hex"));

    const checkpoint = await workspaceService.checkpoint(actorContext, prepared.id, "real-forgejo-checkpoint");
    expect(checkpoint.commit.branch).toBe(prepared.ephemeralBranch);
    const pushed = await workspaceService.pushBranch(actorContext, prepared.id);
    expect(pushed.headCommitSha).toBe(checkpoint.commit.commitSha);

    const providerContext = { ...actorContext, sessionId: prepared.sessionId, runId: prepared.runId };
    const directLease = await credentials.issueLease({ repository: repo, workspaceId: prepared.id, branch: prepared.ephemeralBranch, ttlMs: 60_000, context: providerContext });
    const otherContext = context("10000000-0000-4000-8000-000000000011", "10000000-0000-4000-8000-000000000012");
    await expect(credentials.revokeLease({ leaseRef: directLease.leaseRef, context: { ...otherContext, sessionId: prepared.sessionId, runId: prepared.runId } })).rejects.toThrow("PI_CREDENTIAL_SCOPE_MISMATCH");

    const branchResponse = await fetch(`${required("NEXUS_PI_FORGEJO_BASE_URL")}api/v1/repos/${repoRef}/branches/${encodeURIComponent(prepared.ephemeralBranch)}`, { headers: { Authorization: `token ${required("NEXUS_PI_FORGEJO_TOKEN")}` } });
    expect(branchResponse.status).toBe(200);
    const branch = await branchResponse.json() as { commit?: { id?: string } };
    expect(branch.commit?.id).toBe(checkpoint.commit.commitSha);

    const artifact = await workspaceService.registerArtifact(actorContext, { sessionId: prepared.sessionId, runId: prepared.runId, workspaceRecordId: prepared.id, type: "test_report", fileName: "real-e2e.json", mediaType: "application/json", classification: "internal", bytes: new TextEncoder().encode(JSON.stringify({ pushed: true, commit: checkpoint.commit.commitSha })) });
    expect(artifact.storageRef).toMatch(/^s3:\/\//);
    const grant = await workspaceService.issueDownloadGrant(actorContext, artifact.id);
    expect(grant.url).toMatch(/^https:\/\//);
    const downloaded = await supervisor.download(grant.grantRef);
    expect(downloaded.contentDigest).toBe(artifact.contentDigest);
    expect(new TextDecoder().decode(downloaded.bytes)).toContain(checkpoint.commit.commitSha);

    const recovered = new PiWorkspaceSupervisorService(config({ stateFile: join(stateRoot, "supervisor-state.json") }));
    await expect(recovered.ready()).resolves.toBeUndefined();
    const recoveredDiff = await recovered.diff({ providerWorkspaceRef: prepared.providerWorkspaceRef!, baseCommitSha: required("NEXUS_PI_E2E_BASE_COMMIT"), branch: prepared.ephemeralBranch, credentialLeaseRef: directLease.leaseRef }, providerContext);
    expect(recoveredDiff.diff).toContain("piE2E");
    await expect(recovered.download(grant.grantRef)).resolves.toMatchObject({ contentDigest: artifact.contentDigest });

    await expect(recovered.revokeCredential(directLease.leaseRef, { ...otherContext, sessionId: prepared.sessionId, runId: prepared.runId })).rejects.toThrow("PI_CREDENTIAL_SCOPE_MISMATCH");
    await expect(recovered.revokeCredential("openbao://lease/unknown", { ...otherContext, sessionId: prepared.sessionId, runId: prepared.runId })).resolves.toBeUndefined();
    await expect(recovered.cleanup({ providerWorkspaceRef: prepared.providerWorkspaceRef!, credentialLeaseRef: directLease.leaseRef }, providerContext)).resolves.toBeUndefined();
    await expect(workspaceService.cleanupWorkspace(actorContext, prepared.id)).resolves.toMatchObject({ status: "destroyed" });
    await expect(supervisor.objects.delete({ scope: { ...actorContext, sessionId: prepared.sessionId, runId: prepared.runId }, artifactId: artifact.id, version: artifact.version, storageRef: artifact.storageRef })).resolves.toBeUndefined();
    await execFileAsync("git", ["--version"]);
    await rm(stateRoot, { recursive: true, force: true });
  }, 180_000);
});
