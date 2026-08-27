// Requirements: PR-001, PR-003, MR-006, MR-012, MR-022, MR-023, MR-024, AR-002, AR-003, AR-007, AR-010
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { PostgresManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/postgres-repository";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";

const tenantId = "00000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const objectiveId = "40000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";
const milestoneId = "60000000-0000-4000-8000-000000000001";
const taskId = "70000000-0000-4000-8000-000000000001";
const migrations = [
  "0001_foundation.sql", "0002_management_loop.sql", "0003_agent_platform.sql", "0004_connector_platform.sql",
  "0005_workflow_knowledge.sql", "0006_strategy_organization_talent.sql", "0007_client_platform.sql",
  "0008_security_hardening.sql", "0009_atomic_audit.sql", "0010_immutable_audit.sql", "0011_enterprise_governance.sql",
  "0012_enterprise_acceptance.sql", "0013_connector_test_notifications.sql", "0014_durable_runtime.sql",
  "0043_workflow_meeting_knowledge_completion.sql",
];

describe("Postgres management repository", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;
  let context: RequestContext;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of migrations) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    context = createDevelopmentRequestContext("trace-management-postgres-e2e");
    adapter = transactionalAdapter();
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [tenantId]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active')", [userId,tenantId]);
    await database.query(
      "INSERT INTO objectives(id,tenant_id,title,description,owner_id,status,baseline,target_value,current_value,unit,starts_at,ends_at,review_cadence) VALUES($1,$2,'交付率 95%','按期交付',$3,'active',82,95,88,'%','2026-07-01','2026-09-30','weekly')",
      [objectiveId,tenantId,userId],
    );
    await database.query(
      "INSERT INTO projects(id,tenant_id,code,name,description,owner_id,status,priority,starts_at,target_end_at,health,business_value,acceptance_criteria,resource_plan) VALUES($1,$2,'P-1','华东上线','灰度上线',$3,'active','critical','2026-07-15','2026-08-21','at_risk','完成客户交付','通过灰度验收','{}')",
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

  it("persists the complete risk-to-decision-to-action-to-evidence chain with outbox and audit facts", async () => {
    const service = new ManagementLoopService(new PostgresManagementLoopRepository(adapter));
    const risk = await service.identifyRisk(context, {
      projectId, title: "联调延迟", description: "压缩灰度窗口", ownerId: userId,
      probability: 4, impact: 4, sourceType: "human",
    });
    const decided = await service.recordDecision(context, {
      projectId, riskId: risk.id, title: "采用分批灰度", decisionContext: "联调窗口缩短",
      options: ["30% 灰度", "全量发布"], selectedOption: "30% 灰度", rationale: "限制影响面",
      actionItems: [{ title: "执行灰度", ownerId: userId, dueAt: "2026-08-27T00:00:00.000Z", acceptanceCriteria: "稳定 48 小时" }],
    });
    const completed = await service.completeAction(context, decided.actionItems[0].id, "验收单 EVIDENCE-001", 1);
    const task = await service.transitionTask(context, taskId, "in_review", 1);
    const snapshot = await service.getSnapshot(context, projectId);

    expect(snapshot).toMatchObject({ objective: { id: objectiveId }, project: { id: projectId } });
    expect(snapshot.risks).toContainEqual(expect.objectContaining({ id: risk.id, projectId }));
    expect(snapshot.decisions).toContainEqual(expect.objectContaining({ id: decided.decision.id, riskId: risk.id, ownerId: userId }));
    expect(snapshot.actionItems).toContainEqual(expect.objectContaining({
      id: completed.id, decisionId: decided.decision.id, ownerId: userId, status: "completed", completionEvidence: "验收单 EVIDENCE-001",
    }));
    expect(task).toMatchObject({ status: "in_review", version: 2 });

    const outbox = await database.query<{ event_type: string; aggregate_id: string }>(
      "SELECT event_type,aggregate_id FROM outbox_events WHERE tenant_id=$1 ORDER BY occurred_at,event_type",
      [tenantId],
    );
    expect(outbox.rows).toEqual(expect.arrayContaining([
      { event_type: "risk.identified", aggregate_id: risk.id },
      { event_type: "decision.decided", aggregate_id: decided.decision.id },
      { event_type: "action_item.completed", aggregate_id: completed.id },
      { event_type: "task.status_changed", aggregate_id: task.id },
    ]));
    const audits = await database.query<{ actor_id: string; trace_id: string; resource_type: string; metadata: Record<string,string> }>(
      "SELECT actor_id,trace_id,resource_type,metadata FROM audit_events WHERE trace_id=$1 AND resource_type IN ('risks','decisions','action_items','tasks') ORDER BY occurred_at",
      [context.traceId],
    );
    expect(audits.rows.map(({ resource_type }) => resource_type)).toEqual(expect.arrayContaining(["risks","decisions","action_items","tasks"]));
    expect(audits.rows.every((row) => row.actor_id === userId && row.trace_id === context.traceId && row.metadata.source === "atomic-database-trigger")).toBe(true);
  });

  it("rolls back the business fact when the atomic outbox insert fails", async () => {
    const failing = transactionalAdapter(true);
    const service = new ManagementLoopService(new PostgresManagementLoopRepository(failing));
    await expect(service.identifyRisk(context, {
      projectId, title: "Outbox 故障风险", description: "事务必须整体回滚", ownerId: userId,
      probability: 2, impact: 3, sourceType: "human",
    })).rejects.toThrow("OUTBOX_UNAVAILABLE");
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM risks WHERE title='Outbox 故障风险'")).rows[0].count).toBe(0);
  });

  function transactionalAdapter(failOutbox = false): TransactionalDatabase {
    const base: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await database.query<T>(sql, params as never[])).rows;
      },
    };
    return {
      ...base,
      async withTenant<T>(currentTenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        return database.transaction(async (transaction) => {
          await transaction.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.actor_type','user',true),set_config('app.channel','web',true),set_config('app.trace_id',$3,true)", [currentTenantId,context.actorId,context.traceId]);
          const scoped: DatabaseExecutor = {
            async query<R extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
              if (failOutbox && sql.includes("INSERT INTO outbox_events")) throw new Error("OUTBOX_UNAVAILABLE");
              return (await transaction.query<R>(sql, params as never[])).rows;
            },
          };
          return work(scoped);
        });
      },
      async close() { await database.close(); },
    };
  }
});
