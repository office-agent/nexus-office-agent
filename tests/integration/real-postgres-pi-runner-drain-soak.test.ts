// Requirements: PR-009, SR-003, SR-004, AC-010, DR-009, DR-014
// Opt-in real PostgreSQL Runner drain and bounded soak regression. Run only
// against a disposable database with REAL_POSTGRES_PI_TEST=1.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { runMigrations } from "@/src/platform/database/migrator";
import type { MigrationDatabase, TransactionalDatabase } from "@/src/platform/database/executor";
import type { RequestContext } from "@/src/platform/context/request-context";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";

const enabled = process.env.REAL_POSTGRES_PI_TEST === "1" && Boolean(process.env.REAL_POSTGRES_PI_URL);
const realIt = enabled ? it : it.skip;
const execFileAsync = promisify(execFile);
const SOAK_RUN_COUNT = 48;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(75);
  }
  throw new Error("REAL_PI_RUNNER_DRAIN_SOAK_WAIT_TIMEOUT");
}

async function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("REAL_PI_RUNNER_EXIT_TIMEOUT")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

type TenantFixture = {
  tenantId: string;
  actorId: string;
  context: RequestContext;
  service: PiAgentService;
};

describe("real PostgreSQL Pi Runner drain and bounded soak", () => {
  let database: TransactionalDatabase | undefined;
  let adminDatabase: (TransactionalDatabase & MigrationDatabase) | undefined;
  let runner: ChildProcess | undefined;
  let bundlePath = "";
  const shutdownFiles = new Set<string>();

  async function createTenantFixture(label: string): Promise<TenantFixture> {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    await adminDatabase!.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,$2,$3,'active')", [tenantId, `real-${label}-${tenantId.slice(0, 8)}`, `Real ${label}`]);
    await adminDatabase!.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,$3,$4,'active')", [actorId, tenantId, `Runner ${label}`, `${label}-${tenantId.slice(0, 8)}@example.test`]);
    const context: RequestContext = {
      tenantId,
      actorId,
      sessionId: `http-${label}-${tenantId}`,
      channel: "web",
      traceId: `real-runner-${label}-${tenantId}`,
      roles: [],
      permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute"],
      dataScopes: [{ type: "tenant" }],
    };
    return { tenantId, actorId, context, service: new PiAgentService(new PostgresPiSessionStore(database!), new VirtualSandboxProvider(), new PostgresPiRunStore(database!)) };
  }

  function runnerEnvironment(instanceId: string, autoCompleteMs: number, shutdownFile?: string): NodeJS.ProcessEnv {
    const environment = {
      ...process.env,
      DATABASE_URL: process.env.REAL_POSTGRES_PI_URL!,
      NODE_ENV: "development",
      NEXUS_PI_TEST_RUNTIME: "cooperative",
      NEXUS_PI_SANDBOX_PROVIDER: "virtual",
      NEXUS_PI_TEST_RUNTIME_AUTO_COMPLETE_MS: String(autoCompleteMs),
      WORKER_LEASE_MS: "3000",
      WORKER_POLL_INTERVAL_MS: "25",
      WORKER_HEARTBEAT_INTERVAL_MS: "500",
      WORKER_MAX_ITEMS_PER_ROLE: "1",
      WORKER_INSTANCE_ID: instanceId,
      NEXUS_RELEASE_VERSION: "real-runner-drain-soak",
      ...(shutdownFile ? { NEXUS_PI_TEST_SHUTDOWN_FILE: shutdownFile } : {}),
    } as NodeJS.ProcessEnv;
    delete environment.NEXUS_PI_FAULT_INJECTION;
    delete environment.NEXUS_PI_FAULT_POINT;
    delete environment.NEXUS_PI_FAULT_ACTION;
    return environment;
  }

  async function command(runId: string): Promise<{ status: string; attempts: number; last_error_code: string | null }> {
    const rows = await adminDatabase!.query<{ status: string; attempts: number; last_error_code: string | null }>("SELECT status,attempts,last_error_code FROM pi_run_commands WHERE run_id=$1", [runId]);
    if (!rows[0]) throw new Error(`REAL_PI_COMMAND_NOT_FOUND:${runId}`);
    return rows[0];
  }

  beforeAll(async () => {
    if (!enabled) return;
    adminDatabase = createPostgresDatabase(process.env.REAL_POSTGRES_PI_ADMIN_URL ?? process.env.REAL_POSTGRES_PI_URL!);
    await runMigrations(adminDatabase, path.resolve("src/platform/database/migrations"));
    database = createPostgresDatabase(process.env.REAL_POSTGRES_PI_URL!);
    const bundleDirectory = path.resolve(".next-build-real-pi-runner-drain-soak");
    await mkdir(bundleDirectory, { recursive: true });
    bundlePath = path.join(bundleDirectory, "pi-runner.mjs");
    await execFileAsync(process.execPath, [
      "node_modules/esbuild/bin/esbuild",
      "scripts/pi-runner.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${bundlePath}`,
      "--external:@earendil-works/pi-ai",
      "--external:@earendil-works/pi-coding-agent",
    ], { cwd: process.cwd(), env: process.env });
  });

  afterAll(async () => {
    if (runner && runner.exitCode === null) runner.kill("SIGKILL");
    if (runner && runner.exitCode === null) await waitForExit(runner, 5_000).catch(() => undefined);
    await Promise.all([...shutdownFiles].map((file) => unlink(file).catch(() => undefined)));
    if (database) await database.close();
    if (adminDatabase) await adminDatabase.close();
  });

  realIt("publishes draining before waiting, does not claim queued work, and marks started work unknown", async () => {
    const fixture = await createTenantFixture("drain");
    const session = await fixture.service.createSession(fixture.context, { profile: "coding", workspaceId: "drain-workspace" });
    const active = await fixture.service.sendMessage(fixture.context, session.id, "保持运行以验证 graceful drain", `drain-active-${randomUUID()}`);
    const queued = await fixture.service.sendMessage(fixture.context, session.id, "排在活动任务之后", `drain-queued-${randomUUID()}`);
    const instanceId = `drain-${fixture.tenantId.slice(0, 8)}`;
    const shutdownFile = path.join(path.dirname(bundlePath), `drain-${fixture.tenantId}.signal`);
    shutdownFiles.add(shutdownFile);
    await unlink(shutdownFile).catch(() => undefined);
    runner = spawn(process.execPath, [bundlePath], { cwd: process.cwd(), env: runnerEnvironment(instanceId, 60_000, shutdownFile), stdio: "ignore" });

    await waitFor(async () => {
      const rows = await adminDatabase!.query<{ status: string }>("SELECT run_status AS status FROM pi_run_manifests WHERE run_id=$1", [active.runId]);
      return rows[0]?.status === "running";
    });
    expect((await command(queued.runId)).attempts).toBe(0);

    await writeFile(shutdownFile, "shutdown\n", "utf8");
    await waitFor(async () => {
      const rows = await adminDatabase!.query<{ draining: boolean }>("SELECT draining FROM worker_heartbeats WHERE role='pi-runner' AND instance_id=$1", [`${instanceId}:pi-runner`]);
      return rows[0]?.draining === true;
    });
    const exit = await waitForExit(runner);
    expect(exit.code).toBe(0);

    const activeCommand = await command(active.runId);
    const queuedCommand = await command(queued.runId);
    expect(activeCommand.status).toBe("unknown");
    expect(activeCommand.last_error_code).toBe("PI_RUN_DRAINING_AFTER_RUNTIME");
    expect(queuedCommand.status).toBe("accepted");
    expect(queuedCommand.attempts).toBe(0);
    const events = await adminDatabase!.query<{ event_type: string }>("SELECT event_type FROM pi_session_events WHERE tenant_id=$1 AND pi_session_id=$2 ORDER BY sequence", [fixture.tenantId, session.id]);
    expect(events.map((event) => event.event_type)).toContain("run_unknown");
    const sandbox = await adminDatabase!.query<{ status: string }>("SELECT status FROM sandbox_runs WHERE tenant_id=$1 AND pi_run_id=$2", [fixture.tenantId, active.runId]);
    expect(sandbox).toHaveLength(1);
    expect(sandbox[0].status).toBe("destroyed");

    await adminDatabase!.query("UPDATE tenants SET status='suspended' WHERE id=$1", [fixture.tenantId]);
    await unlink(shutdownFile).catch(() => undefined);
    shutdownFiles.delete(shutdownFile);
    runner = undefined;
  }, 30_000);

  realIt("completes a bounded repeated-run soak with one attempt, contiguous events, and no orphan Sandbox", async () => {
    const fixture = await createTenantFixture("soak");
    const session = await fixture.service.createSession(fixture.context, { profile: "coding", workspaceId: "soak-workspace" });
    const runs: string[] = [];
    for (let index = 0; index < SOAK_RUN_COUNT; index += 1) {
      runs.push((await fixture.service.sendMessage(fixture.context, session.id, `短任务 ${index}`, `soak-${index}-${randomUUID()}`)).runId);
    }
    const instanceId = `soak-${fixture.tenantId.slice(0, 8)}`;
    const shutdownFile = path.join(path.dirname(bundlePath), `soak-${fixture.tenantId}.signal`);
    shutdownFiles.add(shutdownFile);
    await unlink(shutdownFile).catch(() => undefined);
    runner = spawn(process.execPath, [bundlePath], { cwd: process.cwd(), env: runnerEnvironment(instanceId, 2, shutdownFile), stdio: "ignore" });

    await waitFor(async () => {
      const rows = await adminDatabase!.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_run_commands WHERE tenant_id=$1 AND status='acknowledged'", [fixture.tenantId]);
      return Number(rows[0]?.count) === SOAK_RUN_COUNT;
    }, 60_000);
    const commands = await adminDatabase!.query<{ run_id: string; status: string; attempts: number }>("SELECT run_id::text,status,attempts FROM pi_run_commands WHERE tenant_id=$1 ORDER BY created_at", [fixture.tenantId]);
    expect(commands).toHaveLength(SOAK_RUN_COUNT);
    expect(commands.every((row) => row.status === "acknowledged" && Number(row.attempts) === 1)).toBe(true);
    const manifests = await adminDatabase!.query<{ run_id: string; count: number }>("SELECT run_id::text,count(*)::int AS count FROM pi_run_manifests WHERE tenant_id=$1 GROUP BY run_id", [fixture.tenantId]);
    expect(manifests).toHaveLength(SOAK_RUN_COUNT);
    expect(manifests.every((row) => Number(row.count) === 1)).toBe(true);
    const events = await adminDatabase!.query<{ sequence: number; event_type: string }>("SELECT sequence,event_type FROM pi_session_events WHERE tenant_id=$1 AND pi_session_id=$2 ORDER BY sequence", [fixture.tenantId, session.id]);
    expect(events.map((event) => Number(event.sequence))).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
    const sandboxes = await adminDatabase!.query<{ status: string; count: number }>("SELECT status,count(*)::int AS count FROM sandbox_runs WHERE tenant_id=$1 GROUP BY status", [fixture.tenantId]);
    expect(sandboxes).toEqual([{ status: "destroyed", count: SOAK_RUN_COUNT }]);

    await writeFile(shutdownFile, "shutdown\n", "utf8");
    const exit = await waitForExit(runner);
    expect(exit.code).toBe(0);
    const heartbeat = await adminDatabase!.query<{ draining: boolean }>("SELECT draining FROM worker_heartbeats WHERE role='pi-runner' AND instance_id=$1", [`${instanceId}:pi-runner`]);
    expect(heartbeat[0]?.draining).toBe(true);
    await unlink(shutdownFile).catch(() => undefined);
    shutdownFiles.delete(shutdownFile);
    runner = undefined;
  }, 90_000);
});
