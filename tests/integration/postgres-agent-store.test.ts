// Requirements: PR-005, PR-006, AR-002, AR-003, AR-004, AR-007, AR-010, SR-006
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentRun } from "@/src/modules/agent/domain/agent-run";
import { approveProposal, createProposal } from "@/src/modules/agent/domain/proposal";
import { PostgresAgentStore } from "@/src/modules/agent/infrastructure/postgres-agent-store";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";

const tenantId = "00000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000001";

describe("Postgres Agent store", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of ["0001_foundation.sql", "0002_management_loop.sql", "0003_agent_platform.sql", "0004_connector_platform.sql", "0005_workflow_knowledge.sql", "0006_strategy_organization_talent.sql"]) {
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
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active')", [actorId,tenantId]);
  });

  afterEach(async () => { await database.close(); });

  it("persists runs, citations, proposals and confirmations", async () => {
    const store = new PostgresAgentStore(adapter);
    let run = createAgentRun({
      tenantId, actorId, sessionId: "session", channel: "web", traceId: "trace-agent-store",
      clientRequestId: "store-request-001", message: "登记风险", contextRefs: [],
    });
    run = { ...run, status: "awaiting_confirmation", riskLevel: 3, autonomy: "L3" };
    await store.saveRun(run);
    await store.saveCitations(tenantId, run.id, [{
      id: crypto.randomUUID(), objectType: "project", objectId: "project-1", objectVersion: 2,
      label: "项目 · 测试", excerpt: "健康度 at_risk", classification: "internal", retrievedAt: new Date().toISOString(),
    }]);
    const proposal = createProposal({
      tenantId, agentRunId: run.id, actorId, toolId: "management.create_risk", toolVersion: 1, riskLevel: 3,
      input: { title: "测试风险" }, preview: "登记测试风险", expectedVersions: { "project-1": 2 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await store.saveProposal(proposal);
    const approved = approveProposal(proposal, actorId, proposal.proposalHash);
    expect(await store.claimProposalConfirmation(approved.proposal)).toBe(true);
    expect(await store.claimProposalConfirmation(approved.proposal)).toBe(false);
    await store.saveConfirmation(approved.confirmation);
    await store.saveToolCall({
      id: crypto.randomUUID(), tenantId, agentRunId: run.id, confirmationId: approved.confirmation.id,
      toolId: proposal.toolId, toolVersion: 1, riskLevel: 3, idempotencyKey: proposal.proposalHash,
      inputDigest: proposal.inputDigest, outputDigest: "a".repeat(64), status: "succeeded",
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });

    expect(await store.getRunByClientRequest(tenantId, actorId, "store-request-001")).toMatchObject({ id: run.id, status: "awaiting_confirmation" });
    expect(await store.getProposal(tenantId, proposal.id)).toMatchObject({ id: proposal.id, status: "confirmed" });
    const counts = await database.query<{ citations: number; context_refs: number; confirmations: number; tool_calls: number }>(
      "SELECT (SELECT count(*)::int FROM agent_citations) AS citations, (SELECT count(*)::int FROM agent_context_refs) AS context_refs, (SELECT count(*)::int FROM confirmations) AS confirmations, (SELECT count(*)::int FROM tool_calls) AS tool_calls",
    );
    expect(counts.rows[0]).toEqual({ citations: 1, context_refs: 1, confirmations: 1, tool_calls: 1 });
  });
});
