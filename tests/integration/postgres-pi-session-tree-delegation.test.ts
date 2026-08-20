// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { DelegationService, LocalPiChildSessionFactory } from "@/src/modules/pi-agent/application/delegation-service";
import { SessionTreeService } from "@/src/modules/pi-agent/application/session-tree-service";
import { StaticAgentProfileRegistry } from "@/src/modules/pi-agent/application/profile-registry";
import { PostgresPiDelegationStore } from "@/src/modules/pi-agent/infrastructure/delegation-store";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiSessionTreeStore } from "@/src/modules/pi-agent/infrastructure/session-tree-store";
import { VirtualSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";

const TENANT_A = "73000000-0000-4000-8000-000000000001";
const ACTOR_A = "73000000-0000-4000-8000-000000000002";
const TENANT_B = "73000000-0000-4000-8000-000000000011";
const ACTOR_B = "73000000-0000-4000-8000-000000000012";

function context(tenantId = TENANT_A, actorId = ACTOR_A): RequestContext {
  return {
    tenantId,
    actorId,
    sessionId: "73000000-0000-4000-8000-000000000099",
    channel: "web",
    traceId: `postgres-tree-${tenantId}-${actorId}`,
    roles: [],
    permissions: ["pi:session:create", "pi:session:read", "pi:session:write", "pi:session:branch", "pi:workspace:read", "pi:workspace:write", "pi:sandbox:execute", "pi:delegation:create", "pi:delegation:cancel"],
    dataScopes: [{ type: "tenant" }],
  };
}

describe("PostgreSQL Pi session tree and delegation", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const directory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) await database.exec(await readFile(path.join(directory, file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = { ...executor, async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]); return work(executor); }, async close() { await database.close(); } };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'tree-a','Tree A','active'),($2,'tree-b','Tree B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Tree A','tree-a@example.test','active'),($3,$4,'Tree B','tree-b@example.test','active')", [ACTOR_A, TENANT_A, ACTOR_B, TENANT_B]);
  });

  afterEach(async () => { await database.close(); });

  it("persists branches, summaries, branch-scoped events and tenant RLS", async () => {
    const sessionStore = new PostgresPiSessionStore(adapter);
    const session = await new PiAgentService(sessionStore, new VirtualSandboxProvider()).createSession(context(), { profile: "coding", workspaceId: "postgres-tree-workspace" });
    const tree = new SessionTreeService({ sessionStore, treeStore: new PostgresPiSessionTreeStore(adapter) });
    const root = await tree.ensureRoot(context(), session.id);
    const branch = await tree.fork(context(), session.id, { parentBranchId: root.id, baseEventSequence: 1, label: "postgres-fork", idempotencyKey: "postgres-fork-1" });
    const summary = await tree.compact(context(), session.id, { branchId: root.id, idempotencyKey: "postgres-compact-1" });
    expect(branch.parentBranchId).toBe(root.id);
    expect(summary.summaryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await tree.getTree(context(), session.id)).branches).toHaveLength(2);
    expect((await tree.materializeHistory(context(), session.id, branch.id)).events.map((event) => event.type)).toEqual(["session_created"]);
    await expect(tree.getTree(context(TENANT_B, ACTOR_B), session.id)).rejects.toThrow("PI_SESSION_NOT_FOUND");

    const counts = await database.query<{ branches: number; summaries: number }>(
      "SELECT (SELECT count(*)::int FROM pi_session_branches WHERE tenant_id=$1) AS branches, (SELECT count(*)::int FROM pi_context_summaries WHERE tenant_id=$1) AS summaries",
      [TENANT_A],
    );
    expect(counts.rows[0]).toMatchObject({ branches: 2, summaries: 1 });
    const hiddenBranches = await new PostgresPiSessionTreeStore(adapter).listBranches(context(TENANT_B, ACTOR_B), session.id);
    const hiddenSummaries = await new PostgresPiSessionTreeStore(adapter).listSummaries(context(TENANT_B, ACTOR_B), session.id);
    const hiddenDelegations = await new PostgresPiDelegationStore(adapter).listByParent(context(TENANT_B, ACTOR_B), session.id);
    expect(hiddenBranches).toEqual([]);
    expect(hiddenSummaries).toEqual([]);
    expect(hiddenDelegations).toEqual([]);
  });

  it("stores bounded child admission and rejects cross-tenant access", async () => {
    const sessionStore = new PostgresPiSessionStore(adapter);
    const session = await new PiAgentService(sessionStore, new VirtualSandboxProvider()).createSession(context(), { profile: "coding", workspaceId: "postgres-delegation-workspace" });
    const delegationStore = new PostgresPiDelegationStore(adapter);
    const service = new DelegationService(sessionStore, delegationStore, new StaticAgentProfileRegistry(), new LocalPiChildSessionFactory(sessionStore), true);
    const child = await service.spawnChildRun(context(), { parentSessionId: session.id, profile: "coding", budget: { maxTokens: 1000 }, idempotencyKey: "postgres-child-1" });
    expect(child.childSessionId).toBeDefined();
    expect(child.budget.maxTokens).toBe(1000);
    expect((await service.collectChildResults(context(), child.id)).terminal).toBe(false);
    await expect(service.collectChildResults(context(TENANT_B, ACTOR_B), child.id)).rejects.toThrow("PI_DELEGATION_NOT_FOUND");
    const rls = await database.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('pi_context_summaries','pi_agent_delegations') ORDER BY relname");
    expect(rls.rows).toHaveLength(2);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
});
