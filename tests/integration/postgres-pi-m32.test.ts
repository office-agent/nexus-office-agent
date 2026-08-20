// Requirements: PR-001, PR-008, SR-005, AC-006, AC-010, DR-010
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { PiPreproductionService, type PiPreproductionProbe } from "@/src/modules/pi-agent/application/preproduction-service";
import { PostgresPiPreproductionStore } from "@/src/modules/pi-agent/infrastructure/m32-store";
import type { PiReadinessCheck } from "@/src/modules/pi-agent/domain/preproduction-contracts";

const TENANT_A = "77000000-0000-4000-8000-000000000001";
const ACTOR_A = "77000000-0000-4000-8000-000000000002";
const TENANT_B = "77000000-0000-4000-8000-000000000011";
const ACTOR_B = "77000000-0000-4000-8000-000000000012";
const DIGEST = "e".repeat(64);

function context(tenantId = TENANT_A, actorId = ACTOR_A): RequestContext {
  return { tenantId, actorId, sessionId: "77000000-0000-4000-8000-000000000099", channel: "web", traceId: `postgres-m32-${tenantId}`, roles: [], permissions: ["pi:release:propose", "pi:preproduction:read", "pi:secret:lease", "pi:secret:revoke"], dataScopes: [{ type: "tenant" }] };
}

class PassingProbe implements PiPreproductionProbe {
  async probe(): Promise<PiReadinessCheck[]> {
    return [{ id: "runtime.workers", category: "operations", status: "pass", message: "测试 Worker 探针通过。", evidenceDigest: DIGEST }];
  }
}

describe("PostgreSQL Pi M32 preproduction control plane", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const migrationDirectory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) await database.exec(await readFile(path.join(migrationDirectory, file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = { ...executor, async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]); return work(executor); }, async close() { await database.close(); } };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'m32-a','M32 A','active'),($2,'m32-b','M32 B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'M32 A','m32-a@example.test','active'),($3,$4,'M32 B','m32-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("enforces tenant RLS across release, readiness, leases and events", async () => {
    const service = new PiPreproductionService(new PostgresPiPreproductionStore(adapter), new PassingProbe());
    const owner = context();
    const candidate = await service.registerRelease(owner, { version: "0.21.0", imageDigest: DIGEST, manifestDigest: "f".repeat(64), signatureDigest: "1".repeat(64) }, "m32-release-a");
    expect((await service.evaluateReadiness(owner, candidate.id)).ready).toBe(true);
    expect((await service.promoteRelease(owner, candidate.id)).status).toBe("active");
    const lease = await service.issueSecretLease(owner, { reference: `secret://tenants/${TENANT_A}/runner/provider`, purpose: "runner", audience: "pi-runner", ttlSeconds: 60 });

    const other = context(TENANT_B, ACTOR_B);
    expect(await service.listReleases(other)).toHaveLength(0);
    expect(await service.listReadiness(other)).toHaveLength(0);
    expect(await service.listSecretLeases(other)).toHaveLength(0);
    expect(await service.listEvents(other)).toHaveLength(0);
    await expect(service.promoteRelease(other, candidate.id)).rejects.toThrow("PI_RELEASE_NOT_FOUND");
    await expect(service.revokeSecretLease(other, lease.id)).rejects.toThrow("PI_SECRET_LEASE_NOT_FOUND");

    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_B]);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_release_candidates WHERE tenant_id=$1", [TENANT_B])).rows[0].count).toBe(0);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_readiness_snapshots WHERE tenant_id=$1", [TENANT_B])).rows[0].count).toBe(0);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_secret_leases WHERE tenant_id=$1", [TENANT_B])).rows[0].count).toBe(0);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_preproduction_events WHERE tenant_id=$1", [TENANT_B])).rows[0].count).toBe(0);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_release_candidates WHERE tenant_id=$1", [TENANT_A])).rows[0].count).toBe(1);
    expect((await database.query<{ reference_digest: string }>("SELECT reference_digest FROM pi_secret_leases")).rows[0].reference_digest).not.toContain("secret://");

    const rls = await database.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('pi_release_candidates','pi_readiness_snapshots','pi_secret_leases','pi_preproduction_events') ORDER BY relname");
    expect(rls.rows).toHaveLength(4);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
});
