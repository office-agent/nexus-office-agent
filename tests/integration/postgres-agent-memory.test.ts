// Requirements: PR-006, PR-009, MR-050, AR-012, SR-002, SR-003, AC-007
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMemoryService } from "@/src/modules/agent-memory/application/service";
import { PostgresAgentMemoryRepository } from "@/src/modules/agent-memory/infrastructure/postgres-repository";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const MEMBER_ID = "10000000-0000-4000-8000-000000000003";

describe("PostgreSQL tiered Agent memory", () => {
  let database: PGlite;
  let service: AgentMemoryService;

  beforeEach(async () => {
    database = new PGlite();
    const migrations = ["0001_foundation.sql","0002_management_loop.sql","0003_agent_platform.sql","0004_connector_platform.sql","0005_workflow_knowledge.sql","0006_strategy_organization_talent.sql","0007_client_platform.sql","0008_security_hardening.sql","0009_atomic_audit.sql","0010_immutable_audit.sql","0011_enterprise_governance.sql","0012_enterprise_acceptance.sql","0013_connector_test_notifications.sql","0014_durable_runtime.sql","0015_agent_job_control.sql","0016_management_intelligence.sql","0017_work_command_center.sql","0018_work_message_pools.sql","0019_work_task_handoffs.sql","0020_wecom_access_control_permissions.sql","0021_wecom_application_message_permission.sql","0022_agent_memory.sql"];
    for (const file of migrations) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    const adapter: TransactionalDatabase = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };
    service = new AgentMemoryService(new PostgresAgentMemoryRepository(adapter));
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [DEMO_TENANT_ID]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active'),($3,$2,'Member','member@example.test','active')", [DEMO_MANAGER_ID,DEMO_TENANT_ID,MEMBER_ID]);
  });

  afterEach(async () => { await database.close(); });

  it("persists long-term, task and handoff memories with source idempotency and an immutable audit trail", async () => {
    const context = createDevelopmentRequestContext("postgres-memory");
    const longTerm = await service.remember(context, {
      summary: "项目周报固定在每周五 16:00 前提交。", scopeType: "user", visibility: "private", classification: "internal",
      importance: 80, confidence: 100, sourceRefs: ["policy:weekly-report"],
    });
    const firstTask = await service.captureTask(context, {
      taskId: "71000000-0000-4000-8000-000000000001", taskVersion: 1, runId: "72000000-0000-4000-8000-000000000001",
      summary: "整理验收证据，当前进行中。", sourceRefs: ["work_package:71000000-0000-4000-8000-000000000001"],
    });
    const refreshedTask = await service.captureTask(context, {
      taskId: "71000000-0000-4000-8000-000000000001", taskVersion: 2, runId: "72000000-0000-4000-8000-000000000002",
      summary: "整理验收证据，当前待复核。", sourceRefs: ["work_package:71000000-0000-4000-8000-000000000001","evidence:acceptance-v2"],
    });
    if (!firstTask || !refreshedTask) throw new Error("Expected non-sensitive task memories to persist");
    const handoff = await service.captureTaskHandoff(context, {
      taskId: firstTask.scopeId, handoffId: "73000000-0000-4000-8000-000000000001", runId: "72000000-0000-4000-8000-000000000003",
      summary: "交付负责人已接收验收资料，等待签收。", sourceRefs: ["work_task_handoff:73000000-0000-4000-8000-000000000001"],
    });
    if (!handoff) throw new Error("Expected non-sensitive handoff memory to persist");
    expect(refreshedTask).toMatchObject({ id: firstTask.id, version: 2, summary: "整理验收证据，当前待复核。" });
    expect((await service.recall(context, { query: "周报", includeShared: true, limit: 10 })).map(({ id }) => id)).toContain(longTerm.id);
    const memoryContext = await service.context(context, { query: "验收资料", taskIds: [firstTask.scopeId], limit: 10 });
    expect(memoryContext.entries.map(({ id }) => id)).toEqual(expect.arrayContaining([refreshedTask.id, handoff.id]));
    const audits = await database.query<{ resource_type: string }>("SELECT resource_type FROM audit_events WHERE resource_type='agent_memory_entries'");
    expect(audits.rows.length).toBeGreaterThanOrEqual(4);
  });
});
