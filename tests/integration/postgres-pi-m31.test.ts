// Requirements: PR-001, PR-005, SR-003, SR-005, SR-006, AC-006, AC-013, DR-010
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { PiSecurityResilienceService } from "@/src/modules/pi-agent/application/security-resilience";
import { PostgresPiSecurityResilienceStore } from "@/src/modules/pi-agent/infrastructure/m31-store";

const TENANT_A = "75000000-0000-4000-8000-000000000001";
const ACTOR_A = "75000000-0000-4000-8000-000000000002";
const TENANT_B = "75000000-0000-4000-8000-000000000011";
const ACTOR_B = "75000000-0000-4000-8000-000000000012";

function context(tenantId = TENANT_A, actorId = ACTOR_A): RequestContext {
  return { tenantId, actorId, sessionId: "75000000-0000-4000-8000-000000000099", channel: "web", traceId: `postgres-m31-${tenantId}`, roles: [], permissions: ["pi:kill-switch:read", "pi:kill-switch:write", "pi:kill-switch:global", "pi:security:read", "pi:capacity:read", "pi:capacity:admin", "pi:capacity:write", "pi:failure:inject"], dataScopes: [{ type: "tenant" }] };
}

describe("PostgreSQL Pi M31 security and resilience control plane", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const migrationDirectory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) await database.exec(await readFile(path.join(migrationDirectory, file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = { ...executor, async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]); return work(executor); }, async close() { await database.close(); } };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'m31-a','M31 A','active'),($2,'m31-b','M31 B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'M31 A','m31-a@example.test','active'),($3,$4,'M31 B','m31-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("keeps tenant events, capacity leases and switches isolated while allowing an explicit global switch", async () => {
    const control = new PiSecurityResilienceService(new PostgresPiSecurityResilienceStore(adapter), { allowFaultInjection: true });
    const tenant = context();
    await control.publishCapacityPolicy(tenant, { scope: "tenant", version: 1, maxConcurrentRuns: 1, maxQueueDepth: 2, maxPromptBytes: 10_000, maxEventBytes: 20_000 });
    const admission = await control.admitCapacity(tenant, { runId: "m31-run-a", idempotencyKey: "m31-capacity-a" });
    expect(admission.allowed).toBe(true);
    await control.recordSecurityEvent(tenant, { kind: "cross_tenant_denied", severity: "P1", subjectDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", reasonCode: "TENANT_BOUNDARY" });
    const global = await control.activateKillSwitch(tenant, { scope: "global", reasonCode: "GLOBAL_INCIDENT" });

    const other = context(TENANT_B, ACTOR_B);
    expect(await control.listCapacityPolicies(other)).toHaveLength(0);
    expect(await control.listSecurityEvents(other)).toHaveLength(0);
    expect((await control.listKillSwitches(other)).some((item) => item.id === global.id)).toBe(true);
    await expect(control.assertExecutionAllowed(other, { profile: "coding" })).rejects.toThrow("PI_KILL_SWITCH_ACTIVE");

    const rls = await database.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('pi_security_events','pi_kill_switches','pi_capacity_policies','pi_capacity_leases','pi_fault_plans') ORDER BY relname");
    expect(rls.rows).toHaveLength(5);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    expect((await control.snapshot(tenant)).securityEvents.total).toBeGreaterThan(0);
    expect((await control.snapshot(other)).securityEvents.total).toBe(1);
  });
});
