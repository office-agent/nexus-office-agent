// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
// Opt-in non-owner PostgreSQL/RLS regression. Run only against a disposable database:
// REAL_POSTGRES_PI_TEST=1 REAL_POSTGRES_PI_URL=postgres://nexus_app... REAL_POSTGRES_PI_ADMIN_URL=postgres://nexus... npx vitest run tests/integration/real-postgres-pi-workspace-supervisor-state.test.ts
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { runMigrations } from "@/src/platform/database/migrator";
import type { MigrationDatabase, TransactionalDatabase } from "@/src/platform/database/executor";
import { PostgresPiWorkspaceSupervisorStateStore } from "@/src/modules/pi-agent/workspace-supervisor/postgres-state-store";
import { emptyPiWorkspaceSupervisorState } from "@/src/modules/pi-agent/workspace-supervisor/state-store";

const enabled = process.env.REAL_POSTGRES_PI_TEST === "1" && Boolean(process.env.REAL_POSTGRES_PI_URL);
const realIt = enabled ? it : it.skip;

describe("real non-owner PostgreSQL Pi Workspace Supervisor state", () => {
  let database: TransactionalDatabase | undefined;
  let adminDatabase: (TransactionalDatabase & MigrationDatabase) | undefined;
  let tenantA = "";
  let tenantB = "";

  beforeAll(async () => {
    if (!enabled) return;
    tenantA = randomUUID();
    tenantB = randomUUID();
    adminDatabase = createPostgresDatabase(process.env.REAL_POSTGRES_PI_ADMIN_URL ?? process.env.REAL_POSTGRES_PI_URL!);
    await runMigrations(adminDatabase, path.resolve("src/platform/database/migrations"));
    await adminDatabase.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,$2,'Supervisor State A','active'),($3,$4,'Supervisor State B','active')", [tenantA, `supervisor-state-a-${tenantA.slice(0, 8)}`, tenantB, `supervisor-state-b-${tenantB.slice(0, 8)}`]);
    database = createPostgresDatabase(process.env.REAL_POSTGRES_PI_URL!);
  });

  afterAll(async () => {
    await database?.close();
    await adminDatabase?.close();
  });

  realIt("enforces tenant visibility, owner fencing and CAS with a non-owner role", async () => {
    const stateId = `real-supervisor-state-${randomUUID()}`;
    const store = new PostgresPiWorkspaceSupervisorStateStore(database!, { stateId, ownerId: "real-owner-a", leaseMs: 60_000 });
    await expect(store.load()).resolves.toEqual(emptyPiWorkspaceSupervisorState());

    const tenantACount = await database!.withTenant(tenantA, async (db) => db.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_workspace_supervisor_states WHERE state_id=$1", [stateId]));
    expect(tenantACount[0].count).toBe(1);
    const tenantBCrossRead = await database!.withTenant(tenantB, async (db) => db.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_workspace_supervisor_states WHERE state_id=$1 AND tenant_id=$2", [stateId, tenantA]));
    expect(tenantBCrossRead[0].count).toBe(0);

    const second = new PostgresPiWorkspaceSupervisorStateStore(database!, { stateId, ownerId: "real-owner-b", leaseMs: 60_000 });
    await expect(second.load()).rejects.toThrow("PI_WORKSPACE_STATE_OWNER_CONFLICT");
    await store.release();
    await expect(second.load()).resolves.toEqual(emptyPiWorkspaceSupervisorState());

    await adminDatabase!.query("UPDATE pi_workspace_supervisor_states SET version=version+1 WHERE state_id=$1 AND tenant_id=$2", [stateId, tenantA]);
    await expect(second.save(emptyPiWorkspaceSupervisorState(), { tenantIds: [tenantA] })).rejects.toThrow("PI_WORKSPACE_STATE_CONFLICT");

    const rls = await adminDatabase!.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='pi_workspace_supervisor_states'");
    expect(rls[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await second.release();
  }, 30_000);
});
