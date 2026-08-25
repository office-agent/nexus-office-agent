// Requirements: MR-016, MR-017, MR-018, MR-019, MR-020, MR-021, MR-022, MR-023, MR-024, MR-025, AR-002, AR-003, AR-004, AC-002
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { WorkflowService } from "@/src/modules/workflow/application/service";
import { PostgresWorkflowRepository } from "@/src/modules/workflow/infrastructure/postgres-repository";
import { KnowledgeService } from "@/src/modules/knowledge/application/service";
import { PostgresKnowledgeRepository } from "@/src/modules/knowledge/infrastructure/postgres-repository";
import { MeetingService } from "@/src/modules/collaboration/application/meeting-service";
import { PostgresMeetingRepository } from "@/src/modules/collaboration/infrastructure/postgres-meeting-repository";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { PostgresManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/postgres-repository";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";
import type { RequestContext } from "@/src/platform/context/request-context";

const tenantId = "00000000-0000-4000-8000-000000000001";
const managerId = "10000000-0000-4000-8000-000000000001";
const requesterId = "10000000-0000-4000-8000-000000000002";
const objectiveId = "40000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";

function context(actorId: string, permissions: string[]): RequestContext {
  return { ...createDevelopmentRequestContext(), actorId, permissions, dataScopes: [{ type: "tenant" }] };
}

describe("Postgres workflow, meeting and knowledge repositories", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of ["0001_foundation.sql","0002_management_loop.sql","0003_agent_platform.sql","0004_connector_platform.sql","0005_workflow_knowledge.sql","0006_strategy_organization_talent.sql"]) {
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
    await database.query(
      "INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$3,'Manager','manager@example.test','active'),($2,$3,'Requester','requester@example.test','active')",
      [managerId,requesterId,tenantId],
    );
    await database.query(
      "INSERT INTO objectives(id,tenant_id,title,description,owner_id,status,starts_at,ends_at) VALUES($1,$2,'交付率','按期交付',$3,'active','2026-07-01','2026-09-30')",
      [objectiveId,tenantId,managerId],
    );
    await database.query(
      "INSERT INTO projects(id,tenant_id,code,name,owner_id,status,priority,starts_at,target_end_at,health) VALUES($1,$2,'P-1','华东上线',$3,'active','critical','2026-07-15','2026-08-21','at_risk')",
      [projectId,tenantId,managerId],
    );
    await database.query("INSERT INTO objective_project_links(tenant_id,objective_id,project_id) VALUES($1,$2,$3)", [tenantId,objectiveId,projectId]);
  });

  afterEach(async () => { await database.close(); });

  it("persists process definition versions and pins instances", async () => {
    const repository = new PostgresWorkflowRepository(adapter);
    const service = new WorkflowService(repository, new InMemoryEventStore());
    const admin = context(managerId, ["process_definition:admin","approval:approve","process_instance:read"]);
    const requester = context(requesterId, ["process_instance:create","process_instance:read"]);
    const first = await service.publishDefinition(admin, {
      code: "BUDGET", name: "预算审批", startNodeKey: "review",
      nodes: [
        { key: "review", type: "approval", name: "负责人审批", approverIds: [managerId], mode: "all", next: "done", slaHours: 24 },
        { key: "done", type: "end", name: "完成", outcome: "approved" },
      ],
    });
    const started = await service.startProcess(requester, { definitionId: first.definition.id, title: "预算追加", form: { amount: 1000 }, riskLevel: 3 });
    await service.publishDefinition(admin, {
      definitionId: first.definition.id, code: "BUDGET", name: "预算审批", startNodeKey: "review2",
      nodes: [
        { key: "review2", type: "approval", name: "新审批", approverIds: [managerId], mode: "all", next: "done", slaHours: 12 },
        { key: "done", type: "end", name: "完成", outcome: "approved" },
      ],
    });
    expect((await repository.getInstance(tenantId, started.instance.id))?.definitionVersion).toBe(1);
    const decided = await service.decide(admin, started.approvals[0].id, { decision: "approve", comment: "同意", version: 1 });
    expect(decided.instance.status).toBe("approved");
    const versions = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM process_definition_versions");
    expect(versions.rows[0].count).toBe(2);
  });

  it("invalidates old knowledge chunks and searches only the current version", async () => {
    const service = new KnowledgeService(new PostgresKnowledgeRepository(adapter));
    const owner = context(managerId, ["document:create","document:update","document:read"]);
    const first = await service.publish(owner, { title: "安全制度", content: "生产导出需要审批。", classification: "internal" });
    await service.publish(owner, { documentId: first.document.id, title: "安全制度", content: "生产导出需要双人审批并保留审计。", classification: "internal" });
    const results = await service.search(owner, "生产导出 审批");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ documentVersion: 2, untrustedContent: true });
    const states = await database.query<{ status: string; count: number }>("SELECT status,count(*)::int AS count FROM knowledge_items GROUP BY status ORDER BY status");
    expect(states.rows).toEqual([{ status: "active", count: 1 }, { status: "invalidated", count: 1 }]);
  });

  it("materializes a confirmed meeting outcome idempotently", async () => {
    const meetingRepository = new PostgresMeetingRepository(adapter);
    const managementRepository = new PostgresManagementLoopRepository(adapter);
    const knowledge = new KnowledgeService(new PostgresKnowledgeRepository(adapter));
    const service = new MeetingService(meetingRepository, new ManagementLoopService(managementRepository), knowledge, new InMemoryEventStore());
    const meeting = {
      id: "84000000-0000-4000-8000-000000000099", tenantId, projectId, title: "发布决策会", organizerId: managerId,
      participantIds: [managerId], requiredConfirmerIds: [managerId], confirmedByIds: [], startsAt: "2026-08-05T03:00:00.000Z",
      status: "pending_confirmation" as const,
      draftMinutes: {
        discussions: ["讨论灰度"], conclusions: ["采用 30% 灰度"], openQuestions: [],
        decisions: [{ topic: "灰度范围", context: "控制风险", options: ["30%", "100%"], selectedOption: "30%", rationale: "限制影响面", actionItems: [{ title: "执行灰度", ownerId: managerId, dueAt: "2026-08-06T03:00:00.000Z", acceptanceCriteria: "稳定 48 小时" }] }],
      },
      outcomeStatus: "not_ready" as const, version: 1,
    };
    expect(await meetingRepository.saveMeeting(meeting)).toBe(true);
    expect((await meetingRepository.listMeetings(tenantId, managerId)).map(({ id }) => id)).toContain(meeting.id);
    const manager = createDevelopmentRequestContext();
    const confirmed = await service.confirm(manager, meeting.id, 1);
    expect(confirmed.meeting.outcomeStatus).toBe("materialized");
    await service.confirm(manager, meeting.id, confirmed.meeting.version);
    const counts = await database.query<{ decisions: number; actions: number }>("SELECT (SELECT count(*)::int FROM decisions) AS decisions,(SELECT count(*)::int FROM action_items) AS actions");
    expect(counts.rows[0]).toEqual({ decisions: 1, actions: 1 });
  });
});
