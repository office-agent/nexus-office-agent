// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import type { RequestContext } from "@/src/platform/context/request-context";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { InMemoryPiGitCredentialBroker, VirtualPiWorkspaceProvider } from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { InMemoryPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";
import { PostgresPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";

const TENANT_A = "20000000-0000-4000-8000-000000000001";
const ACTOR_A = "20000000-0000-4000-8000-000000000002";
const TENANT_B = "20000000-0000-4000-8000-000000000011";
const ACTOR_B = "20000000-0000-4000-8000-000000000012";
const BASE_SHA = "c".repeat(40);

const context = (tenantId = TENANT_A, actorId = ACTOR_A): RequestContext => ({
  tenantId,
  actorId,
  sessionId: "http-session",
  channel: "web",
  traceId: `trace-${tenantId}`,
  roles: [],
  permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read", "pi:workspace:write"],
  dataScopes: [{ type: "tenant" }],
});

describe("PostgreSQL Pi Workspace/Git/Artifact control plane", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const directory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) await database.exec(await readFile(path.join(directory, file), "utf8"));
    const executor: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await database.query<T>(sql, params as never[])).rows;
      },
    };
    adapter = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'ws-a','Workspace A','active'),($2,'ws-b','Workspace B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Workspace A','workspace-a@example.test','active'),($3,$4,'Workspace B','workspace-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("persists Workspace, credential lease, checkpoint, Artifact and download grant with tenant isolation", async () => {
    const sessions = new PostgresPiSessionStore(adapter);
    const runs = new PostgresPiRunStore(adapter);
    const agent = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const repoId = "30000000-0000-4000-8000-000000000001";
    const workspaces = new PostgresPiWorkspaceStore(adapter);
    await workspaces.putRepository({
      id: repoId,
      tenantId: TENANT_A,
      workspaceId: "workspace-a",
      provider: "forgejo",
      repositoryRef: "engineering/postgres-app",
      defaultBranch: "main",
      credentialRef: "openbao://git/postgres-app",
      status: "active",
      createdAt: new Date().toISOString(),
    });
    const session = await agent.createSession(context(), { profile: "coding", workspaceId: "workspace-a", repositoryId: repoId, baseRef: "main", baseCommit: BASE_SHA });
    const run = await agent.sendMessage(context(), session.id, "准备 Workspace", "workspace-run-1");
    const provider = new VirtualPiWorkspaceProvider();
    const service = new PiWorkspaceService({ store: workspaces, provider, credentialBroker: new InMemoryPiGitCredentialBroker(), objectStorage: new InMemoryPiObjectStorageGateway(), sessionStore: sessions });

    const prepared = await service.prepareWorkspace(context(), { sessionId: session.id, runId: run.runId, workspaceId: "workspace-a", repositoryId: repoId, baseRef: "main", baseCommitSha: BASE_SHA, profile: "coding" });
    expect(prepared).toMatchObject({ status: "ready", tenantId: TENANT_A, actorId: ACTOR_A, runId: run.runId, repositoryId: repoId });
    expect(await workspaces.getWorkspace(context(TENANT_B, ACTOR_B), prepared.id)).toBeNull();
    expect(await workspaces.getCredentialLeaseForWorkspace(context(TENANT_B, ACTOR_B), prepared.id)).toBeNull();

    provider.seedDiff(prepared.providerWorkspaceRef!, "diff --git a/README.md b/README.md\n+changed\n");
    const checkpoint = await service.checkpoint(context(), prepared.id, "postgres-checkpoint");
    expect(checkpoint.checkpoint?.gitCommitSha).toBe(checkpoint.commit.commitSha);
    expect((await sessions.listCheckpoints(context(), session.id))).toHaveLength(1);

    const artifact = await service.registerArtifact(context(), { sessionId: session.id, runId: run.runId, workspaceRecordId: prepared.id, type: "test_report", fileName: "test-report.json", mediaType: "application/json", classification: "internal", bytes: new TextEncoder().encode('{"ok":true}') });
    const grant = await service.issueDownloadGrant(context(), artifact.id);
    expect(grant.artifactId).toBe(artifact.id);
    expect((await service.listArtifacts(context(), session.id))).toMatchObject([{ id: artifact.id, objectVersion: expect.any(String), contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(await service.listArtifacts(context(TENANT_B, ACTOR_B), session.id)).toEqual([]);

    const rows = await database.query<{ workspace_count: number; lease_count: number; checkpoint_count: number; artifact_count: number; grant_count: number }>(
      `SELECT
         (SELECT count(*)::int FROM pi_workspaces WHERE tenant_id=$1) AS workspace_count,
         (SELECT count(*)::int FROM pi_git_credential_leases WHERE tenant_id=$1) AS lease_count,
         (SELECT count(*)::int FROM pi_checkpoints WHERE tenant_id=$1) AS checkpoint_count,
         (SELECT count(*)::int FROM workspace_artifacts WHERE tenant_id=$1) AS artifact_count,
         (SELECT count(*)::int FROM pi_download_grants WHERE tenant_id=$1) AS grant_count`,
      [TENANT_A],
    );
    expect(rows.rows[0]).toMatchObject({ workspace_count: 1, lease_count: 1, checkpoint_count: 1, artifact_count: 1, grant_count: 1 });
  });
});
