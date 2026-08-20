// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import type { PiWorkspaceSupervisorState, PiWorkspaceSupervisorContext } from "@/src/modules/pi-agent/workspace-supervisor/contracts";
import { PostgresPiWorkspaceSupervisorStateStore } from "@/src/modules/pi-agent/workspace-supervisor/postgres-state-store";
import { emptyPiWorkspaceSupervisorState } from "@/src/modules/pi-agent/workspace-supervisor/state-store";

const TENANT_A = "71000000-0000-4000-8000-000000000001";
const TENANT_B = "71000000-0000-4000-8000-000000000011";
const BASE_SHA = "a".repeat(40);
const WORKSPACE_ID = "71000000-0000-4000-8000-000000000101";

function scope(tenantId: string): PiWorkspaceSupervisorContext {
  return { tenantId, actorId: "71000000-0000-4000-8000-000000000002", sessionId: "session", runId: "run", traceId: `trace-${tenantId}` };
}

function stateFor(tenantId: string): PiWorkspaceSupervisorState {
  const current = scope(tenantId);
  const object = {
    storageRef: `s3://pi-artifacts/${tenantId}/artifact/1`,
    objectVersion: "etag-1",
    scope: current,
    artifactId: `${tenantId}-artifact`,
    version: 1,
    sizeBytes: 3,
    contentDigest: "b".repeat(64),
    mediaType: "text/plain",
    classification: "internal" as const,
  };
  return {
    schemaVersion: 1,
    leases: [{ leaseRef: `openbao://lease/${tenantId}`, scope: current, repositoryId: `${tenantId}-repository`, repositoryRef: "engineering/app", workspaceId: "workspace", branch: "pi/change", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    workspaces: [{
      id: WORKSPACE_ID,
      workspaceId: "workspace",
      providerWorkspaceRef: `forgejo://workspace/${WORKSPACE_ID}`,
      directory: `C:/pi-workspaces/pi-${WORKSPACE_ID}`,
      repository: { id: `${tenantId}-repository`, tenantId, workspaceId: "workspace", provider: "forgejo", repositoryRef: "engineering/app", defaultBranch: "main", credentialRef: "opaque://server-managed", status: "active", createdAt: new Date(0).toISOString() },
      context: current,
      baseRef: "main",
      baseCommitSha: BASE_SHA,
      branch: "pi/change",
      headCommitSha: BASE_SHA,
    }],
    objects: [object],
    grants: [{ grantRef: `grant-${tenantId}`, storageRef: object.storageRef, expiresAt: new Date(Date.now() + 60_000).toISOString() }],
  };
}

describe("PostgreSQL Pi Workspace Supervisor state store", () => {
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
        return database.transaction(async (transaction) => {
          await transaction.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
          return work({ async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await transaction.query<T>(sql, params as never[])).rows; } });
        });
      },
      async close() { await database.close(); },
    };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'supervisor-a','Supervisor A','active'),($2,'supervisor-b','Supervisor B','active')", [TENANT_A, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("partitions state by tenant, persists through restart and enables forced RLS", async () => {
    const stateId = "supervisor-state-test";
    const first = new PostgresPiWorkspaceSupervisorStateStore(adapter, { stateId, ownerId: "owner-a" });
    await expect(first.load()).resolves.toEqual(emptyPiWorkspaceSupervisorState());
    await first.save({ ...stateFor(TENANT_A), ...stateFor(TENANT_B), leases: [...stateFor(TENANT_A).leases, ...stateFor(TENANT_B).leases], workspaces: [...stateFor(TENANT_A).workspaces, ...stateFor(TENANT_B).workspaces], objects: [...stateFor(TENANT_A).objects, ...stateFor(TENANT_B).objects], grants: [...stateFor(TENANT_A).grants, ...stateFor(TENANT_B).grants] });
    await first.release();

    const recovered = new PostgresPiWorkspaceSupervisorStateStore(adapter, { stateId, ownerId: "owner-b" });
    const state = await recovered.load();
    expect(state.leases.map((item) => item.scope.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
    expect(state.objects.map((item) => item.scope.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
    // PGlite runs tests as a superuser, so it cannot prove non-owner RLS
    // visibility; the production gate below additionally requires a real
    // non-owner PostgreSQL connection. This query still proves the rows are
    // physically tenant-partitioned and the migration enables FORCE RLS.
    const tenantA = await adapter.withTenant(TENANT_A, async (db) => db.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_workspace_supervisor_states WHERE state_id=$1 AND tenant_id=$2", [stateId, TENANT_A]));
    expect(tenantA[0].count).toBe(1);
    const tenantB = await adapter.withTenant(TENANT_B, async (db) => db.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_workspace_supervisor_states WHERE state_id=$1 AND tenant_id=$2", [stateId, TENANT_B]));
    expect(tenantB[0].count).toBe(1);
    const rls = await database.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='pi_workspace_supervisor_states'");
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await recovered.release();
  });

  it("rejects a second Supervisor owner until the first owner releases", async () => {
    const first = new PostgresPiWorkspaceSupervisorStateStore(adapter, { stateId: "supervisor-owner-test", ownerId: "owner-a", leaseMs: 60_000 });
    await first.load();
    const second = new PostgresPiWorkspaceSupervisorStateStore(adapter, { stateId: "supervisor-owner-test", ownerId: "owner-b", leaseMs: 60_000 });
    await expect(second.load()).rejects.toThrow("PI_WORKSPACE_STATE_OWNER_CONFLICT");
    await first.release();
    await expect(second.load()).resolves.toEqual(emptyPiWorkspaceSupervisorState());
    await second.release();
  });

  it("fails closed on an optimistic version conflict instead of last-writer overwrite", async () => {
    const stateId = "supervisor-cas-test";
    const store = new PostgresPiWorkspaceSupervisorStateStore(adapter, { stateId, ownerId: "owner-a" });
    await store.load();
    const state = stateFor(TENANT_A);
    await store.save(state, { tenantIds: [TENANT_A] });
    await adapter.withTenant(TENANT_A, async (db) => {
      await db.query("UPDATE pi_workspace_supervisor_states SET version=version+1 WHERE state_id=$1 AND tenant_id=$2", [stateId, TENANT_A]);
    });
    await expect(store.save(state, { tenantIds: [TENANT_A] })).rejects.toThrow("PI_WORKSPACE_STATE_CONFLICT");
    await store.release();
  });
});
