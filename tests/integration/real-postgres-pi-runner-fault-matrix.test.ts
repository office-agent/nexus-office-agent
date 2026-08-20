// Requirements: PR-009, SR-003, SR-004, AC-010, DR-009
// Opt-in real multi-process Runner fault matrix. Run only against disposable
// PostgreSQL and a test-only supervisor:
// REAL_POSTGRES_PI_TEST=1 REAL_POSTGRES_PI_URL=postgres://app... REAL_POSTGRES_PI_ADMIN_URL=postgres://admin... npx vitest run tests/integration/real-postgres-pi-runner-fault-matrix.test.ts
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
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
import { HmacPiSandboxRunTokenIssuer, type PiSandboxRunTokenScope } from "@/src/modules/pi-agent/application/sandbox-token";

const enabled = process.env.REAL_POSTGRES_PI_TEST === "1" && Boolean(process.env.REAL_POSTGRES_PI_URL);
const realIt = enabled ? it : it.skip;
const execFileAsync = promisify(execFile);
const SANDBOX_RUN_TOKEN_SECRET = "real-runner-fault-sandbox-token-secret-0123456789";

type RunRef = { sessionId: string; runId: string };
type FaultCase = {
  name: string;
  point: string;
  eventType?: string;
  outcome: "retry" | "unknown";
};
type SupervisorRequestBody = { spec?: { tenantId?: string; actorId?: string; sessionId?: string; workspaceId?: string; runId?: string } };

const FAULT_CASES: FaultCase[] = [
  { name: "after claim", point: "after_claim", outcome: "retry" },
  { name: "before sandbox create", point: "before_sandbox_create", outcome: "unknown" },
  { name: "after sandbox create", point: "after_sandbox_create", outcome: "unknown" },
  { name: "after sandbox limits", point: "after_sandbox_limits", outcome: "unknown" },
  { name: "before runtime create", point: "before_runtime_create", outcome: "unknown" },
  { name: "after runtime create", point: "after_runtime_create", outcome: "unknown" },
  { name: "before prompt", point: "before_prompt", outcome: "unknown" },
  { name: "during prompt", point: "during_prompt", outcome: "unknown" },
  { name: "before tool", point: "before_tool", eventType: "tool_execution_start", outcome: "unknown" },
  { name: "after tool", point: "after_tool", eventType: "tool_execution_end", outcome: "unknown" },
  { name: "before event flush", point: "before_event_flush", eventType: "tool_execution_start", outcome: "unknown" },
  { name: "after event flush", point: "after_event_flush", eventType: "tool_execution_end", outcome: "unknown" },
];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error("REAL_PI_RUNNER_FAULT_MATRIX_WAIT_TIMEOUT");
}

async function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    delay(timeoutMs).then(() => { throw new Error("REAL_PI_RUNNER_CHILD_EXIT_TIMEOUT"); }),
  ]);
}

describe("real PostgreSQL Pi Runner fault matrix", () => {
  let database: TransactionalDatabase | undefined;
  let adminDatabase: (TransactionalDatabase & MigrationDatabase) | undefined;
  let supervisor: Server | undefined;
  let bundlePath = "";
  let tenantId = "";
  let actorId = "";
  let fixtureDirectory = "";
  const children = new Set<ChildProcess>();
  const sandboxStates = new Map<string, "running" | "terminating" | "destroyed">();
  const sandboxScopes = new Map<string, PiSandboxRunTokenScope>();
  const tokenIssuer = new HmacPiSandboxRunTokenIssuer(SANDBOX_RUN_TOKEN_SECRET);

  const context = (sessionId: string, runId = "setup"): RequestContext => ({
    tenantId,
    actorId,
    sessionId,
    channel: "web",
    traceId: `real-runner-fault-${runId}`,
    roles: [],
    permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute"],
    dataScopes: [{ type: "tenant" }],
  });

  async function createRun(label: string): Promise<RunRef> {
    const sessionId = `real-fault-session-${label}-${randomUUID()}`;
    const service = new PiAgentService(new PostgresPiSessionStore(database!), new VirtualSandboxProvider(), new PostgresPiRunStore(database!));
    const session = await service.createSession(context(sessionId), { profile: "coding", workspaceId: "real-runner-fault-workspace" });
    const accepted = await service.sendMessage(context(session.id), session.id, `多进程故障矩阵 ${label}`, `real-fault-${label}-${randomUUID()}`);
    return { sessionId: session.id, runId: accepted.runId };
  }

  async function command(runId: string): Promise<{ status: string; attempts: number; lease_expires_at: string | null; last_error_code: string | null }> {
    const rows = await adminDatabase!.query<{ status: string; attempts: number; lease_expires_at: string | null; last_error_code: string | null }>("SELECT status,attempts,lease_expires_at,last_error_code FROM pi_run_commands WHERE run_id=$1", [runId]);
    return rows[0] ?? { status: "missing", attempts: 0, lease_expires_at: null, last_error_code: null };
  }

  async function events(runId: string): Promise<Array<{ sequence: number; event_type: string }>> {
    const rows = await adminDatabase!.query<{ sequence: number; event_type: string }>("SELECT sequence,event_type FROM pi_session_events WHERE tenant_id=$1 AND pi_session_id=(SELECT pi_session_id FROM pi_run_manifests WHERE run_id=$2) ORDER BY sequence", [tenantId, runId]);
    return rows;
  }

  async function spawnRunner(overrides: Record<string, string | undefined> = {}): Promise<ChildProcess> {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: process.env.REAL_POSTGRES_PI_URL!,
      NODE_ENV: "development",
      NEXUS_PI_SANDBOX_PROVIDER: "firecracker",
      NEXUS_PI_SANDBOX_ENDPOINT: `http://127.0.0.1:${(supervisor!.address() as { port: number }).port}`,
      NEXUS_PI_SANDBOX_RUN_TOKEN_SECRET: SANDBOX_RUN_TOKEN_SECRET,
      NEXUS_PI_TEST_RUNTIME: "cooperative",
      NEXUS_PI_TEST_RUNTIME_AUTO_COMPLETE_MS: "25",
      WORKER_LEASE_MS: "900",
      WORKER_POLL_INTERVAL_MS: "40",
      WORKER_HEARTBEAT_INTERVAL_MS: "300",
      WORKER_MAX_ITEMS_PER_ROLE: "4",
      NEXUS_RELEASE_VERSION: "real-runner-fault-matrix",
      ...overrides,
    };
    const child = spawn(process.execPath, [bundlePath], { cwd: process.cwd(), env: environment, stdio: "ignore" });
    children.add(child);
    child.once("exit", () => children.delete(child));
    return child;
  }

  async function assertEventSequence(runId: string): Promise<Array<{ sequence: number; event_type: string }>> {
    const rows = await events(runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => Number(row.sequence))).toEqual(rows.map((_row, index) => index + 1));
    return rows;
  }

  beforeAll(async () => {
    if (!enabled) return;
    tenantId = randomUUID();
    actorId = randomUUID();
    fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "nexus-pi-fault-matrix-"));
    adminDatabase = createPostgresDatabase(process.env.REAL_POSTGRES_PI_ADMIN_URL ?? process.env.REAL_POSTGRES_PI_URL!);
    await runMigrations(adminDatabase, path.resolve("src/platform/database/migrations"));
    await adminDatabase.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,$2,'Fault Matrix','active')", [tenantId, `fault-matrix-${tenantId.slice(0, 8)}`]);
    await adminDatabase.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Fault Matrix','fault-matrix@example.test','active')", [actorId, tenantId]);
    database = createPostgresDatabase(process.env.REAL_POSTGRES_PI_URL!);

    supervisor = createServer(async (request, response) => {
      const bodyChunks: Buffer[] = [];
      request.on("data", (chunk) => bodyChunks.push(Buffer.from(chunk)));
      await once(request, "end");
      const body = bodyChunks.length > 0 ? JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as SupervisorRequestBody : undefined;
      const respond = (bodyValue: unknown = {}) => {
        if (response.destroyed) return;
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(bodyValue));
      };
      const url = request.url ?? "";
      if (request.method === "POST" && url === "/v1/sandboxes/create") {
        const spec = body?.spec ?? {};
        const authorization = request.headers.authorization;
        const scope = {
          tenantId: spec.tenantId,
          actorId: spec.actorId,
          sessionId: spec.sessionId,
          workspaceId: spec.workspaceId,
          runId: spec.runId,
          provider: "firecracker" as const,
        } as PiSandboxRunTokenScope;
        try {
          if (!authorization?.startsWith("Bearer ")) throw new Error("PI_SANDBOX_RUN_TOKEN_REQUIRED");
          tokenIssuer.verify(authorization.slice("Bearer ".length), scope);
        } catch {
          response.statusCode = 403;
          response.end(JSON.stringify({ code: "PI_SANDBOX_RUN_TOKEN_DENIED" }));
          return;
        }
        const id = `fault-sandbox-${randomUUID()}`;
        sandboxStates.set(id, "running");
        sandboxScopes.set(id, { ...scope, sandboxId: id });
        respond({ sandbox: { id, root: `/mock-root/${id}`, provider: "firecracker", tenantId, actorId, sessionId: spec.sessionId, runId: spec.runId } });
        return;
      }
      const match = url.match(/^\/v1\/sandboxes\/([^/]+)(?:\/([^/]+))?$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const operation = match[2];
        const authorization = request.headers.authorization;
        try {
          const scope = sandboxScopes.get(id);
          if (!scope || !authorization?.startsWith("Bearer ")) throw new Error("PI_SANDBOX_RUN_TOKEN_REQUIRED");
          tokenIssuer.verify(authorization.slice("Bearer ".length), scope);
        } catch {
          response.statusCode = 403;
          response.end(JSON.stringify({ code: "PI_SANDBOX_RUN_TOKEN_DENIED" }));
          return;
        }
        if (request.method === "POST" && operation === "terminate") sandboxStates.set(id, "terminating");
        if (request.method === "POST" && operation === "destroy") sandboxStates.set(id, "destroyed");
        if (request.method === "GET" && operation === "status") {
          const status = sandboxStates.get(id) ?? "destroyed";
          respond({ status, destroyed: status === "destroyed" });
          return;
        }
        respond({});
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: "NOT_FOUND" }));
    });
    supervisor.listen(0, "127.0.0.1");
    await once(supervisor, "listening");

    const bundleDirectory = path.resolve(".next-build-real-pi-runner-fault-matrix");
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
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all([...children].map((child) => waitForExit(child, 2_000).catch(() => undefined)));
    if (supervisor) await new Promise<void>((resolve) => supervisor!.close(() => resolve()));
    if (database) await database.close();
    if (adminDatabase) await adminDatabase.close();
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
  });

  for (const faultCase of FAULT_CASES) {
    realIt(`reclaims safely after a child kill at ${faultCase.name}`, async () => {
      const run = await createRun(faultCase.point);
      const readyFile = path.join(fixtureDirectory, `${faultCase.point}-${run.runId}.ready`);
      const first = await spawnRunner({
        NEXUS_PI_FAULT_INJECTION: "1",
        NEXUS_PI_FAULT_POINT: faultCase.point,
        NEXUS_PI_FAULT_ACTION: "crash",
        NEXUS_PI_FAULT_EVENT_TYPE: faultCase.eventType,
        NEXUS_PI_FAULT_READY_FILE: readyFile,
      });
      await waitFor(async () => { try { await access(readyFile); return true; } catch { return false; } });
      await waitForExit(first);
      await waitFor(async () => (await command(run.runId)).lease_expires_at !== null && new Date((await command(run.runId)).lease_expires_at!).getTime() <= Date.now(), 8_000);

      const recovery = await spawnRunner();
      if (faultCase.outcome === "retry") {
        await waitFor(async () => (await command(run.runId)).status === "acknowledged", 15_000);
        await waitFor(async () => (await events(run.runId)).some((event) => event.event_type === "run_reclaimed"), 15_000);
        expect((await command(run.runId)).attempts).toBeGreaterThanOrEqual(2);
      } else {
        await waitFor(async () => (await command(run.runId)).status === "unknown", 15_000);
        expect((await events(run.runId)).some((event) => event.event_type === "run_unknown")).toBe(true);
      }
      await waitFor(async () => {
        const rows = await adminDatabase!.query<{ status: string }>("SELECT status FROM sandbox_runs WHERE pi_run_id=$1", [run.runId]);
        return rows.every((row) => row.status === "destroyed" || (faultCase.point === "before_sandbox_create" && row.status === "unknown"));
      }, 15_000);
      const rows = await assertEventSequence(run.runId);
      const manifests = await adminDatabase!.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_run_manifests WHERE run_id=$1", [run.runId]);
      expect(manifests[0]?.count).toBe(1);
      expect([...sandboxStates.values()].every((status) => status === "destroyed")).toBe(true);
      if (faultCase.point === "after_event_flush") expect(rows.filter((event) => event.event_type === "tool_execution_end")).toHaveLength(1);
      if (recovery.exitCode === null) recovery.kill("SIGKILL");
      await waitForExit(recovery);
    }, 35_000);
  }

  realIt("interrupts an in-flight cooperative model call through a second durable control command", async () => {
    const run = await createRun("interrupt");
    const runner = await spawnRunner({ NEXUS_PI_TEST_RUNTIME_AUTO_COMPLETE_MS: "20000" });
    await waitFor(async () => (await events(run.runId)).some((event) => event.event_type === "run_started"), 15_000);
    const service = new PiAgentService(new PostgresPiSessionStore(database!), new VirtualSandboxProvider(), new PostgresPiRunStore(database!));
    const interrupt = await service.interrupt(context(run.sessionId, run.runId), run.sessionId, `interrupt-${run.runId}`);
    expect(interrupt.created).toBe(true);
    await waitFor(async () => (await command(run.runId)).status === "cancelled", 15_000);
    await waitFor(async () => (await events(run.runId)).some((event) => event.event_type === "interrupt_applied"), 15_000);
    const rows = await assertEventSequence(run.runId);
    expect(rows.filter((event) => event.event_type === "interrupt_applied")).toHaveLength(1);
    expect(rows.filter((event) => event.event_type === "run_terminal")).toHaveLength(1);
    if (runner.exitCode === null) runner.kill("SIGKILL");
    await waitForExit(runner);
  }, 30_000);

  realIt("times out an in-flight model call from the Runner-wide duration budget", async () => {
    const run = await createRun("timeout");
    const runner = await spawnRunner({ NEXUS_PI_TEST_RUNTIME_AUTO_COMPLETE_MS: "20000", PI_RUN_MAX_DURATION_MS: "100" });
    await waitFor(async () => (await command(run.runId)).status === "unknown", 15_000);
    const finalCommand = await command(run.runId);
    const rows = await assertEventSequence(run.runId);
    expect(finalCommand.last_error_code).toBe("PI_RUN_TIMEOUT");
    expect(rows.some((event) => event.event_type === "run_terminal")).toBe(true);
    const session = await adminDatabase!.query<{ status: string }>("SELECT status FROM pi_sessions WHERE id=$1", [run.sessionId]);
    expect(session[0]?.status).toBe("timed_out");
    if (runner.exitCode === null) runner.kill("SIGKILL");
    await waitForExit(runner);
  }, 30_000);
});
