// Requirements: PR-009, SR-003, SR-004, AC-010, DR-009
// Opt-in real multi-process Runner regression. Run only against a disposable database:
// REAL_POSTGRES_PI_TEST=1 REAL_POSTGRES_PI_URL=postgres://app... REAL_POSTGRES_PI_ADMIN_URL=postgres://admin... npx vitest run tests/integration/real-postgres-pi-runner-process.test.ts
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
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
const SANDBOX_RUN_TOKEN_SECRET = "real-runner-sandbox-token-secret-0123456789";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error("REAL_PI_RUNNER_WAIT_TIMEOUT");
}

describe("real PostgreSQL Pi Runner process boundary", () => {
  let database: TransactionalDatabase | undefined;
  let adminDatabase: (TransactionalDatabase & MigrationDatabase) | undefined;
  let supervisor: Server | undefined;
  let runner: ChildProcess | undefined;
  let runId = "";
  let sessionId = "";
  let tenantId = "";
  let actorId = "";
  let limitCalls = 0;
  let sandboxStatus: "running" | "terminating" | "destroyed" = "destroyed";
  let sandboxScope: PiSandboxRunTokenScope | undefined;
  const tokenIssuer = new HmacPiSandboxRunTokenIssuer(SANDBOX_RUN_TOKEN_SECRET);
  const delayedResponses = new Set<ReturnType<typeof setTimeout>>();

  const context = (): RequestContext => ({
    tenantId,
    actorId,
    sessionId: "real-runner-process-test",
    channel: "web",
    traceId: `real-runner-process-${runId || "setup"}`,
    roles: [],
    permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute"],
    dataScopes: [{ type: "tenant" }],
  });

  beforeAll(async () => {
    if (!enabled) return;
    tenantId = randomUUID();
    actorId = randomUUID();
    adminDatabase = createPostgresDatabase(process.env.REAL_POSTGRES_PI_ADMIN_URL ?? process.env.REAL_POSTGRES_PI_URL!);
    await runMigrations(adminDatabase, path.resolve("src/platform/database/migrations"));
    await adminDatabase.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,$2,'Real Runner','active')", [tenantId, `real-runner-${tenantId.slice(0, 8)}`]);
    await adminDatabase.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Real Runner','real-runner@example.test','active')", [actorId, tenantId]);
    database = createPostgresDatabase(process.env.REAL_POSTGRES_PI_URL!);
    const service = new PiAgentService(new PostgresPiSessionStore(database), new VirtualSandboxProvider(), new PostgresPiRunStore(database));
    const session = await service.createSession(context(), { profile: "coding", workspaceId: "real-runner-workspace" });
    sessionId = session.id;
    runId = (await service.sendMessage(context(), session.id, "真实多进程 Runner 恢复", `real-runner-${tenantId}`)).runId;

    supervisor = createServer((request, response) => {
      request.resume();
      const respond = (body: unknown = {}) => {
        if (response.destroyed) return;
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      };
      if (request.method === "POST" && request.url === "/v1/sandboxes/create") {
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith("Bearer ")) {
          response.statusCode = 401;
          response.end(JSON.stringify({ code: "PI_SANDBOX_RUN_TOKEN_REQUIRED" }));
          return;
        }
        const scope: PiSandboxRunTokenScope = { tenantId, actorId, sessionId, workspaceId: "real-runner-workspace", runId, provider: "firecracker" };
        try { tokenIssuer.verify(authorization.slice("Bearer ".length), scope); } catch {
          response.statusCode = 403;
          response.end(JSON.stringify({ code: "PI_SANDBOX_RUN_TOKEN_DENIED" }));
          return;
        }
        const sandboxId = `mock-sandbox-${runId}`;
        sandboxScope = { ...scope, sandboxId };
        sandboxStatus = "running";
        respond({ sandbox: { id: sandboxId, root: "/mock-root", provider: "firecracker", tenantId, actorId, sessionId: scope.sessionId, runId } });
        return;
      }
      if (sandboxScope) {
        const authorization = request.headers.authorization;
        try {
          if (!authorization?.startsWith("Bearer ")) throw new Error("PI_SANDBOX_RUN_TOKEN_REQUIRED");
          tokenIssuer.verify(authorization.slice("Bearer ".length), sandboxScope);
        } catch {
          response.statusCode = 403;
          response.end(JSON.stringify({ code: "PI_SANDBOX_RUN_TOKEN_DENIED" }));
          return;
        }
      }
      if (request.method === "POST" && request.url?.endsWith("/terminate")) {
        sandboxStatus = "terminating";
        respond({});
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/destroy")) {
        sandboxStatus = "destroyed";
        respond({});
        return;
      }
      if (request.method === "GET" && request.url?.endsWith("/status")) {
        respond({ status: sandboxStatus, destroyed: sandboxStatus === "destroyed" });
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/limits")) {
        limitCalls += 1;
        if (limitCalls === 1) {
          const timer = setTimeout(() => {
            delayedResponses.delete(timer);
            respond({});
          }, 20_000);
          delayedResponses.add(timer);
        } else {
          respond({});
        }
        return;
      }
      respond({});
    });
    supervisor.listen(0, "127.0.0.1");
    await once(supervisor, "listening");
    const bundleDirectory = path.resolve(".next-build-real-pi-runner-process");
    await mkdir(bundleDirectory, { recursive: true });
    await execFileAsync(process.execPath, [
      "node_modules/esbuild/bin/esbuild",
      "scripts/pi-runner.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${path.join(bundleDirectory, "pi-runner.mjs")}`,
      "--external:@earendil-works/pi-ai",
      "--external:@earendil-works/pi-coding-agent",
    ], { cwd: process.cwd(), env: process.env });
  });

  afterAll(async () => {
    if (runner && runner.exitCode === null) runner.kill("SIGKILL");
    for (const timer of delayedResponses) clearTimeout(timer);
    delayedResponses.clear();
    if (supervisor) await new Promise<void>((resolve) => supervisor!.close(() => resolve()));
    if (database) await database.close();
    if (adminDatabase) await adminDatabase.close();
  });

  realIt("survives a process kill during provisioning, cleans the sandbox, and fails closed", async () => {
    const address = supervisor!.address();
    if (!address || typeof address === "string") throw new Error("REAL_PI_RUNNER_SUPERVISOR_ADDRESS_INVALID");
    const environment = {
      ...process.env,
      DATABASE_URL: process.env.REAL_POSTGRES_PI_URL!,
      NODE_ENV: "development" as const,
      NEXUS_PI_SANDBOX_PROVIDER: "firecracker",
      NEXUS_PI_SANDBOX_ENDPOINT: `http://127.0.0.1:${address.port}`,
      NEXUS_PI_SANDBOX_RUN_TOKEN_SECRET: SANDBOX_RUN_TOKEN_SECRET,
      WORKER_LEASE_MS: "1500",
      WORKER_POLL_INTERVAL_MS: "50",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      WORKER_MAX_ITEMS_PER_ROLE: "1",
      NEXUS_RELEASE_VERSION: "real-runner-process-test",
    };
    const runnerBundle = path.resolve(".next-build-real-pi-runner-process/pi-runner.mjs");
    const firstRunner = spawn(process.execPath, [runnerBundle], { cwd: process.cwd(), env: environment, stdio: "ignore" });
    runner = firstRunner;

    await waitFor(async () => {
      const rows = await adminDatabase!.query<{ status: string; lease_owner: string | null }>("SELECT status,lease_owner FROM pi_run_commands WHERE run_id=$1", [runId]);
      return rows[0]?.status === "leased" && Boolean(rows[0].lease_owner);
    });
    await waitFor(async () => limitCalls >= 1, 8_000);
    firstRunner.kill("SIGKILL");
    await once(firstRunner, "exit");

    await waitFor(async () => {
      const rows = await adminDatabase!.query<{ status: string; lease_expires_at: string | null }>("SELECT status,lease_expires_at FROM pi_run_commands WHERE run_id=$1", [runId]);
      return rows[0]?.status === "leased" && Boolean(rows[0].lease_expires_at) && new Date(rows[0].lease_expires_at!).getTime() <= Date.now();
    }, 8_000);

    runner = spawn(process.execPath, [runnerBundle], { cwd: process.cwd(), env: environment, stdio: "ignore" });
    await waitFor(async () => {
      const events = await adminDatabase!.query<{ event_type: string }>("SELECT event_type FROM pi_session_events WHERE tenant_id=$1 AND pi_session_id=(SELECT pi_session_id FROM pi_run_manifests WHERE run_id=$2) ORDER BY sequence", [tenantId, runId]);
      return events.some((event) => event.event_type === "run_unknown");
    }, 8_000);

    await waitFor(async () => {
      const rows = await adminDatabase!.query<{ status: string }>("SELECT status FROM sandbox_runs WHERE pi_run_id=$1", [runId]);
      return rows.length === 1 && rows[0].status === "destroyed";
    }, 8_000);

    const recoveryRunner = runner!;
    recoveryRunner.kill("SIGKILL");
    await once(recoveryRunner, "exit");
    const final = await adminDatabase!.query<{ status: string; attempts: number; lease_expires_at: string | null }>("SELECT status,attempts,lease_expires_at FROM pi_run_commands WHERE run_id=$1", [runId]);
    const manifests = await adminDatabase!.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_run_manifests WHERE run_id=$1", [runId]);
    expect(Number(final[0]?.attempts)).toBeGreaterThanOrEqual(2);
    const status = String(final[0]?.status);
    expect(status).toBe("unknown");
    expect(manifests[0]?.count).toBe(1);
  }, 30_000);
});
