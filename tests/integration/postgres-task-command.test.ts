// Requirements: PR-009, PR-010, PR-011, PR-012, MR-046, MR-047, MR-048, MR-049, MR-050, AR-002, AR-011, SR-007, AC-012, AC-013
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { PostgresTaskCommandRepository } from "@/src/modules/task-command/infrastructure/postgres-repository";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const MEMBER_ID = "10000000-0000-4000-8000-000000000003";

describe("Postgres task command repository", () => {
  let database: PGlite;
  let service: TaskCommandService;

  beforeEach(async () => {
    database = new PGlite();
    const migrations = ["0001_foundation.sql","0002_management_loop.sql","0003_agent_platform.sql","0004_connector_platform.sql","0005_workflow_knowledge.sql","0006_strategy_organization_talent.sql","0007_client_platform.sql","0008_security_hardening.sql","0009_atomic_audit.sql","0010_immutable_audit.sql","0011_enterprise_governance.sql","0012_enterprise_acceptance.sql","0013_connector_test_notifications.sql","0014_durable_runtime.sql","0015_agent_job_control.sql","0016_management_intelligence.sql","0017_work_command_center.sql","0018_work_message_pools.sql","0019_work_task_handoffs.sql","0023_work_artifact_evidence_chain.sql"];
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
    service = new TaskCommandService(new PostgresTaskCommandRepository(adapter));
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [DEMO_TENANT_ID]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active'),($3,$2,'Product','product@example.test','active')", [DEMO_MANAGER_ID,DEMO_TENANT_ID,MEMBER_ID]);
  });

  afterEach(async () => { await database.close(); });

  it("persists one primary conversation, CAS claims and atomic audit receipts", async () => {
    const publisher = createDevelopmentRequestContext("postgres-task-command");
    const firstConversation = (await service.workspace(publisher)).conversation;
    const sameConversation = (await service.workspace(publisher)).conversation;
    expect(sameConversation.id).toBe(firstConversation.id);
    const bundle = await service.publishMission(publisher, {
      conversationId: firstConversation.id,
      title: "发布验收任务",
      objective: "用持久化任务包完成客户验收。",
      priority: "high",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{
        title: "准备验收证据",
        description: "整理测试与交付证据。",
        acceptanceCriteria: "证据完整且可追溯。",
        requiredSkills: ["测试"],
        assignmentMode: "open_claim",
        priority: "high",
        dueAt: "2030-08-30T10:00:00.000Z",
        capacityPoints: 3,
      }],
    });
    const member = { ...createDevelopmentRequestContext("postgres-task-member"), actorId: MEMBER_ID };
    const task = bundle.packages[0];
    expect(await service.claimPackage(member, task.id, 1)).toMatchObject({ status: "claimed", assigneeId: MEMBER_ID, version: 2 });
    await expect(service.claimPackage(publisher, task.id, 1)).rejects.toThrow("WORK_PACKAGE_VERSION_CONFLICT");
    expect((await service.events(member, 0)).map(({ eventType }) => eventType)).toEqual(expect.arrayContaining(["mission_published","package_claimed"]));
    const audits = await database.query<{ resource_type: string }>("SELECT resource_type FROM audit_events WHERE resource_type IN ('work_conversations','work_missions','work_packages','work_task_events')");
    expect(new Set(audits.rows.map(({ resource_type }) => resource_type))).toEqual(new Set(["work_conversations","work_missions","work_packages","work_task_events"]));
  });

  it("persists non-task company communication and feedback in separately audited message tables", async () => {
    const publisher = createDevelopmentRequestContext("postgres-message-pool");
    const posted = await service.publishPoolMessage(publisher, { poolKey: "company", subject: "版本同步", content: "测试环境将在周三更新，请在本条下反馈影响。" });
    const feedback = await service.appendPoolFeedback(publisher, { messageId: posted.message.id, content: "已确认产品侧无影响。" });
    const workspace = await service.workspace(publisher);
    expect(workspace.messagePools.find(({ key }) => key === "company")?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: posted.message.id, feedback: [expect.objectContaining({ id: feedback.id })] }),
    ]));
    expect(await service.messageEvents(publisher, 0)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "message_published", messageId: posted.message.id }),
      expect.objectContaining({ eventType: "feedback_published", messageId: posted.message.id }),
    ]));
    const audits = await database.query<{ resource_type: string }>("SELECT resource_type FROM audit_events WHERE resource_type IN ('work_pool_messages','work_pool_feedback','work_message_events')");
    expect(new Set(audits.rows.map(({ resource_type }) => resource_type))).toEqual(new Set(["work_pool_messages","work_pool_feedback","work_message_events"]));
  });

  it("persists a signed task handoff chain, artifact snapshot and atomic responsibility switch", async () => {
    const publisher = createDevelopmentRequestContext("postgres-task-handoff");
    const conversation = (await service.workspace(publisher)).conversation;
    const task = (await service.publishMission(publisher, {
      conversationId: conversation.id, title: "持久化交接", objective: "验证任务交接在同一事务中保存责任与资料快照。", priority: "high", dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{ title: "交接验收资料", description: "由接收人继续完成资料复核。", acceptanceCriteria: "资料、责任和交接链完整可查。", requiredSkills: ["交付"], assignmentMode: "direct", assigneeId: DEMO_MANAGER_ID, priority: "high", dueAt: "2030-08-30T10:00:00.000Z", capacityPoints: 2 }],
    })).packages[0];
    const registered = await service.registerTaskArtifact(publisher, {
      title: "验收资料包", fileName: "acceptance-v1.zip", mediaType: "application/zip",
      contentDigest: "a".repeat(64), storageRef: "object://controlled/acceptance-v1.zip", classification: "internal",
    });
    const requested = await service.initiateTaskHandoff(publisher, {
      taskId: task.id, expectedVersion: 1, toAssigneeId: MEMBER_ID, note: "资料已归档，请接续进行产品验收复核。", artifactIds: [registered.artifact.id],
    });
    const recipient = { ...createDevelopmentRequestContext("postgres-task-handoff-recipient"), actorId: MEMBER_ID };
    const accepted = await service.respondToTaskHandoff(recipient, requested.handoff.id, { expectedVersion: 1, decision: "accept" });
    expect(accepted).toMatchObject({ handoff: { status: "accepted", snapshot: { packageVersion: 1 }, artifactSnapshots: [{ artifactId: registered.artifact.id, version: 1, contentDigest: "a".repeat(64) }] }, task: { assigneeId: MEMBER_ID, version: 2 } });
    await service.appendTaskArtifactVersion(publisher, registered.artifact.id, {
      expectedVersion: 1, fileName: "acceptance-v2.zip", mediaType: "application/zip", contentDigest: "b".repeat(64), storageRef: "object://controlled/acceptance-v2.zip",
    });
    expect((await service.taskHandoffTrail(publisher, task.id)).handoffs[0].artifactSnapshots).toMatchObject([{ artifactId: registered.artifact.id, version: 1, contentDigest: "a".repeat(64) }]);
    expect((await service.taskHandoffTrail(publisher, task.id)).handoffs).toEqual([expect.objectContaining({ id: requested.handoff.id, status: "accepted" })]);
    const audits = await database.query<{ resource_type: string }>("SELECT resource_type FROM audit_events WHERE resource_type IN ('work_task_handoffs','work_packages','work_task_events')");
    expect(audits.rows.map(({ resource_type }) => resource_type)).toEqual(expect.arrayContaining(["work_task_handoffs", "work_packages", "work_task_events"]));
  });
});
