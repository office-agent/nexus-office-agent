// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { InMemoryPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { InMemoryPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";
import {
  FailClosedPiGitCredentialBroker,
  FailClosedPiWorkspaceProvider,
  HttpPiGitCredentialBroker,
  InMemoryPiGitCredentialBroker,
  HttpWorkspaceSupervisorClient,
  RemotePiWorkspaceProvider,
  VirtualPiWorkspaceProvider,
  createPiWorkspaceProvider,
  type WorkspaceSupervisorClient,
} from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { FailClosedPiObjectStorageGateway, HttpPiObjectStorageGateway, InMemoryPiObjectStorageGateway, createPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";

const TENANT_A = "10000000-0000-4000-8000-000000000001";
const ACTOR_A = "10000000-0000-4000-8000-000000000002";
const TENANT_B = "10000000-0000-4000-8000-000000000011";
const ACTOR_B = "10000000-0000-4000-8000-000000000012";
const BASE_SHA = "a".repeat(40);
const STORAGE_SCOPE = { tenantId: TENANT_A, actorId: ACTOR_A, sessionId: "session-storage", runId: "run-storage", traceId: "trace-storage" };

const context = (tenantId = TENANT_A, actorId = ACTOR_A, channel: RequestContext["channel"] = "system"): RequestContext => ({
  tenantId,
  actorId,
  sessionId: "http-session",
  channel,
  traceId: `trace-${tenantId}`,
  roles: channel === "system" ? ["pi-runner"] : [],
  permissions: channel === "system" ? [] : ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read", "pi:workspace:write"],
  dataScopes: [{ type: "tenant" }],
});

function repository(tenantId = TENANT_A) {
  return {
    id: `repo-${tenantId}`,
    tenantId,
    workspaceId: "workspace-a",
    provider: "forgejo" as const,
    repositoryRef: "engineering/app",
    defaultBranch: "main",
    credentialRef: "openbao://git/engineering-app",
    status: "active" as const,
    createdAt: new Date().toISOString(),
  };
}

describe("Pi Workspace/Git/Artifact control plane", () => {
  it("prepares an exact-base ephemeral branch, checkpoints, stores a diff artifact, and grants one-object download", async () => {
    const sessions = new InMemoryPiSessionStore();
    const agent = new PiAgentService(sessions, new VirtualSandboxProvider(), new InMemoryPiRunStore());
    const actorContext = context();
    const session = await agent.createSession(actorContext, { profile: "coding", workspaceId: "workspace-a", repositoryId: repository().id, baseRef: "main", baseCommit: BASE_SHA });
    const provider = new VirtualPiWorkspaceProvider();
    const objects = new InMemoryPiObjectStorageGateway();
    const workspaces = new InMemoryPiWorkspaceStore();
    await workspaces.putRepository(repository());
    const service = new PiWorkspaceService({
      store: workspaces,
      provider,
      credentialBroker: new InMemoryPiGitCredentialBroker(),
      objectStorage: objects,
      sessionStore: sessions,
    });

    const prepared = await service.prepareWorkspace(actorContext, {
      sessionId: session.id,
      runId: "run-a",
      workspaceId: "workspace-a",
      repositoryId: repository().id,
      baseRef: "main",
      baseCommitSha: BASE_SHA,
      profile: "coding",
    });
    expect(prepared).toMatchObject({ status: "ready", baseCommitSha: BASE_SHA, ephemeralBranch: expect.stringMatching(/^pi\//), provider: "forgejo" });
    expect(prepared.providerWorkspaceRef).toMatch(/^virtual:\/\//);

    const safeLease = await service.issueCredential(actorContext, { workspaceRecordId: prepared.id });
    expect(safeLease).not.toHaveProperty("leaseRef");
    expect(safeLease).toMatchObject({ status: "active", branch: prepared.ephemeralBranch });

    provider.seedDiff(prepared.providerWorkspaceRef!, "diff --git a/src/app.ts b/src/app.ts\n+export const answer = 42;\n".repeat(120_000));
    const diff = await service.computeDiff(actorContext, prepared.id);
    expect(diff).toMatchObject({ baseCommitSha: BASE_SHA, truncated: true, artifactId: expect.any(String), diff: "" });
    expect(diff.diffDigest).toMatch(/^[a-f0-9]{64}$/);

    const artifacts = await service.listArtifacts(actorContext, session.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ id: diff.artifactId, type: "diff", classification: "internal", status: "active" });
    expect(objects.getObjectForTest(artifacts[0].storageRef)?.scope.tenantId).toBe(TENANT_A);

    const grant = await service.issueDownloadGrant(actorContext, artifacts[0].id);
    expect(grant).toMatchObject({ artifactId: artifacts[0].id, artifactVersion: 1, status: "active" });
    expect(grant.url).toContain("memory://download/");

    const checkpoint = await service.checkpoint(actorContext, prepared.id, "after-vibe-edit");
    expect(checkpoint).toMatchObject({ workspace: { status: "ready" }, commit: { branch: prepared.ephemeralBranch }, checkpoint: { gitCommitSha: expect.any(String) } });

    await expect(service.getWorkspace(context(TENANT_B, ACTOR_B, "web"), prepared.id)).rejects.toThrow("PI_WORKSPACE_NOT_FOUND");
    await expect(service.issueDownloadGrant(context(TENANT_B, ACTOR_B, "web"), artifacts[0].id)).rejects.toThrow("PI_ARTIFACT_NOT_FOUND");

    expect((await service.cleanupWorkspace(actorContext, prepared.id)).status).toBe("destroyed");
    await expect(service.computeDiff(actorContext, prepared.id)).rejects.toThrow("PI_WORKSPACE_NOT_ACTIVE");
  });

  it("rejects short or protected branch credentials and verifies the exact base SHA", async () => {
    const provider = new VirtualPiWorkspaceProvider();
    const repo = repository();
    const providerContext = { ...context(), runId: "run-base" };
    const prepared = await provider.prepareWorkspace({ repository: repo, baseRef: "main", baseCommitSha: BASE_SHA, ephemeralBranch: "pi/session/run", credentialLeaseRef: "memory://lease", context: providerContext });
    await expect(provider.verifyBaseCommit({ providerWorkspaceRef: prepared.providerWorkspaceRef, baseRef: "main", expectedCommitSha: "b".repeat(40), credentialLeaseRef: "memory://lease", context: providerContext })).rejects.toThrow("PI_BASE_COMMIT_MISMATCH");
    await expect(provider.createEphemeralBranch({ providerWorkspaceRef: prepared.providerWorkspaceRef, branch: "main", baseCommitSha: BASE_SHA, credentialLeaseRef: "memory://lease", context: providerContext })).rejects.toThrow("PI_PROTECTED_BRANCH");

    const workspaces = new InMemoryPiWorkspaceStore();
    await workspaces.putRepository(repo);
    const service = new PiWorkspaceService({ store: workspaces, provider: new VirtualPiWorkspaceProvider(), credentialBroker: new InMemoryPiGitCredentialBroker(), objectStorage: new InMemoryPiObjectStorageGateway() });
    await expect(service.prepareWorkspace(context(), { sessionId: "session-a", runId: "run-short", workspaceId: "workspace-a", repositoryId: repo.id, baseRef: "main", baseCommitSha: "a".repeat(12), profile: "coding" })).rejects.toThrow("PI_BASE_COMMIT_INVALID");
  });

  it("fails closed when an artifact has no real Run scope", async () => {
    const service = new PiWorkspaceService({
      store: new InMemoryPiWorkspaceStore(),
      provider: new VirtualPiWorkspaceProvider(),
      credentialBroker: new InMemoryPiGitCredentialBroker(),
      objectStorage: new InMemoryPiObjectStorageGateway(),
    });
    await expect(service.registerArtifact(context(), {
      sessionId: "session-without-run",
      type: "test_report",
      fileName: "report.json",
      mediaType: "application/json",
      classification: "internal",
      bytes: new TextEncoder().encode("{}"),
    })).rejects.toThrow("PI_ARTIFACT_SCOPE_INVALID");
  });

  it("expires artifacts only for the requesting actor within a shared tenant", async () => {
    const service = new PiWorkspaceService({
      store: new InMemoryPiWorkspaceStore(),
      provider: new VirtualPiWorkspaceProvider(),
      credentialBroker: new InMemoryPiGitCredentialBroker(),
      objectStorage: new InMemoryPiObjectStorageGateway(),
    });
    const actorAContext = context(TENANT_A, ACTOR_A, "web");
    const actorBContext = context(TENANT_A, ACTOR_B, "web");
    await service.registerArtifact(actorAContext, {
      sessionId: "session-actor-a",
      runId: "run-actor-a",
      type: "test_report",
      fileName: "actor-a.json",
      mediaType: "application/json",
      classification: "internal",
      retentionMs: 60_000,
      bytes: new TextEncoder().encode("{\"actor\":\"a\"}"),
    });
    const actorBArtifact = await service.registerArtifact(actorBContext, {
      sessionId: "session-actor-b",
      runId: "run-actor-b",
      type: "test_report",
      fileName: "actor-b.json",
      mediaType: "application/json",
      classification: "internal",
      retentionMs: 60_000,
      bytes: new TextEncoder().encode("{\"actor\":\"b\"}"),
    });

    const now = new Date(Date.now() + 120_000);
    await expect(service.applyRetention(actorAContext, now)).resolves.toBe(1);
    await expect(service.listArtifacts(actorBContext, actorBArtifact.sessionId)).resolves.toMatchObject([{ id: actorBArtifact.id, status: "active" }]);
    await expect(service.applyRetention(actorBContext, now)).resolves.toBe(1);
    await expect(service.listArtifacts(actorBContext, actorBArtifact.sessionId)).resolves.toMatchObject([{ id: actorBArtifact.id, status: "expired" }]);
  });

  it("fails closed for production factories without controlled remote endpoints", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_PI_WORKSPACE_PROVIDER", "virtual");
    vi.stubEnv("NEXUS_PI_WORKSPACE_ENDPOINT", "");
    vi.stubEnv("NEXUS_PI_OBJECT_STORAGE_PROVIDER", "memory");
    vi.stubEnv("NEXUS_PI_OBJECT_STORAGE_ENDPOINT", "");
    expect(createPiWorkspaceProvider()).toBeInstanceOf(FailClosedPiWorkspaceProvider);
    expect(createPiObjectStorageGateway()).toBeInstanceOf(FailClosedPiObjectStorageGateway);
    expect(new FailClosedPiGitCredentialBroker()).toBeInstanceOf(FailClosedPiGitCredentialBroker);
    vi.unstubAllEnvs();
  });

  it("does not accept plain HTTP remote workspace endpoints", () => {
    expect(() => new RemotePiWorkspaceProvider({ request: async <T>() => ({}) as T })).not.toThrow();
    vi.stubEnv("NEXUS_PI_WORKSPACE_ENDPOINT", "http://workspace-supervisor.internal");
    expect(createPiWorkspaceProvider()).toBeInstanceOf(FailClosedPiWorkspaceProvider);
    vi.unstubAllEnvs();
  });

  it("binds remote workspace requests to safe HTTPS paths and identity headers", async () => {
    expect(() => new HttpWorkspaceSupervisorClient("https://user:pass@workspace.internal")).toThrow("PI_WORKSPACE_ENDPOINT_MUST_USE_HTTPS");
    expect(() => new HttpWorkspaceSupervisorClient("https://workspace.internal?tenant=other")).toThrow("PI_WORKSPACE_ENDPOINT_MUST_USE_HTTPS");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new HttpWorkspaceSupervisorClient("https://workspace.internal");
      const remoteContext = { ...context(), runId: "run-remote" };
      await expect(client.request("/v1/ping", {}, remoteContext)).resolves.toMatchObject({ ok: true });
      const options = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(options?.headers).toMatchObject({ "x-tenant-id": TENANT_A, "x-actor-id": ACTOR_A, "x-session-id": "http-session", "x-run-id": "run-remote" });
      await expect(client.request("//evil.example", {}, remoteContext)).rejects.toThrow("PI_WORKSPACE_REQUEST_PATH_INVALID");
      await expect(client.request("/v1/../evil", {}, remoteContext)).rejects.toThrow("PI_WORKSPACE_REQUEST_PATH_INVALID");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a remote workspace response that attempts to return an external mount URI", async () => {
    const client: WorkspaceSupervisorClient = {
      request: async <T>(path: string, payload: Record<string, unknown>, requestContext: Parameters<WorkspaceSupervisorClient["request"]>[2]) => {
        void path;
        void payload;
        void requestContext;
        return { providerWorkspaceRef: "file:///etc", workspaceDigest: "digest" } as T;
      },
    };
    const provider = new RemotePiWorkspaceProvider(client);
    await expect(provider.prepareWorkspace({ repository: repository(), baseRef: "main", baseCommitSha: BASE_SHA, ephemeralBranch: "pi/session/run", credentialLeaseRef: "lease", context: { ...context(), runId: "run-remote" } })).rejects.toThrow("PI_WORKSPACE_SUPERVISOR_RESPONSE_INVALID");
  });

  it("binds remote Git credential issue/revoke to one real session/run scope", async () => {
    const client = { request: vi.fn() };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    client.request
      .mockResolvedValueOnce({ leaseRef: "openbao://lease/1", scopeDigest: "b".repeat(64), expiresAt })
      .mockResolvedValueOnce({});
    const broker = new HttpPiGitCredentialBroker(client);
    const gitContext = { ...context(), sessionId: "pi-session-real", runId: "run-real", traceId: "trace-real" };

    await expect(broker.issueLease({ repository: repository(), workspaceId: "workspace-record", branch: "pi/session/run", ttlMs: 60_000, context: gitContext })).resolves.toMatchObject({ leaseRef: "openbao://lease/1" });
    await broker.revokeLease({ leaseRef: "openbao://lease/1", context: gitContext });

    expect(client.request).toHaveBeenNthCalledWith(1, "/v1/git/credential-leases", {
      repositoryId: repository().id,
      repositoryRef: repository().repositoryRef,
      workspaceId: "workspace-record",
      branch: "pi/session/run",
      ttlMs: 60_000,
    }, expect.objectContaining(gitContext));
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("credentialRef");
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("actorId");
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("context");
    expect(client.request).toHaveBeenNthCalledWith(2, "/v1/git/credential-leases/revoke", { leaseRef: "openbao://lease/1" }, expect.objectContaining(gitContext));
  });

  it("rejects cross-tenant in-memory Git credential revoke", async () => {
    const broker = new InMemoryPiGitCredentialBroker();
    const lease = await broker.issueLease({ repository: repository(), workspaceId: "workspace-record", branch: "pi/session/run", ttlMs: 60_000, context: { ...context(), sessionId: "pi-session-real", runId: "run-real" } });
    await expect(broker.revokeLease({ leaseRef: lease.leaseRef, context: { ...context(TENANT_B, ACTOR_B, "system"), sessionId: "pi-session-real", runId: "run-real" } })).rejects.toThrow("PI_CREDENTIAL_SCOPE_MISMATCH");
    await broker.revokeLease({ leaseRef: lease.leaseRef, context: { ...context(), sessionId: "pi-session-real", runId: "run-real" } });
  });

  it("uses the persisted Pi session/run scope for every remote workspace and credential request", async () => {
    const sessions = new InMemoryPiSessionStore();
    const agent = new PiAgentService(sessions, new VirtualSandboxProvider(), new InMemoryPiRunStore());
    const actorContext = context();
    const repo = repository();
    const session = await agent.createSession(actorContext, { profile: "coding", workspaceId: "workspace-a", repositoryId: repo.id, baseRef: "main", baseCommit: BASE_SHA });
    const calls: Array<{ path: string; payload: Record<string, unknown>; requestContext: RequestContext & { runId: string } }> = [];
    const client: WorkspaceSupervisorClient = {
      request: async <T>(path: string, payload: Record<string, unknown>, requestContext: RequestContext & { runId: string }) => {
        calls.push({ path, payload, requestContext });
        if (path === "/v1/git/credential-leases") return { leaseRef: "openbao://lease/remote", scopeDigest: "c".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() } as T;
        if (path === "/v1/workspaces/prepare") return { providerWorkspaceRef: "forgejo://workspace/remote-1", workspaceDigest: "d".repeat(64) } as T;
        if (path === "/v1/workspaces/branch") return { branch: String(payload.ephemeralBranch), headCommitSha: BASE_SHA } as T;
        return {} as T;
      },
    };
    const workspaces = new InMemoryPiWorkspaceStore();
    await workspaces.putRepository(repo);
    const service = new PiWorkspaceService({
      store: workspaces,
      provider: new RemotePiWorkspaceProvider(client),
      credentialBroker: new HttpPiGitCredentialBroker(client),
      objectStorage: new InMemoryPiObjectStorageGateway(),
      sessionStore: sessions,
    });

    const prepared = await service.prepareWorkspace(actorContext, { sessionId: session.id, runId: "run-remote-scope", workspaceId: "workspace-a", repositoryId: repo.id, baseRef: "main", baseCommitSha: BASE_SHA, profile: "coding" });
    expect(prepared.status).toBe("ready");
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.requestContext).toMatchObject({ tenantId: TENANT_A, actorId: ACTOR_A, sessionId: session.id, runId: "run-remote-scope" });
      expect(call.payload).not.toHaveProperty("context");
      expect(call.payload).not.toHaveProperty("tenantId");
      expect(call.payload).not.toHaveProperty("actorId");
      expect(call.payload).not.toHaveProperty("sessionId");
      expect(call.payload).not.toHaveProperty("runId");
      expect(call.payload).not.toHaveProperty("traceId");
    }
    const leaseCall = calls.find((call) => call.path === "/v1/git/credential-leases");
    expect(leaseCall?.payload).not.toHaveProperty("actorId");
    expect(leaseCall?.payload).not.toHaveProperty("credentialRef");
  });

  it("keeps checkpoint, diff, push and cleanup request bodies free of context and identity fields", async () => {
    const calls: Array<{ path: string; payload: Record<string, unknown>; requestContext: RequestContext & { runId: string } }> = [];
    const client: WorkspaceSupervisorClient = {
      request: async <T>(path: string, payload: Record<string, unknown>, requestContext: RequestContext & { runId: string }) => {
        calls.push({ path, payload, requestContext });
        if (path === "/v1/workspaces/checkpoint") return { commitSha: "b".repeat(40), branch: String(payload.branch), messageDigest: "c".repeat(64), createdAt: new Date().toISOString() } as T;
        if (path === "/v1/workspaces/diff") return { baseCommitSha: BASE_SHA, headCommitSha: "b".repeat(40), diff: "", diffDigest: createHash("sha256").update("").digest("hex") } as T;
        if (path === "/v1/workspaces/push") return { branch: String(payload.branch), headCommitSha: "b".repeat(40) } as T;
        return {} as T;
      },
    };
    const provider = new RemotePiWorkspaceProvider(client);
    const remoteContext = { ...context(), sessionId: "pi-session-real", runId: "run-real", traceId: "trace-real" };
    await provider.checkpointCommit({ providerWorkspaceRef: "forgejo://workspace/remote-1", branch: "pi/session/run", label: "checkpoint", credentialLeaseRef: "openbao://lease/remote", context: remoteContext });
    await provider.computeDiff({ providerWorkspaceRef: "forgejo://workspace/remote-1", baseCommitSha: BASE_SHA, branch: "pi/session/run", credentialLeaseRef: "openbao://lease/remote", context: remoteContext });
    await provider.pushBranch({ providerWorkspaceRef: "forgejo://workspace/remote-1", branch: "pi/session/run", credentialLeaseRef: "openbao://lease/remote", context: remoteContext });
    await provider.cleanupWorkspace({ providerWorkspaceRef: "forgejo://workspace/remote-1", credentialLeaseRef: "openbao://lease/remote", context: remoteContext });

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.requestContext).toMatchObject(remoteContext);
      expect(call.payload).not.toHaveProperty("context");
      expect(call.payload).not.toHaveProperty("tenantId");
      expect(call.payload).not.toHaveProperty("actorId");
      expect(call.payload).not.toHaveProperty("sessionId");
      expect(call.payload).not.toHaveProperty("runId");
      expect(call.payload).not.toHaveProperty("traceId");
    }
  });

  it("verifies object storage response digest, size, storage ref and HTTPS download URL", async () => {
    const client = { request: vi.fn() };
    const gateway = new HttpPiObjectStorageGateway(client);
    const bytes = new Uint8Array([1, 2, 3]);
    client.request.mockResolvedValueOnce({ storageRef: "s3://tenant-a/artifact-1/1", objectVersion: "v1", sizeBytes: bytes.byteLength, contentDigest: createHash("sha256").update(bytes).digest("hex") });
    await expect(gateway.put({ scope: STORAGE_SCOPE, artifactId: "artifact-1", version: 1, bytes, mediaType: "text/plain", classification: "internal" })).resolves.toMatchObject({ storageRef: "s3://tenant-a/artifact-1/1", sizeBytes: 3 });
    expect(client.request).toHaveBeenCalledWith("/v1/objects/put", expect.not.objectContaining({ tenantId: TENANT_A, actorId: ACTOR_A, bytes: expect.anything(), scope: expect.anything() }), expect.objectContaining({ tenantId: TENANT_A, actorId: ACTOR_A, sessionId: "session-storage", runId: "run-storage", traceId: "trace-storage" }));

    client.request.mockResolvedValueOnce({ storageRef: "file:///etc/passwd", objectVersion: "v1", sizeBytes: bytes.byteLength, contentDigest: createHash("sha256").update(bytes).digest("hex") });
    await expect(gateway.put({ scope: STORAGE_SCOPE, artifactId: "artifact-1", version: 1, bytes, mediaType: "text/plain", classification: "internal" })).rejects.toThrow("PI_OBJECT_STORAGE_RESPONSE_INVALID");

    client.request.mockResolvedValueOnce({ grantRef: "grant-1", url: "file:///tmp/download", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await expect(gateway.issueDownloadGrant({ scope: STORAGE_SCOPE, artifactId: "artifact-1", version: 1, storageRef: "s3://tenant-a/artifact-1/1", ttlMs: 60_000 })).rejects.toThrow("PI_OBJECT_STORAGE_RESPONSE_INVALID");
    client.request.mockResolvedValueOnce({ grantRef: "grant-1", url: "https://objects.example/download/grant-1?sig=short", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await expect(gateway.issueDownloadGrant({ scope: STORAGE_SCOPE, artifactId: "artifact-1", version: 1, storageRef: "s3://tenant-a/artifact-1/1", ttlMs: 60_000 })).resolves.toMatchObject({ grantRef: "grant-1" });
  });

  it("keeps one real session/run/trace scope across every remote object operation", async () => {
    const client = { request: vi.fn() };
    client.request.mockImplementation(async (path: string) => {
      if (path === "/v1/objects/put") return { storageRef: "s3://tenant-a/artifact-2/1", objectVersion: "v1", sizeBytes: 3, contentDigest: createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex") };
      if (path === "/v1/objects/download-grant") return { grantRef: "grant-2", url: "https://objects.example/download/grant-2?sig=short", expiresAt: new Date(Date.now() + 60_000).toISOString() };
      return {};
    });
    const gateway = new HttpPiObjectStorageGateway(client);
    const bytes = new Uint8Array([1, 2, 3]);
    await gateway.put({ scope: STORAGE_SCOPE, artifactId: "artifact-2", version: 1, bytes, mediaType: "text/plain", classification: "internal" });
    await gateway.issueDownloadGrant({ scope: STORAGE_SCOPE, artifactId: "artifact-2", version: 1, storageRef: "s3://tenant-a/artifact-2/1", ttlMs: 60_000 });
    await gateway.revokeDownloadGrant({ scope: STORAGE_SCOPE, grantRef: "grant-2" });
    await gateway.deleteObject({ scope: STORAGE_SCOPE, artifactId: "artifact-2", version: 1, storageRef: "s3://tenant-a/artifact-2/1" });

    expect(client.request).toHaveBeenCalledTimes(4);
    for (const [, payload, requestContext] of client.request.mock.calls) {
      expect(requestContext).toMatchObject(STORAGE_SCOPE);
      expect(payload).not.toHaveProperty("scope");
      expect(payload).not.toHaveProperty("tenantId");
      expect(payload).not.toHaveProperty("actorId");
      expect(payload).not.toHaveProperty("sessionId");
      expect(payload).not.toHaveProperty("runId");
      expect(payload).not.toHaveProperty("traceId");
    }
    await expect(gateway.put({ scope: { ...STORAGE_SCOPE, runId: "" }, artifactId: "artifact-2", version: 1, bytes, mediaType: "text/plain", classification: "internal" })).rejects.toThrow("PI_OBJECT_STORAGE_SCOPE_INVALID");
  });
});
