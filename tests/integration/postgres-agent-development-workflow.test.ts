// Requirements: PR-008, MR-050, AR-003, AR-005
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentDevelopmentService } from "@/src/modules/agent-development/application/service";
import { PostgresAgentDevelopmentStore } from "@/src/modules/agent-development/infrastructure/postgres-store";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import type { RequestContext } from "@/src/platform/context/request-context";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const ACTOR_A = "10000000-0000-4000-8000-000000000001";
const ACTOR_B = "10000000-0000-4000-8000-000000000002";

function context(tenantId: string, actorId: string): RequestContext {
  return { tenantId, actorId, sessionId: "postgres-development-workflow", channel: "web", traceId: `trace-${tenantId}`, roles: ["enterprise_manager"], permissions: ["agent_development:read", "agent_development:write", "agent_development:deliver"], dataScopes: [{ type: "tenant" }] };
}

describe("Postgres Agent development workflow", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;
  beforeEach(async () => {
    database = new PGlite();
    for (const file of ["0001_foundation.sql", "0009_atomic_audit.sql", "0010_immutable_audit.sql", "0044_agent_development_workflow.sql"]) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        return database.transaction(async (transaction) => {
          await transaction.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
          const scoped: DatabaseExecutor = { async query<R extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await transaction.query<R>(sql, params as never[])).rows; } };
          return work(scoped);
        });
      },
      async close() { await database.close(); },
    };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'a','A','active'),($2,'b','B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'A','a@example.test','active')", [ACTOR_A, TENANT_A]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_B]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'B','b@example.test','active')", [ACTOR_B, TENANT_B]);
  });
  afterEach(async () => { await database.close(); });

  it("persists the complete gated delivery and isolates it from another tenant", async () => {
    const service = new AgentDevelopmentService(new PostgresAgentDevelopmentStore(adapter));
    const a = context(TENANT_A, ACTOR_A);
    const archived = await service.handoff(a, { code: "PG-AGENT", name: "Postgres Agent Flow", owner: "研发平台", objective: "持久化研发门禁", scope: ["归档", "交付"], nonGoals: [], acceptanceCriteria: ["逐版本测试"] }, "pg-handoff");
    const versioned = await service.recordVersion(a, archived.id, { projectVersion: archived.version, name: "1.0.0", fromCommit: "a".repeat(40), toCommit: "b".repeat(40), diffContent: "+gated", features: ["持久门禁"] }, "pg-version");
    const replayed = await service.recordVersion(a, archived.id, { projectVersion: archived.version, name: "1.0.0", fromCommit: "a".repeat(40), toCommit: "b".repeat(40), diffContent: "+gated", features: ["持久门禁"] }, "pg-version");
    expect(replayed.versions).toHaveLength(1);
    expect(replayed.version).toBe(versioned.version);
    const tested = await service.recordTest(a, archived.id, { projectVersion: versioned.version, versionId: versioned.versions[0].id, name: "Postgres 功能回归", cases: ["完整旅程"], result: "passed", evidence: "1 passed" }, "pg-test");
    const delivered = await service.deliver(a, archived.id, tested.version, "pg-delivery");
    expect(delivered.status).toBe("delivered");
    expect(delivered.documents).toHaveLength(5);
    expect(delivered.delivery?.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await service.snapshot(context(TENANT_B, ACTOR_B))).projects).toHaveLength(0);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    expect(Number((await database.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_events WHERE resource_type LIKE 'agent_development_%'")).rows[0].count)).toBeGreaterThanOrEqual(20);
  });
});
