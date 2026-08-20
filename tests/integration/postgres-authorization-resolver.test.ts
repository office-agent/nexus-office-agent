// Requirements: MR-008, MR-009, AR-002, SR-001, SR-002, SR-004, AC-003
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { mapStoredDataScope, PostgresAuthorizationResolver } from "@/src/platform/identity/authorization-resolver";

const tenantId = "00000000-0000-4000-8000-000000000201";
const actorId = "10000000-0000-4000-8000-000000000201";
const roleId = "20000000-0000-4000-8000-000000000201";
const permissionId = "21000000-0000-4000-8000-000000000201";

describe("authoritative PostgreSQL authorization resolver", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of ["0001_foundation.sql", "0008_security_hardening.sql"]) {
      await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    }
    const executor: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await database.query<T>(sql, params as never[])).rows;
      },
    };
    adapter = {
      ...executor,
      async withTenant<T>(activeTenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id',$1,false)", [activeTenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'authz','Authorization','active')", [tenantId]);
    await adapter.withTenant(tenantId, async (executor) => {
      await executor.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','authz@example.test','active')", [actorId, tenantId]);
      await executor.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'manager','Manager')", [roleId, tenantId]);
      await executor.query("INSERT INTO permissions(id,code,description,risk_level) VALUES($1,'project:read','Read projects',0)", [permissionId]);
      await executor.query("INSERT INTO role_permissions(tenant_id,role_id,permission_id) VALUES($1,$2,$3)", [tenantId, roleId, permissionId]);
      await executor.query("INSERT INTO user_roles(id,tenant_id,user_id,role_id,scope_type,scope_value,starts_at) VALUES($1,$2,$3,$4,'project',$5,$6)", [crypto.randomUUID(), tenantId, actorId, roleId, { projectIds: ["project-a"] }, new Date("2026-01-01T00:00:00Z")]);
    });
  });

  afterEach(async () => database.close());

  it("uses only currently active database grants and removes them immediately on expiry", async () => {
    const resolver = new PostgresAuthorizationResolver(adapter);
    await expect(resolver.resolve(tenantId, actorId, new Date("2026-08-05T00:00:00Z"))).resolves.toEqual({
      roles: ["manager"],
      permissions: ["project:read"],
      dataScopes: [{ type: "project", projectIds: ["project-a"] }],
    });
    await adapter.withTenant(tenantId, (executor) => executor.query("UPDATE user_roles SET expires_at=$3 WHERE tenant_id=$1 AND user_id=$2", [tenantId, actorId, new Date("2026-08-05T00:00:01Z")]).then(() => undefined));
    await expect(resolver.resolve(tenantId, actorId, new Date("2026-08-05T00:00:02Z"))).resolves.toEqual({ roles: [], permissions: [], dataScopes: [] });
  });

  it("invalidates departed users and fails closed for malformed stored scope", async () => {
    const resolver = new PostgresAuthorizationResolver(adapter);
    await adapter.withTenant(tenantId, (executor) => executor.query("UPDATE users SET status='departed' WHERE tenant_id=$1 AND id=$2", [tenantId, actorId]).then(() => undefined));
    await expect(resolver.resolve(tenantId, actorId)).resolves.toBeNull();
    expect(() => mapStoredDataScope("project", { projectIds: ["ok", 42] })).toThrow("AUTHORIZATION_SCOPE_INVALID");
  });
});
