// Requirements: AR-006, AR-009, AR-010, SR-005, SR-006, AC-013, DR-010
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { sha256 } from "@/src/modules/pi-agent/application/manifest";
import { EnterpriseModelGateway } from "@/src/modules/pi-agent/application/model-gateway";
import { PiQuotaService } from "@/src/modules/pi-agent/application/quota-service";
import { PiTelemetryService } from "@/src/modules/pi-agent/application/telemetry-evaluation";
import { PostgresPiM30Store } from "@/src/modules/pi-agent/infrastructure/m30-store";

const TENANT_A = "74000000-0000-4000-8000-000000000001";
const ACTOR_A = "74000000-0000-4000-8000-000000000002";
const TENANT_B = "74000000-0000-4000-8000-000000000011";
const ACTOR_B = "74000000-0000-4000-8000-000000000012";

function context(tenantId = TENANT_A, actorId = ACTOR_A): RequestContext {
  return { tenantId, actorId, sessionId: "74000000-0000-4000-8000-000000000099", channel: "web", traceId: `postgres-m30-${tenantId}`, roles: [], permissions: ["pi:model:read", "pi:model:admin", "pi:model:usage", "pi:usage:read", "pi:audit:read", "pi:audit:write", "pi:telemetry:write", "pi:evaluation:write", "pi:quota:read", "pi:quota:admin"], dataScopes: [{ type: "tenant" }] };
}

describe("PostgreSQL Pi M30 control plane", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const migrationDirectory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) await database.exec(await readFile(path.join(migrationDirectory, file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = { ...executor, async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]); return work(executor); }, async close() { await database.close(); } };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'m30-a','M30 A','active'),($2,'m30-b','M30 B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'M30 A','m30-a@example.test','active'),($3,$4,'M30 B','m30-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("persists routes, usage, evaluation and quota with tenant RLS", async () => {
    const store = new PostgresPiM30Store(adapter);
    const model = new EnterpriseModelGateway({ store });
    const route = await model.publishRoute(context(), { routeId: "postgres-private", version: "1.0.0", provider: "internal", model: "coding-large", region: "cn-shanghai", egress: "private", allowedDataClassifications: ["public", "internal", "confidential", "restricted"], fallbackRouteIds: [], maxInputTokens: 1000, maxOutputTokens: 500, inputCostMicrosPerMillion: 1000, outputCostMicrosPerMillion: 2000 });
    await model.approveRoute(context(), route.routeId, route.version);
    const usage = await model.recordUsage(context(), { usageId: "74000000-0000-4000-8000-000000000101", routeId: route.routeId, provider: route.provider, model: route.model, dataClassification: "internal", inputTokens: 10, outputTokens: 20, latencyMs: 30, status: "succeeded", idempotencyKey: "postgres-usage-1", traceId: sha256("postgres-trace") });
    expect(usage.costMicros).toBe(1);
    expect((await model.listRoutes(context(TENANT_B, ACTOR_B))).length).toBe(0);

    const telemetry = new PiTelemetryService(store);
    const evaluation = await telemetry.recordEvaluation(context(), { suiteId: "postgres-suite", caseId: "case-1", score: 0.5, threshold: 0.8, metricSummary: { correctness: 0.5 } });
    expect(evaluation.status).toBe("failed");
    expect((await telemetry.snapshot(context(), [usage])).alerts).toHaveLength(1);

    const quota = new PiQuotaService(store);
    const policy = await quota.publishPolicy(context(), { scope: "tenant", version: 1, maxConcurrentRuns: 1, maxTokens: 100, maxCostMicros: 1000, maxStorageBytes: 1000, maxToolCalls: 10, status: "active" });
    const reservation = await quota.reserve(context(), { policyId: policy.id, idempotencyKey: "postgres-quota-1", requested: { concurrentRuns: 1, tokens: 20, costMicros: 10, storageBytes: 1, toolCalls: 1 } });
    expect((await quota.summary(context()))[0].usage.tokens).toBe(20);
    expect((await quota.release(context(), reservation.id)).status).toBe("released");

    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_model_routes WHERE tenant_id=$1", [TENANT_A])).rows[0].count).toBe(1);
    const rls = await database.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('pi_model_routes','pi_model_usage','pi_traces','pi_telemetry_metrics','pi_evaluation_results','pi_regression_alerts','pi_quota_policies','pi_quota_reservations') ORDER BY relname");
    expect(rls.rows).toHaveLength(8);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
});
