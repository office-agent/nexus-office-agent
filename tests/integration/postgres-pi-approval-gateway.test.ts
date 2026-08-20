// Requirements: PR-010, SR-005, SR-006, AC-013, DR-010
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { ApprovalPolicyResolver, InMemoryPiApprovalEventSink, PiApprovalService, StaticPiApprovalApproverDirectory, StaticPiApprovalObjectVersionReader } from "@/src/modules/pi-agent/application/approval-service";
import { PostgresPiApprovalStore } from "@/src/modules/pi-agent/infrastructure/approval-store";
import { PostgresPiApprovalEventSink } from "@/src/modules/pi-agent/infrastructure/approval-events";

const TENANT_A = "72000000-0000-4000-8000-000000000001";
const ACTOR_A = "72000000-0000-4000-8000-000000000002";
const APPROVER_1 = "72000000-0000-4000-8000-000000000003";
const APPROVER_2 = "72000000-0000-4000-8000-000000000004";
const TENANT_B = "72000000-0000-4000-8000-000000000011";
const ACTOR_B = "72000000-0000-4000-8000-000000000012";

function context(actorId = ACTOR_A, tenantId = TENANT_A): RequestContext {
  return { tenantId, actorId, sessionId: "72000000-0000-4000-8000-000000000099", channel: "web", traceId: `postgres-approval-${actorId}`, roles: [], permissions: ["pi:approval:create", "pi:approval:read", "pi:approval:decide:r2", "pi:approval:decide:r3", "pi:approval:resume", "pi:approval:cancel"], dataScopes: [{ type: "tenant" }] };
}

describe("PostgreSQL Pi approval gateway", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;

  beforeEach(async () => {
    database = new PGlite();
    const directory = path.resolve("src/platform/database/migrations");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) await database.exec(await readFile(path.join(directory, file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = { ...executor, async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]); return work(executor); }, async close() { await database.close(); } };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'approval-a','Approval A','active'),($2,'approval-b','Approval B','active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Requester','requester@example.test','active'),($3,$2,'Approver 1','approver1@example.test','active'),($4,$2,'Approver 2','approver2@example.test','active'),($5,$6,'Other','other@example.test','active')", [ACTOR_A, TENANT_A, APPROVER_1, APPROVER_2, ACTOR_B, TENANT_B]);
    await database.query(
      `INSERT INTO pi_sessions(id,tenant_id,actor_id,workspace_id,base_ref,profile,profile_version,status,model_policy,sandbox_profile,network_policy,policy_version,skill_digests,mcp_server_digests,mcp_binding_ids,mcp_bindings,resource_snapshot,sandbox_run_id,trace_id,last_event_sequence)
       VALUES($1,$2,$3,'approval-workspace','main','release',1,'running','private','unavailable','none',1,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,$4,'approval-session',0)`,
      ["72000000-0000-4000-8000-000000000101", TENANT_A, ACTOR_A, "72000000-0000-4000-8000-000000000201"],
    );
  });

  afterEach(async () => { await database.close(); });

  it("persists proposal hash, dual decisions, revalidation state and immutable decision digests", async () => {
    const events = new PostgresPiApprovalEventSink(adapter);
    const service = new PiApprovalService(
      new PostgresPiApprovalStore(adapter),
      new ApprovalPolicyResolver(new StaticPiApprovalApproverDirectory([APPROVER_2, APPROVER_1]), { policyVersion: 11 }),
      events,
      new StaticPiApprovalObjectVersionReader({ branch: "sha-1" }),
    );
    const created = await service.createProposal(context(), { sessionId: "72000000-0000-4000-8000-000000000101", toolName: "release.propose", toolVersion: 1, profile: "release", riskLevel: "R3", preview: "创建发布提案", inputDigest: "a".repeat(64), expectedObjectVersions: { branch: "sha-1" }, idempotencyKey: "postgres-approval-create" });
    expect(created.created).toBe(true);
    const first = await service.recordDecision(context(APPROVER_1), created.approval.id, { proposalHash: created.approval.proposalHash, idempotencyKey: "postgres-approval-decision-1" });
    expect(first.approval.status).toBe("pending");
    const second = await service.recordDecision(context(APPROVER_2), created.approval.id, { proposalHash: created.approval.proposalHash, idempotencyKey: "postgres-approval-decision-2" });
    expect(second.approval.status).toBe("approved");
    const permit = await service.resumeToolCall(context(), created.approval.id);
    expect(permit.proposalHash).toBe(created.approval.proposalHash);

    const approvalRow = await database.query<{ status: string; proposal_hash: string; version: number; revalidation_status: string }>("SELECT status,proposal_hash,version,revalidation_status FROM pi_approvals WHERE tenant_id=$1 AND id=$2", [TENANT_A, created.approval.id]);
    expect(approvalRow.rows[0]).toMatchObject({ status: "approved", proposal_hash: created.approval.proposalHash, version: 4, revalidation_status: "passed" });
    const decisions = await database.query<{ actor_id: string; decision_digest: string }>("SELECT actor_id,decision_digest FROM pi_approval_decisions WHERE tenant_id=$1 AND approval_id=$2 ORDER BY created_at,id", [TENANT_A, created.approval.id]);
    expect(decisions.rows.map((row) => row.actor_id)).toEqual([APPROVER_1, APPROVER_2]);
    expect(decisions.rows.every((row) => /^[a-f0-9]{64}$/.test(row.decision_digest))).toBe(true);
    const sessionEvents = await database.query<{ event_type: string }>("SELECT event_type FROM pi_session_events WHERE tenant_id=$1 AND pi_session_id=$2 ORDER BY sequence", [TENANT_A, created.approval.sessionId]);
    expect(sessionEvents.rows.map((event) => event.event_type)).toContain("pi.tool.started");
  });

  it("enforces tenant RLS and fail-closed version revalidation", async () => {
    const service = new PiApprovalService(new PostgresPiApprovalStore(adapter), new ApprovalPolicyResolver(new StaticPiApprovalApproverDirectory([APPROVER_1, APPROVER_2]), { policyVersion: 1 }), new InMemoryPiApprovalEventSink(), new StaticPiApprovalObjectVersionReader({ branch: "sha-2" }));
    const created = await service.createProposal(context(), { sessionId: "72000000-0000-4000-8000-000000000101", toolName: "release.propose", toolVersion: 1, profile: "release", riskLevel: "R2", preview: "创建发布提案", inputDigest: "b".repeat(64), expectedObjectVersions: { branch: "sha-1" }, idempotencyKey: "postgres-approval-drift" });
    await expect(service.get(context(ACTOR_B, TENANT_B), created.approval.id)).rejects.toThrow("PI_APPROVAL_NOT_FOUND");
    await service.recordDecision(context(APPROVER_1), created.approval.id, { proposalHash: created.approval.proposalHash, idempotencyKey: "postgres-approval-drift-decision" });
    const drift = await service.revalidate(context(), created.approval.id);
    expect(drift).toMatchObject({ valid: false, reason: "PI_APPROVAL_OBJECT_VERSION_CHANGED", approval: { status: "superseded" } });
    const rows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pi_approval_decisions WHERE tenant_id=$1", [TENANT_B]);
    expect(rows.rows[0].count).toBe(0);
    const rls = await database.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='pi_approval_decisions'");
    expect(rls.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
