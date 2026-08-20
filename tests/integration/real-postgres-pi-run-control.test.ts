// Requirements: PR-009, SR-003, SR-004, AC-006, AC-010, DR-009
// Opt-in real PostgreSQL regression. Run only against a disposable database:
// REAL_POSTGRES_PI_TEST=1 REAL_POSTGRES_PI_URL=postgres://... npx vitest run tests/integration/real-postgres-pi-run-control.test.ts
import { randomUUID } from "node:crypto";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { runMigrations } from "@/src/platform/database/migrator";
import type { MigrationDatabase, TransactionalDatabase } from "@/src/platform/database/executor";
import type { RequestContext } from "@/src/platform/context/request-context";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PiRunScheduler } from "@/src/modules/pi-agent/application/scheduler";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";

const enabled = process.env.REAL_POSTGRES_PI_TEST === "1" && Boolean(process.env.REAL_POSTGRES_PI_URL);
const realIt = enabled ? it : it.skip;

describe("real PostgreSQL Pi Run control plane", () => {
  let database: TransactionalDatabase | undefined;
  let adminDatabase: (TransactionalDatabase & MigrationDatabase) | undefined;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantC = randomUUID();
  const actorA = randomUUID();
  const actorB = randomUUID();
  const actorC = randomUUID();

  const context = (tenantId = tenantA, actorId = actorA): RequestContext => ({
    tenantId,
    actorId,
    sessionId: "real-postgres-test",
    channel: "web",
    traceId: `real-postgres-${tenantId}`,
    roles: [],
    permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute"],
    dataScopes: [{ type: "tenant" }],
  });

  beforeAll(async () => {
    if (!enabled) return;
    adminDatabase = createPostgresDatabase(process.env.REAL_POSTGRES_PI_ADMIN_URL ?? process.env.REAL_POSTGRES_PI_URL!);
    await runMigrations(adminDatabase, path.resolve("src/platform/database/migrations"));
    await adminDatabase.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,$2,'Real Pi A','active'),($3,$4,'Real Pi B','active'),($5,$6,'Real Pi C','active')", [tenantA, `real-pi-a-${tenantA.slice(0, 8)}`, tenantB, `real-pi-b-${tenantB.slice(0, 8)}`, tenantC, `real-pi-c-${tenantC.slice(0, 8)}`]);
    await adminDatabase.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Real Pi A','real-pi-a@example.test','active'),($3,$4,'Real Pi B','real-pi-b@example.test','active'),($5,$6,'Real Pi C','real-pi-c@example.test','active')", [actorA, tenantA, actorB, tenantB, actorC, tenantC]);
    database = createPostgresDatabase(process.env.REAL_POSTGRES_PI_URL!);
  });

  afterAll(async () => {
    if (database) await database.close();
    if (adminDatabase) await adminDatabase.close();
  });

  realIt("deduplicates 100 concurrent messages and keeps tenant reads isolated", async () => {
    const db = database!;
    const adminDb = adminDatabase!;
    const sessions = new PostgresPiSessionStore(db);
    const runs = new PostgresPiRunStore(db);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const created = await service.createSession(context(), { profile: "coding", workspaceId: "real-workspace-a" });
    const accepted = await Promise.all(Array.from({ length: 100 }, () => service.sendMessage(context(), created.id, "真实 PostgreSQL 幂等回归", "real-pg-idempotency-100")));

    expect(new Set(accepted.map((item) => item.runId)).size).toBe(1);
    expect(accepted.filter((item) => item.created)).toHaveLength(1);
    expect(await service.getSession(context(tenantB, actorB), created.id).catch(() => null)).toBeNull();
    const commandCount = await adminDb.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_run_commands WHERE tenant_id=$1 AND idempotency_key=$2", [tenantA, "real-pg-idempotency-100"]);
    const manifestCount = await adminDb.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_run_manifests WHERE tenant_id=$1 AND run_id=$2", [tenantA, accepted[0].runId]);
    expect(commandCount[0]?.count).toBe(1);
    expect(manifestCount[0]?.count).toBe(1);
    await expect(adminDb.query(
      "UPDATE pi_run_manifests SET run_status='completed' WHERE tenant_id=$1 AND run_id=$2",
      [tenantA, accepted[0].runId],
    )).rejects.toThrow(/PI_RUN_STATUS_TRANSITION_INVALID/);
  });

  realIt("lists a tenant-scoped backlog from durable PostgreSQL and excludes acknowledged work", async () => {
    const db = database!;
    const sessions = new PostgresPiSessionStore(db);
    const runs = new PostgresPiRunStore(db);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const backlogContext = context(tenantB, actorB);
    const created = await service.createSession(backlogContext, { profile: "coding", workspaceId: `real-backlog-${randomUUID()}` });
    const first = await service.sendMessage(backlogContext, created.id, "真实持久队列一", `real-backlog-1-${randomUUID()}`);
    const second = await service.sendMessage(backlogContext, created.id, "真实持久队列二", `real-backlog-2-${randomUUID()}`);
    const limited = await runs.listBacklog(tenantB, { limit: 1 });

    expect(limited).toHaveLength(1);
    expect([first.runId, second.runId]).toContain(limited[0]?.runId);
    expect((await runs.listBacklog(tenantB)).map((command) => command.runId)).toEqual(expect.arrayContaining([first.runId, second.runId]));
    expect((await runs.listBacklog(tenantA)).every((command) => command.tenantId === tenantA)).toBe(true);

    const lease = await runs.claim(tenantB, { workerId: `real-backlog-runner-${randomUUID()}`, leaseMs: 10_000 });
    expect((await runs.listBacklog(tenantB, { statuses: ["leased"] })).map((command) => command.id)).toEqual([lease?.id]);
    expect(await runs.acknowledge(lease!, "acknowledged")).toBe(true);
    expect((await runs.listBacklog(tenantB)).map((command) => command.id)).not.toContain(lease?.id);
    const remaining = await runs.claim(tenantB, { workerId: `real-backlog-cleanup-${randomUUID()}`, leaseMs: 10_000 });
    if (remaining) expect(await runs.acknowledge(remaining, "acknowledged")).toBe(true);
  });

  realIt("reclaims expired work and prevents the previous Runner from finalizing it", async () => {
    const db = database!;
    const sessions = new PostgresPiSessionStore(db);
    const runs = new PostgresPiRunStore(db);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const recoveryContext = context(tenantB, actorB);
    const created = await service.createSession(recoveryContext, { profile: "coding", workspaceId: "real-workspace-recovery" });
    const accepted = await service.sendMessage(recoveryContext, created.id, "真实 PostgreSQL 租约恢复", "real-pg-recovery");
    const claimedAt = new Date();
    const first = await runs.claim(tenantB, { workerId: "real-runner-crashed", leaseMs: 1_000, now: claimedAt });
    const recovered = await runs.claim(tenantB, { workerId: "real-runner-recovery", leaseMs: 10_000, now: new Date(claimedAt.getTime() + 2_000) });

    expect(first?.runId).toBe(accepted.runId);
    expect(recovered?.reclaimedFromExpiredLease).toBe(true);
    expect(await runs.updateRunStatusForLease(first!, "completed")).toBe(false);
    expect(await runs.updateRunStatusForLease(recovered!, "running")).toBe(true);
    expect(await runs.acknowledge(recovered!, "unknown")).toBe(true);
    expect(await runs.getRunStatus(recoveryContext, accepted.runId)).toBe("running");
  });

  realIt("persists cancellation commands, bounded retries and dead-letter state", async () => {
    const db = database!;
    const sessions = new PostgresPiSessionStore(db);
    const runs = new PostgresPiRunStore(db);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);

    const cancelSession = await service.createSession(context(), { profile: "coding", workspaceId: `real-cancel-${randomUUID()}` });
    const cancelRun = await service.sendMessage(context(), cancelSession.id, "可取消任务", `real-cancel-run-${randomUUID()}`);
    const cancel = await service.cancelRun(context(), cancelRun.runId, "测试取消", "real-cancel-command");
    const duplicateCancel = await service.cancelRun(context(), cancelRun.runId, "测试取消", "real-cancel-command");
    expect(cancel.created).toBe(true);
    expect(duplicateCancel).toMatchObject({ runId: cancelRun.runId, commandId: cancel.commandId, created: false });
    expect((await runs.listCommands(context(), cancelSession.id)).filter((command) => command.type === "cancel")).toHaveLength(1);

    const retryContext = context(tenantB, actorB);
    const retrySession = await service.createSession(retryContext, { profile: "coding", workspaceId: `real-retry-${randomUUID()}` });
    const retryRun = await service.sendMessage(retryContext, retrySession.id, "有限重试任务", `real-retry-run-${randomUUID()}`);
    const base = new Date();
    let lease = await runs.claim(tenantB, { workerId: "real-retry-1", leaseMs: 10_000, now: base });
    expect(lease?.runId).toBe(retryRun.runId);
    expect(await runs.requeue(lease!, { code: "PI_TEST_RETRY_1", digest: "1".repeat(64) }, new Date(base.getTime() + 1))).toBe("queued");
    lease = await runs.claim(tenantB, { workerId: "real-retry-2", leaseMs: 10_000, now: new Date(base.getTime() + 2) });
    expect(lease?.attempts).toBe(2);
    expect(await runs.requeue(lease!, { code: "PI_TEST_RETRY_2", digest: "2".repeat(64) }, new Date(base.getTime() + 3))).toBe("queued");
    lease = await runs.claim(tenantB, { workerId: "real-retry-3", leaseMs: 10_000, now: new Date(base.getTime() + 4) });
    expect(lease?.attempts).toBe(3);
    expect(await runs.updateRunStatusForLease(lease!, "failed", new Date(base.getTime() + 5))).toBe(true);
    expect(await runs.requeue(lease!, { code: "PI_TEST_RETRY_3", digest: "3".repeat(64) }, new Date(base.getTime() + 6))).toBe("dead_lettered");
    expect(await runs.claim(tenantB, { workerId: "real-retry-4", leaseMs: 10_000, now: new Date(base.getTime() + 7) })).toBeNull();
    expect((await runs.listCommands(retryContext, retrySession.id)).find((command) => command.runId === retryRun.runId)?.status).toBe("dead_lettered");
  });

  realIt("serializes competing schedulers, keeps tenant scope, and blocks claims after consumer drain", async () => {
    const db = database!;
    const sessions = new PostgresPiSessionStore(db);
    const runs = new PostgresPiRunStore(db);
    const schedulerA = new PiRunScheduler(runs, { leaseMs: 10_000, maxTenantConcurrency: 4 });
    const schedulerB = new PiRunScheduler(runs, { leaseMs: 10_000, maxTenantConcurrency: 4 });
    const schedulerContext = context(tenantC, actorC);
    const service = new PiAgentService(sessions, new VirtualSandboxProvider(), runs);
    const created = await service.createSession(schedulerContext, { profile: "coding", workspaceId: `real-scheduler-${randomUUID()}` });
    const accepted = [];
    for (let index = 0; index < 4; index += 1) {
      accepted.push(await service.sendMessage(schedulerContext, created.id, `并发调度-${index}`, `real-scheduler-${randomUUID()}`));
    }
    const claimAt = new Date(Date.now() + 2_000);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      index % 2 === 0
        ? schedulerA.claimRun(tenantC, `real-scheduler-a-${index}`, claimAt)
        : schedulerB.claimRun(tenantC, `real-scheduler-b-${index}`, claimAt)
    )));
    const claimed = claims.filter((lease): lease is NonNullable<typeof lease> => lease !== null);

    expect(claimed).toHaveLength(4);
    expect(new Set(claimed.map((lease) => lease.id)).size).toBe(4);
    expect(new Set(claimed.map((lease) => lease.runId))).toEqual(new Set(accepted.map((item) => item.runId)));
    expect(claimed.every((lease) => lease.tenantId === tenantC)).toBe(true);

    for (const lease of claimed) {
      expect(await runs.updateRunStatusForLease(lease, "provisioning")).toBe(true);
      expect(await schedulerA.complete(lease)).toBe(true);
    }
    expect((await runs.listBacklog(tenantC)).filter((command) => command.status !== "acknowledged")).toHaveLength(0);

    const drained = await service.sendMessage(schedulerContext, created.id, "排空后不得领取", `real-scheduler-drained-${randomUUID()}`);
    schedulerA.beginDrain();
    expect(await schedulerA.claimRun(tenantC, "real-scheduler-drained", new Date(Date.now() + 2_000))).toBeNull();
    expect((await runs.getCommand(schedulerContext, drained.commandId))?.status).toBe("accepted");
    expect((await runs.listBacklog(tenantA)).map((command) => command.runId)).not.toContain(drained.runId);
  });
});
