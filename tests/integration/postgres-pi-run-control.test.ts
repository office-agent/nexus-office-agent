// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import type { RequestContext } from "@/src/platform/context/request-context";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PiRunScheduler } from "@/src/modules/pi-agent/application/scheduler";
import { SandboxOrchestrator } from "@/src/modules/pi-agent/application/sandbox-orchestrator";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { PostgresPiSandboxRunStore } from "@/src/modules/pi-agent/infrastructure/sandbox-run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";

const TENANT_A = "10000000-0000-4000-8000-000000000001";
const ACTOR_A = "10000000-0000-4000-8000-000000000002";
const TENANT_B = "10000000-0000-4000-8000-000000000011";
const ACTOR_B = "10000000-0000-4000-8000-000000000012";

const context = (tenantId = TENANT_A, actorId = ACTOR_A): RequestContext => ({
  tenantId,
  actorId,
  sessionId: "http-session",
  channel: "web",
  traceId: `trace-${tenantId}`,
  roles: [],
  permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute"],
  dataScopes: [{ type: "tenant" }],
});

describe("PostgreSQL Pi Run control plane", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const directory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
      await database.exec(await readFile(path.join(directory, file), "utf8"));
    }
    const executor: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await database.query<T>(sql, params as never[])).rows;
      },
    };
    adapter = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'pi-a','Pi A','active'),($2,'pi-b','Pi B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Pi A','pi-a@example.test','active'),($3,$4,'Pi B','pi-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("applies migration 0025, keeps event sequence current, and atomically deduplicates a Run", async () => {
    const sessions = new PostgresPiSessionStore(adapter);
    const runs = new PostgresPiRunStore(adapter);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const created = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-a" });
    const accepted = await service.sendMessage(context(), created.id, "检查代码", "pg-request-1");
    const duplicate = await service.sendMessage(context(), created.id, "检查代码", "pg-request-1");

    expect(duplicate).toMatchObject({ runId: accepted.runId, commandId: accepted.commandId, created: false });
    expect(await runs.updateRunStatus(TENANT_A, accepted.runId, "completed")).toBe(false);
    await expect(database.query(
      "UPDATE pi_run_manifests SET run_status='completed' WHERE tenant_id=$1 AND run_id=$2",
      [TENANT_A, accepted.runId],
    )).rejects.toThrow(/PI_RUN_STATUS_TRANSITION_INVALID/);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_run_manifests")).rows[0].count).toBe(1);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_run_commands")).rows[0].count).toBe(1);
    expect((await sessions.getSession(context(), created.id))?.lastEventSequence).toBe(2);
    expect((await sessions.getEvents(context(), created.id, 0, 100)).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("lists a tenant-scoped durable backlog without exposing acknowledged work", async () => {
    const sessions = new PostgresPiSessionStore(adapter);
    const runs = new PostgresPiRunStore(adapter);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const created = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-backlog" });
    const first = await service.sendMessage(context(), created.id, "持久队列一", "pg-backlog-1");
    const second = await service.sendMessage(context(), created.id, "持久队列二", "pg-backlog-2");
    const other = await service.createSession(context(TENANT_B, ACTOR_B), { profile: "coding", workspaceId: "workspace-backlog-b" });
    await service.sendMessage(context(TENANT_B, ACTOR_B), other.id, "其他租户队列", "pg-backlog-b-1");

    const limited = await runs.listBacklog(TENANT_A, { limit: 1 });
    expect(limited).toHaveLength(1);
    expect([first.runId, second.runId]).toContain(limited[0]?.runId);
    expect((await runs.listBacklog(TENANT_A)).map((command) => command.runId)).toEqual(expect.arrayContaining([first.runId, second.runId]));
    expect(await runs.listBacklog(TENANT_A, { statuses: ["acknowledged"] })).toEqual([]);
    expect((await runs.listBacklog(TENANT_B)).every((command) => command.tenantId === TENANT_B)).toBe(true);

    const lease = await runs.claim(TENANT_A, { workerId: "pg-backlog-runner", leaseMs: 10_000 });
    expect((await runs.listBacklog(TENANT_A, { statuses: ["leased"] })).map((command) => command.id)).toEqual([lease?.id]);
    expect(await runs.acknowledge(lease!, "acknowledged")).toBe(true);
    expect((await runs.listBacklog(TENANT_A)).map((command) => command.id)).not.toContain(lease?.id);
    await expect(runs.listBacklog(TENANT_A, { limit: 0 })).rejects.toThrow("PI_RUN_BACKLOG_LIMIT_INVALID");
  });

  it("uses the scheduler facade for release and atomic terminal commits", async () => {
    const sessions = new PostgresPiSessionStore(adapter);
    const runs = new PostgresPiRunStore(adapter);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const created = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-scheduler" });
    const accepted = await service.sendMessage(context(), created.id, "调度门面", "pg-scheduler-1");
    const scheduler = new PiRunScheduler(runs, { leaseMs: 10_000, maxTenantConcurrency: 1 });
    const claimedAt = new Date(Date.now() + 1_000);
    const first = await scheduler.claimRun(TENANT_A, "pg-scheduler-a", claimedAt);

    expect(first).not.toBeNull();
    expect(await scheduler.release(first!, new Date(claimedAt.getTime() + 500), claimedAt)).toBe(true);
    expect((await runs.getCommand(context(), accepted.commandId))?.status).toBe("queued");
    expect((await runs.getCommand(context(), accepted.commandId))?.attempts).toBe(1);

    const second = await scheduler.claimRun(TENANT_A, "pg-scheduler-b", new Date(claimedAt.getTime() + 2_000));
    expect(second?.attempts).toBe(2);
    expect(await scheduler.updateRunStatusForLease(second!, "running")).toBe(true);
    expect(await scheduler.complete(second!)).toBe(true);
    expect(await runs.getRunStatus(context(), accepted.runId)).toBe("completed");
    expect((await runs.getCommand(context(), accepted.commandId))?.status).toBe("acknowledged");
    expect(await scheduler.complete(second!)).toBe(false);

    const failed = await service.sendMessage(context(), created.id, "死信", "pg-scheduler-2");
    const failedLease = await scheduler.claimRun(TENANT_A, "pg-scheduler-c", new Date(Date.now() + 1_000));
    expect(await scheduler.updateRunStatusForLease(failedLease!, "provisioning")).toBe(true);
    expect(await scheduler.fail(failedLease!, { code: "PI_PG_TEST_FAILURE", digest: "f".repeat(64) })).toBe(true);
    expect(await runs.getRunStatus(context(), failed.runId)).toBe("failed");
    expect((await runs.getCommand(context(), failed.commandId))?.status).toBe("dead_lettered");
    expect((await runs.getCommand(context(), failed.commandId))?.lastErrorCode).toBe("PI_PG_TEST_FAILURE");

    const drained = await service.sendMessage(context(), created.id, "排空", "pg-scheduler-3");
    scheduler.beginDrain();
    expect(await scheduler.claimRun(TENANT_A, "pg-scheduler-drained", new Date(Date.now() + 1_000))).toBeNull();
    expect((await runs.getCommand(context(), drained.commandId))?.status).toBe("accepted");
  });

  it("enforces lease ownership, expiry recovery and tenant RLS", async () => {
    const sessions = new PostgresPiSessionStore(adapter);
    const runs = new PostgresPiRunStore(adapter);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const created = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-a" });
    const accepted = await service.sendMessage(context(), created.id, "运行检查", "pg-request-2");
    expect(await runs.getManifest(context(TENANT_B, ACTOR_B), accepted.runId)).toBeNull();
    expect(await runs.claim(TENANT_B, { workerId: "runner-b", leaseMs: 10_000 })).toBeNull();

    const first = await runs.claim(TENANT_A, { workerId: "runner-a", leaseMs: 10_000 });
    expect(first).not.toBeNull();
    expect(await runs.renew({ ...first!, leaseToken: "00000000-0000-4000-8000-000000000099" }, "runner-a", 10_000)).toBe(false);
    expect(await runs.acknowledge({ ...first!, leaseToken: "00000000-0000-4000-8000-000000000099" }, "acknowledged")).toBe(false);
    expect(await runs.updateRunStatusForLease({ ...first!, leaseToken: "00000000-0000-4000-8000-000000000099" }, "completed")).toBe(false);

    const queued = await runs.requeue(first!, { code: "PI_TEST_RETRY", digest: "a".repeat(64) }, new Date());
    expect(queued).toBe("queued");
    const second = await runs.claim(TENANT_A, { workerId: "runner-a-2", leaseMs: 10_000 });
    expect(second?.attempts).toBe(2);
    expect(await runs.acknowledge(second!, "acknowledged")).toBe(true);

    expect(await runs.listCommands(context(TENANT_B, ACTOR_B), created.id)).toEqual([]);
    expect(await sessions.getSession(context(TENANT_B, ACTOR_B), created.id)).toBeNull();
  });

  it("marks expired claims for recovery and rejects the previous Runner from status finalization", async () => {
    const sessions = new PostgresPiSessionStore(adapter);
    const runs = new PostgresPiRunStore(adapter);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const created = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-a" });
    const accepted = await service.sendMessage(context(), created.id, "恢复租约", "pg-request-recovery");
    const claimedAt = new Date();
    const first = await runs.claim(TENANT_A, { workerId: "runner-crashed", leaseMs: 1_000, now: claimedAt });
    const recovered = await runs.claim(TENANT_A, { workerId: "runner-recovery", leaseMs: 10_000, now: new Date(claimedAt.getTime() + 2_000) });

    expect(first?.runId).toBe(accepted.runId);
    expect(recovered?.reclaimedFromExpiredLease).toBe(true);
    expect(await runs.updateRunStatusForLease(first!, "completed")).toBe(false);
    expect(await runs.updateRunStatusForLease(recovered!, "running")).toBe(true);
    expect(await runs.acknowledge(recovered!, "unknown")).toBe(true);
    expect(await runs.getRunStatus(context(), accepted.runId)).toBe("running");
  });

  it("claims an interrupt command even while the tenant's prompt lease occupies its only run slot", async () => {
    const sessions = new PostgresPiSessionStore(adapter);
    const runs = new PostgresPiRunStore(adapter);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const created = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-a" });
    const accepted = await service.sendMessage(context(), created.id, "等待中断", "pg-interrupt-run");
    const promptLease = await runs.claim(TENANT_A, { workerId: "runner-prompt", leaseMs: 10_000 });
    expect(promptLease?.runId).toBe(accepted.runId);
    const interrupt = await service.interrupt(context(), created.id, "pg-interrupt-command");
    expect((await runs.getCommand(context(), interrupt.commandId))?.type).toBe("interrupt");
    const interruptLease = await runs.claim(TENANT_A, { workerId: "runner-interrupt", leaseMs: 10_000 });
    expect(interruptLease?.type).toBe("interrupt");
    expect(interruptLease?.runId).toBe(accepted.runId);
  });

  it("persists sandbox lifecycle and keeps sandbox records tenant/actor scoped", async () => {
    const sessions = new PostgresPiSessionStore(adapter);
    const runs = new PostgresPiRunStore(adapter);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const created = await service.createSession(context(), { profile: "coding", workspaceId: "workspace-a" });
    const accepted = await service.sendMessage(context(), created.id, "准备沙盒", "pg-sandbox-1");
    const sandboxRuns = new PostgresPiSandboxRunStore(adapter);
    const provider = new VirtualSandboxProvider();
    const orchestrator = new SandboxOrchestrator(provider, sandboxRuns);
    const sandboxContext = { ...context(), sessionId: created.id };
    const sandbox = await orchestrator.createSandbox(sandboxContext, {
      runId: accepted.runId,
      workspaceId: "workspace-a",
      profile: "coding",
      networkPolicy: "none",
    });
    expect(await sandboxRuns.get(context(TENANT_B, ACTOR_B), sandbox.id)).toBeNull();
    expect((await sandboxRuns.get(sandboxContext, (await sandboxRuns.list(sandboxContext, created.id))[0].id))?.status).toBe("running");
    const recoveryOrchestrator = new SandboxOrchestrator(provider, sandboxRuns);
    expect(await recoveryOrchestrator.recoverRun(sandboxContext, accepted.runId)).toBe(true);
    const record = (await sandboxRuns.list(sandboxContext, created.id))[0];
    expect(record).toMatchObject({ status: "destroyed", destroyVerified: true, providerSandboxId: sandbox.id });
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM sandbox_runs WHERE pi_run_id=$1", [accepted.runId])).rows[0].count).toBe(1);

  });
});
