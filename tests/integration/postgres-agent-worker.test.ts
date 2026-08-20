// Requirements: PR-005, PR-006, MR-005, AR-009, AR-010, SR-001, SR-006, AC-004, AC-005, AC-006, DR-007, DR-008
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentOrchestrator } from "@/src/modules/agent/application/orchestrator";
import { ManagementContextProvider } from "@/src/modules/agent/application/context-provider";
import { registerManagementTools } from "@/src/modules/agent/application/management-tools";
import type { ModelGateway } from "@/src/modules/agent/domain/model-gateway";
import { modelToolName, ToolRegistry } from "@/src/modules/agent/domain/tool";
import { PostgresAgentStore } from "@/src/modules/agent/infrastructure/postgres-agent-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { AgentChannelActionHandler } from "@/src/modules/integration/application/channel-action-handler";
import { createIdentityConnectorRegistry, PostgresChannelActorContextResolver } from "@/src/modules/integration/infrastructure/postgres-identity-control-plane";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { PostgresManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/postgres-repository";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { PostgresAuthorizationResolver } from "@/src/platform/identity/authorization-resolver";
import { AgentJobWorker, DurableInboundEventHandler, InboxWorker } from "@/src/platform/workers/durable-workers";
import { PostgresAgentJobRepository, PostgresInboxWorkRepository } from "@/src/platform/workers/postgres-work-repositories";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const ROLE_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const OBJECTIVE_ID = "40000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "70000000-0000-4000-8000-000000000001";

class NativeRiskModel implements ModelGateway {
  async complete() {
    return {
      content: "", provider: "scripted", model: "native-risk-test", inputTokens: 10, outputTokens: 5, latencyMs: 1,
      toolCalls: [{ id: crypto.randomUUID(), name: modelToolName("management.create_risk"), arguments: {
        projectId: PROJECT_ID,
        title: "客户验收样本仍未到位",
        description: "客户验收样本仍未到位，可能影响交付窗口。",
        ownerId: USER_ID,
        probability: 3,
        impact: 4,
        sourceType: "agent",
        riskId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
      } }],
    };
  }
}

describe("durable Agent worker journey", () => {
  let pglite: PGlite;
  let database: TransactionalDatabase;
  let orchestrator: AgentOrchestrator;
  let worker: AgentJobWorker;
  const permissions = ["project:read","objective:read","risk:read","task:read","action_item:read","risk:create"];
  const context: RequestContext = {
    tenantId: TENANT_ID,
    actorId: USER_ID,
    sessionId: "session-worker",
    channel: "web",
    traceId: "trace-worker-journey",
    roles: ["manager"],
    permissions,
    dataScopes: [{ type: "tenant" }],
  };

  beforeEach(async () => {
    pglite = new PGlite();
    const directory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
      await pglite.exec(await readFile(path.join(directory, file), "utf8"));
    }
    const executor: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await pglite.query<T>(sql, params as never[])).rows;
      },
    };
    database = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await pglite.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await pglite.close(); },
    };

    await pglite.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'agent-worker','Agent Worker','active')", [TENANT_ID]);
    await pglite.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_ID]);
    await pglite.query("INSERT INTO users(id,tenant_id,display_name,status) VALUES($1,$2,'Manager','active')", [USER_ID,TENANT_ID]);
    await pglite.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'manager','Manager')", [ROLE_ID,TENANT_ID]);
    for (const [index, code] of permissions.entries()) {
      const permissionId = `50000000-0000-4000-8000-${String(index + 1).padStart(12,"0")}`;
      await pglite.query("INSERT INTO permissions(id,code,description,risk_level) VALUES($1,$2,$2,1)", [permissionId,code]);
      await pglite.query("INSERT INTO role_permissions(tenant_id,role_id,permission_id) VALUES($1,$2,$3)", [TENANT_ID,ROLE_ID,permissionId]);
    }
    await pglite.query("INSERT INTO user_roles(id,tenant_id,user_id,role_id,scope_type,scope_value) VALUES($1,$2,$3,$4,'tenant','{}')", ["60000000-0000-4000-8000-000000000001",TENANT_ID,USER_ID,ROLE_ID]);
    await pglite.query("INSERT INTO connections(id,tenant_id,provider,name,status,secret_ref,transport_mode) VALUES($1,$2,'feishu','Primary','active','secret://worker','http')", [CONNECTION_ID,TENANT_ID]);
    await pglite.query("INSERT INTO external_identities(id,tenant_id,connection_id,provider,subject_type,external_subject_id,internal_subject_type,internal_subject_id,status,verified_at) VALUES($1,$2,$3,'feishu','user','ou_manager','user',$4,'verified',now())", ["71000000-0000-4000-8000-000000000001",TENANT_ID,CONNECTION_ID,USER_ID]);
    await pglite.query("INSERT INTO objectives(id,tenant_id,title,description,owner_id,status,starts_at,ends_at,review_cadence) VALUES($1,$2,'按期交付','可核验目标',$3,'active','2026-08-01','2026-12-31','weekly')", [OBJECTIVE_ID,TENANT_ID,USER_ID]);
    await pglite.query("INSERT INTO projects(id,tenant_id,code,name,description,owner_id,status,priority,starts_at,target_end_at,health,business_value,acceptance_criteria,resource_plan) VALUES($1,$2,'P-1','交付平台','核心项目',$3,'active','high','2026-08-01','2026-12-31','watch','完成交付','业务验收','{}')", [PROJECT_ID,TENANT_ID,USER_ID]);
    await pglite.query("INSERT INTO objective_project_links(tenant_id,objective_id,project_id) VALUES($1,$2,$3)", [TENANT_ID,OBJECTIVE_ID,PROJECT_ID]);

    const events = new PostgresEventStore(database);
    const management = new ManagementLoopService(new PostgresManagementLoopRepository(database), events);
    const contexts = new ManagementContextProvider(management);
    const tools = new ToolRegistry();
    registerManagementTools(tools, management);
    orchestrator = new AgentOrchestrator(new PostgresAgentStore(database), contexts, new NativeRiskModel(), tools);
    worker = new AgentJobWorker(new PostgresAgentJobRepository(database), new PostgresAuthorizationResolver(database), contexts, tools, 1_000);
  });

  afterEach(async () => { await pglite.close(); });

  it("queues without an HTTP side effect, executes in Worker, and replays deterministically after a crash", async () => {
    const run = await orchestrator.createRun(context, {
      message: "登记风险：客户验收样本仍未到位",
      contextRefs: [`project:${PROJECT_ID}`],
      clientRequestId: "durable-agent-journey-1",
    });
    const proposal = await orchestrator.getProposal(context, run.output!.proposalId!);
    const queued = await orchestrator.confirmProposal(context, proposal.id, proposal.proposalHash);
    expect(queued).toMatchObject({ run: { status: "queued" }, proposal: { status: "queued" }, job: { status: "queued" } });
    expect((await orchestrator.getRun(context, run.id)).output?.citations.length).toBeGreaterThan(0);
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM risks")).rows[0].count).toBe(0);

    expect(await worker.processTenant(TENANT_ID, "agent-worker-a", new Date("2030-08-05T00:00:00.000Z"))).toMatchObject({ status: "succeeded", workId: queued.job.id });
    const completed = await orchestrator.getJob(context, queued.job.id);
    expect(completed.status).toBe("succeeded");
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM risks")).rows[0].count).toBe(1);
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM outbox_events WHERE event_type='risk.identified'")).rows[0].count).toBe(1);

    await pglite.query(
      `UPDATE agent_tool_jobs SET status='executing',attempts=1,lease_owner='crashed',lease_token=$2,
         leased_at='2030-08-05T00:00:01.000Z',lease_expires_at='2030-08-05T00:00:02.000Z',completed_at=NULL
       WHERE id=$1`,
      [queued.job.id,"70000000-0000-4000-8000-000000000001"],
    );
    await pglite.query("UPDATE agent_proposals SET status='executing' WHERE id=$1", [proposal.id]);
    await pglite.query("UPDATE agent_runs SET status='executing',completed_at=NULL WHERE id=$1", [run.id]);
    await pglite.query("UPDATE tool_calls SET status='executing',completed_at=NULL WHERE agent_run_id=$1", [run.id]);

    expect(await worker.processTenant(TENANT_ID, "agent-worker-b", new Date("2030-08-05T00:00:03.000Z"))).toMatchObject({ status: "succeeded", workId: queued.job.id });
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM risks")).rows[0].count).toBe(1);
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM outbox_events WHERE event_type='risk.identified'")).rows[0].count).toBe(1);
  });

  it("re-checks current authorization and fails closed after permission revocation", async () => {
    const run = await orchestrator.createRun(context, { message: "登记风险：权限撤销旅程", contextRefs: [`project:${PROJECT_ID}`] });
    const proposal = await orchestrator.getProposal(context, run.output!.proposalId!);
    const queued = await orchestrator.confirmProposal(context, proposal.id, proposal.proposalHash);
    await pglite.query("DELETE FROM user_roles WHERE tenant_id=$1 AND user_id=$2", [TENANT_ID,USER_ID]);

    expect(await worker.processTenant(TENANT_ID, "agent-worker-revoked", new Date("2030-08-05T00:00:00.000Z"))).toMatchObject({ status: "failed", workId: queued.job.id });
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM risks")).rows[0].count).toBe(0);
    expect((await orchestrator.getJob(context, queued.job.id))).toMatchObject({ status: "failed", errorCode: "TOOL_PERMISSION_DENIED" });
  });

  it("uses the authoritative channel identity to turn a card action into one queued Agent job", async () => {
    const run = await orchestrator.createRun(context, { message: "登记风险：卡片确认旅程", contextRefs: [`project:${PROJECT_ID}`] });
    const proposal = await orchestrator.getProposal(context, run.output!.proposalId!);
    const eventStore = new PostgresEventStore(database);
    await eventStore.claimInbound({
      eventId: "card-confirm-1",
      provider: "feishu",
      connectionId: CONNECTION_ID,
      tenantId: TENANT_ID,
      eventType: "card.action",
      occurredAt: "2026-08-05T00:00:00.000Z",
      externalActor: { type: "user", id: "ou_manager" },
      payload: { actionId: `agent.confirm:${proposal.id}`, proposalHash: proposal.proposalHash, expiresAt: "2099-01-01T00:00:00.000Z" },
      rawDigest: "f".repeat(64),
      schemaVersion: 1,
      traceId: "trace-card-worker",
    });
    const authorization = new PostgresAuthorizationResolver(database);
    const channelActions = new AgentChannelActionHandler(
      createIdentityConnectorRegistry(database),
      new PostgresChannelActorContextResolver(database, authorization),
      orchestrator,
    );
    const inbox = new InboxWorker(
      new PostgresInboxWorkRepository(database),
      new DurableInboundEventHandler(channelActions, eventStore),
      1_000,
    );

    expect(await inbox.processTenant(TENANT_ID, "inbox-card", new Date("2030-08-05T00:00:00.000Z"))).toMatchObject({ status: "succeeded" });
    const jobs = await pglite.query<{ id: string; status: string }>("SELECT id::text,status FROM agent_tool_jobs WHERE proposal_id=$1", [proposal.id]);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].status).toBe("queued");
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM risks")).rows[0].count).toBe(0);

    expect(await worker.processTenant(TENANT_ID, "agent-after-card", new Date("2030-08-05T00:00:01.000Z"))).toMatchObject({ status: "succeeded", workId: jobs.rows[0].id });
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM risks")).rows[0].count).toBe(1);
  });

  it("cancels only unstarted work and keeps the cancellation idempotent", async () => {
    const run = await orchestrator.createRun(context, { message: "登记风险：尚未开始的任务应允许撤销", contextRefs: [`project:${PROJECT_ID}`] });
    const proposal = await orchestrator.getProposal(context, run.output!.proposalId!);
    const queued = await orchestrator.confirmProposal(context, proposal.id, proposal.proposalHash);
    const requestId = "81000000-0000-4000-8000-000000000001";
    const cancelled = await orchestrator.controlJob(context, queued.job.id, {
      requestId, action: "cancel", reason: "发起人确认该管理动作不再需要执行。",
    });
    expect(cancelled).toMatchObject({ created: true, job: { status: "cancelled" } });
    expect(await orchestrator.controlJob(context, queued.job.id, {
      requestId, action: "cancel", reason: "发起人确认该管理动作不再需要执行。",
    })).toMatchObject({ created: false, job: { status: "cancelled" } });
    expect(await worker.processTenant(TENANT_ID, "agent-after-cancel", new Date("2030-08-05T00:00:00.000Z"))).toMatchObject({ status: "idle" });
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM risks")).rows[0].count).toBe(0);
  });

  it("requires privileged evidence to reconcile an unknown outcome and authorizes one audited replay", async () => {
    const run = await orchestrator.createRun(context, { message: "登记风险：未知结果需要人工核验", contextRefs: [`project:${PROJECT_ID}`] });
    const proposal = await orchestrator.getProposal(context, run.output!.proposalId!);
    const queued = await orchestrator.confirmProposal(context, proposal.id, proposal.proposalHash);
    await pglite.query("UPDATE agent_tool_jobs SET status='unknown',unknown_reason='external_receipt_missing',completed_at=now() WHERE id=$1", [queued.job.id]);
    await expect(orchestrator.controlJob(context, queued.job.id, {
      requestId: "82000000-0000-4000-8000-000000000001",
      action: "retry", reason: "已核对外部平台，确认原动作没有执行。", evidenceDigest: "a".repeat(64),
    })).rejects.toThrow("AGENT_JOB_CONTROL_FORBIDDEN");

    const operator = { ...context, permissions: [...context.permissions, "agent_job:reconcile"] };
    const requestId = "82000000-0000-4000-8000-000000000002";
    const replay = await orchestrator.controlJob(operator, queued.job.id, {
      requestId,
      action: "retry",
      reason: "已核对外部平台请求记录，确认原动作没有执行。",
      evidenceDigest: "b".repeat(64),
      evidenceSummary: "平台请求日志中不存在该幂等键对应的写入回执。",
    });
    expect(replay).toMatchObject({ created: true, job: { status: "queued", resolution: { action: "retry", resolvedBy: USER_ID } } });
    expect(await orchestrator.controlJob(operator, queued.job.id, {
      requestId,
      action: "retry",
      reason: "已核对外部平台请求记录，确认原动作没有执行。",
      evidenceDigest: "b".repeat(64),
      evidenceSummary: "平台请求日志中不存在该幂等键对应的写入回执。",
    })).toMatchObject({ created: false, job: { status: "queued" } });
    await expect(orchestrator.controlJob(operator, queued.job.id, {
      requestId,
      action: "mark_succeeded",
      reason: "复用同一个请求号尝试另一种处置应被拒绝。",
      evidenceDigest: "c".repeat(64),
    })).rejects.toThrow("AGENT_JOB_RESOLUTION_CONFLICT");

    expect(await worker.processTenant(TENANT_ID, "agent-after-reconcile", new Date("2030-08-05T00:00:00.000Z"))).toMatchObject({ status: "succeeded" });
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_job_resolutions WHERE agent_tool_job_id=$1", [queued.job.id])).rows[0].count).toBe(1);
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_events WHERE resource_type='agent_job_resolutions'")).rows[0].count).toBe(1);
    expect((await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM risks")).rows[0].count).toBe(1);
  });
});
