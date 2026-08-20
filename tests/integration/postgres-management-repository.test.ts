// Requirements: PR-001, PR-003, MR-006, MR-012, MR-022, MR-023, MR-024, AR-002, AR-003, AR-007
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { PostgresManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/postgres-repository";

const tenantId = "00000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const objectiveId = "40000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";
const milestoneId = "60000000-0000-4000-8000-000000000001";
const taskId = "70000000-0000-4000-8000-000000000001";

describe("Postgres management repository", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of ["0001_foundation.sql", "0002_management_loop.sql", "0003_agent_platform.sql", "0004_connector_platform.sql", "0005_workflow_knowledge.sql", "0006_strategy_organization_talent.sql"]) {
      await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    }
    const executor: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await database.query<T>(sql, params as never[])).rows;
      },
    };
    adapter = {
      ...executor,
      async withTenant<T>(currentTenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id', $1, false)", [currentTenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [tenantId]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active')", [userId,tenantId]);
    await database.query(
      "INSERT INTO objectives(id,tenant_id,title,description,owner_id,status,baseline,target_value,current_value,unit,starts_at,ends_at,review_cadence) VALUES($1,$2,'交付率 95%','按期交付',$3,'active',82,95,88,'%','2026-07-01','2026-09-30','weekly')",
      [objectiveId,tenantId,userId],
    );
    await database.query(
      "INSERT INTO projects(id,tenant_id,code,name,description,owner_id,status,priority,starts_at,target_end_at,health) VALUES($1,$2,'P-1','华东上线','灰度上线',$3,'active','critical','2026-07-15','2026-08-21','at_risk')",
      [projectId,tenantId,userId],
    );
    await database.query("INSERT INTO objective_project_links(tenant_id,objective_id,project_id) VALUES($1,$2,$3)", [tenantId,objectiveId,projectId]);
    await database.query(
      "INSERT INTO milestones(id,tenant_id,project_id,name,owner_id,due_at,status,acceptance_criteria) VALUES($1,$2,$3,'灰度验收',$4,'2026-08-21','active','客户签字')",
      [milestoneId,tenantId,projectId,userId],
    );
    await database.query(
      "INSERT INTO tasks(id,tenant_id,project_id,milestone_id,title,assignee_id,status,priority,due_at) VALUES($1,$2,$3,$4,'联调回归',$5,'in_progress','high','2026-08-06T10:00:00+08:00')",
      [taskId,tenantId,projectId,milestoneId,userId],
    );
  });

  afterEach(async () => { await database.close(); });

  it("reads and writes the complete tenant-scoped snapshot", async () => {
    const repository = new PostgresManagementLoopRepository(adapter);
    await repository.saveRisk({
      id: "50000000-0000-4000-8000-000000000001", tenantId, projectId, title: "联调延迟",
      description: "压缩灰度窗口", ownerId: userId, probability: 4, impact: 4, status: "assessed",
      sourceType: "human", version: 1,
    });
    const task = await repository.getTask(tenantId, taskId);
    expect(task).not.toBeNull();
    await repository.saveTask({ ...task!, status: "in_review", version: task!.version + 1 });
    const snapshot = await repository.getSnapshot(tenantId, projectId);
    expect(snapshot).toMatchObject({
      objective: { id: objectiveId, currentValue: 88 },
      project: { id: projectId, health: "at_risk" },
    });
    expect(snapshot?.risks[0]).toMatchObject({ title: "联调延迟", probability: 4, impact: 4 });
    expect(snapshot?.tasks[0]).toMatchObject({ status: "in_review", version: 2 });
    expect(snapshot?.milestones[0].name).toBe("灰度验收");
  });
});
