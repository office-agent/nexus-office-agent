// Requirements: PR-003, PR-008, MR-006, MR-008, MR-009, MR-011, MR-013, MR-014, MR-015, MR-017, AR-002, AR-003, AR-004, SR-001, SR-002, SR-004, AC-002, AC-003
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnterpriseGovernanceService } from "@/src/modules/enterprise-governance/application/service";
import { PostgresEnterpriseGovernanceRepository } from "@/src/modules/enterprise-governance/infrastructure/postgres-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";
import type { RequestContext } from "@/src/platform/context/request-context";
import { PostgresAuthorizationResolver } from "@/src/platform/identity/authorization-resolver";

const TENANT_ID = "00000000-0000-4000-8000-000000000301";
const SUBJECT_ID = "10000000-0000-4000-8000-000000000301";
const SUCCESSOR_ID = "10000000-0000-4000-8000-000000000302";
const REQUESTER_ID = "10000000-0000-4000-8000-000000000303";
const APPROVER_ID = "10000000-0000-4000-8000-000000000304";
const PROJECT_ID = "30000000-0000-4000-8000-000000000301";
const TASK_ID = "70000000-0000-4000-8000-000000000301";
const RISK_ID = "50000000-0000-4000-8000-000000000301";
const ROLE_ID = "20000000-0000-4000-8000-000000000301";
const PERMISSION_ID = "21000000-0000-4000-8000-000000000301";
const CONNECTION_ID = "60000000-0000-4000-8000-000000000301";
const DEVICE_ID = "11000000-0000-4000-8000-000000000301";

const GOVERNANCE_PERMISSIONS = [
  "objective:create", "project:create",
  "enterprise_governance:read", "organization_change:create", "organization_change:approve", "organization_change:execute",
  "project_change:update", "project_change:approve", "project_change:execute", "project_closure:update", "project_closure:approve",
  "management_attention:admin", "compensation:execute",
];

function context(actorId: string): RequestContext {
  return { ...createDevelopmentRequestContext(`governance-${actorId}`), tenantId: TENANT_ID, actorId, permissions: GOVERNANCE_PERMISSIONS, dataScopes: [{ type: "tenant" }] };
}

describe("PostgreSQL enterprise governance", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;
  let repository: PostgresEnterpriseGovernanceRepository;
  let service: EnterpriseGovernanceService;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of [
      "0001_foundation.sql", "0002_management_loop.sql", "0003_agent_platform.sql", "0004_connector_platform.sql",
      "0005_workflow_knowledge.sql", "0006_strategy_organization_talent.sql", "0007_client_platform.sql",
      "0008_security_hardening.sql", "0009_atomic_audit.sql", "0010_immutable_audit.sql", "0011_enterprise_governance.sql",
    ]) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));

    const executorFor = (target: Pick<PGlite, "query">): DatabaseExecutor => ({
      async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) {
        return (await target.query<T>(sql, params as never[])).rows;
      },
    });
    const base = executorFor(database);
    adapter = {
      ...base,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        return database.transaction(async (transaction) => {
          await transaction.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
          return work(executorFor(transaction as unknown as Pick<PGlite, "query">));
        });
      },
      async close() { await database.close(); },
    };
    repository = new PostgresEnterpriseGovernanceRepository(adapter);
    service = new EnterpriseGovernanceService(repository, new InMemoryEventStore());

    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'governance','Governance','active')", [TENANT_ID]);
    await database.query(
      `INSERT INTO users(id,tenant_id,display_name,email,status) VALUES
       ($1,$5,'Owner','owner@example.test','active'),($2,$5,'Successor','successor@example.test','active'),
       ($3,$5,'Requester','requester@example.test','active'),($4,$5,'Approver','approver@example.test','active')`,
      [SUBJECT_ID, SUCCESSOR_ID, REQUESTER_ID, APPROVER_ID, TENANT_ID],
    );
    await database.query(
      `INSERT INTO projects(id,tenant_id,code,name,description,owner_id,status,priority,starts_at,target_end_at,budget,currency,health,business_value,acceptance_criteria,resource_plan,baseline_version,version)
       VALUES($1,$2,'GOV-1','治理交付','关键客户交付',$3,'active','critical','2026-07-01','2026-09-30',1000,'CNY','at_risk','保障客户续约','验收单签署',$4,1,3)`,
      [PROJECT_ID, TENANT_ID, SUBJECT_ID, { delivery: 2, actualCost: 1250 }],
    );
    await database.query("INSERT INTO tasks(id,tenant_id,project_id,title,assignee_id,status,priority,due_at) VALUES($1,$2,$3,'解除关键阻塞',$4,'blocked','critical','2026-08-01')", [TASK_ID, TENANT_ID, PROJECT_ID, SUBJECT_ID]);
    await database.query("INSERT INTO risks(id,tenant_id,project_id,title,description,owner_id,probability,impact,status,source_type) VALUES($1,$2,$3,'验收风险','客户窗口收窄',$4,5,4,'monitoring','human')", [RISK_ID, TENANT_ID, PROJECT_ID, SUBJECT_ID]);
    await database.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'owner','Owner')", [ROLE_ID, TENANT_ID]);
    await database.query("INSERT INTO permissions(id,code,description,risk_level) VALUES($1,'project:read','Read project',0)", [PERMISSION_ID]);
    await database.query("INSERT INTO role_permissions(tenant_id,role_id,permission_id) VALUES($1,$2,$3)", [TENANT_ID, ROLE_ID, PERMISSION_ID]);
    await database.query("INSERT INTO user_roles(id,tenant_id,user_id,role_id,scope_type,scope_value,starts_at) VALUES($1,$2,$3,$4,'tenant','{}','2026-01-01')", [crypto.randomUUID(), TENANT_ID, SUBJECT_ID, ROLE_ID]);
    await database.query("INSERT INTO connections(id,tenant_id,provider,name,status,secret_ref) VALUES($1,$2,'feishu','飞书','active','secret://feishu/test')", [CONNECTION_ID, TENANT_ID]);
    await database.query("INSERT INTO external_identities(id,tenant_id,connection_id,provider,subject_type,external_subject_id,internal_subject_type,internal_subject_id,status) VALUES($1,$2,$3,'feishu','user','external-owner','user',$4,'verified')", [crypto.randomUUID(), TENANT_ID, CONNECTION_ID, SUBJECT_ID]);
    await database.query("INSERT INTO client_devices(id,tenant_id,user_id,installation_id,display_name,client_type,platform,app_version,status) VALUES($1,$2,$3,$4,'Owner PWA','web_pwa','Windows','0.9.0','active')", [DEVICE_ID, TENANT_ID, SUBJECT_ID, crypto.randomUUID()]);
  });

  afterEach(async () => database.close());

  it("atomically offboards, transfers every ownership and invalidates authorization", async () => {
    const change = await service.createOrganizationChange(context(REQUESTER_ID), {
      subjectUserId: SUBJECT_ID, changeType: "departure", effectiveAt: "2026-08-05T00:00:00.000Z",
      successorUserId: SUCCESSOR_ID, reason: "离职并完成全量业务交接",
    });
    const approved = await service.approveOrganizationChange(context(APPROVER_ID), change.id, change.version);
    const result = await service.executeOrganizationChange(context(APPROVER_ID), change.id, approved.version, new Date("2026-08-06T00:00:00.000Z"));

    expect(result.handoffs.map((item) => item.resourceType).sort()).toEqual(["project", "risk", "task"]);
    expect((await database.query<{ status: string }>("SELECT status FROM users WHERE id=$1", [SUBJECT_ID])).rows[0].status).toBe("departed");
    expect((await database.query<{ assignee_id: string }>("SELECT assignee_id FROM tasks WHERE id=$1", [TASK_ID])).rows[0].assignee_id).toBe(SUCCESSOR_ID);
    expect((await database.query<{ status: string }>("SELECT status FROM client_devices WHERE id=$1", [DEVICE_ID])).rows[0].status).toBe("revoked");
    expect((await database.query<{ status: string }>("SELECT status FROM external_identities WHERE internal_subject_id=$1", [SUBJECT_ID])).rows[0].status).toBe("revoked");
    expect((await database.query<{ expires_at: Date | null }>("SELECT expires_at FROM user_roles WHERE user_id=$1", [SUBJECT_ID])).rows[0].expires_at).not.toBeNull();
    await expect(new PostgresAuthorizationResolver(adapter).resolve(TENANT_ID, SUBJECT_ID)).resolves.toBeNull();
  });

  it("detects management exceptions, applies and compensates a baseline, and closes only through the atomic gate", async () => {
    const requester = context(REQUESTER_ID);
    const approver = context(APPROVER_ID);
    const initiative = await service.createInitiative(requester, {
      objective: { title: "上线成功率达到 99%", description: "以发布治理降低生产故障", ownerId: REQUESTER_ID, baseline: 95, targetValue: 99, currentValue: 96, unit: "%", startsAt: "2026-08-01", endsAt: "2026-12-31", reviewCadence: "monthly" },
      project: { code: "RELEASE-2026", name: "发布治理升级", description: "统一灰度与回滚策略", ownerId: REQUESTER_ID, businessValue: "降低发布事故损失", acceptanceCriteria: "成功率达到 99% 并完成演练", resourcePlan: { engineering: 3, sre: 1 }, priority: "high", startsAt: "2026-08-10", targetEndAt: "2026-12-20", budget: 400000, currency: "CNY" },
    });
    const linkage = await database.query<{ count: number }>("SELECT count(*)::int count FROM objective_project_links WHERE objective_id=$1 AND project_id=$2", [initiative.objective.id, initiative.project.id]);
    expect(linkage.rows[0].count).toBe(1);
    const attention = await service.scanAttention(requester, new Date("2026-08-06T00:00:00.000Z"));
    expect(attention.map((item) => item.reasonCode).sort()).toEqual(["budget_variance", "critical_task_blocked", "risk_exposure"]);
    await service.scanAttention(requester, new Date("2026-08-07T00:00:00.000Z"));
    expect((await database.query<{ count: number; max_version: number }>("SELECT count(*)::int count,max(version)::int max_version FROM management_attention_items")).rows[0]).toEqual({ count: 3, max_version: 2 });

    const change = await service.createProjectChange(requester, {
      projectId: PROJECT_ID, changeType: "schedule", proposedBaseline: { targetEndAt: "2026-10-15" },
      reason: "验收窗口调整", impactAssessment: "延期两周，预算不变",
    });
    const approved = await service.approveProjectChange(approver, change.id, change.version);
    const applied = await service.applyProjectChange(approver, change.id, approved.version, new Date("2026-08-06T00:00:00.000Z"));
    expect(await repository.getProject(TENANT_ID, PROJECT_ID)).toMatchObject({ targetEndAt: "2026-10-15", baselineVersion: 2, projectVersion: 4 });
    await service.executeCompensation(approver, applied.compensation.id, applied.compensation.version, new Date("2026-08-07T00:00:00.000Z"));
    expect(await repository.getProject(TENANT_ID, PROJECT_ID)).toMatchObject({ targetEndAt: "2026-09-30", baselineVersion: 3, projectVersion: 5 });

    const review = await service.saveClosureReview(requester, PROJECT_ID, {
      deliveryAcceptanceRef: "document://acceptance/signed", retrospectiveRef: "knowledge://retrospective/gov-1",
      unresolvedItems: [{ resourceType: "risk", resourceId: RISK_ID, handoffOwnerId: SUCCESSOR_ID, evidenceRef: "document://handoff/risk" }],
    });
    await expect(service.approveAndCompleteProject(approver, PROJECT_ID, review.version, 5)).rejects.toThrow("PROJECT_VERSION_CONFLICT");
    expect(await repository.getClosureReview(TENANT_ID, PROJECT_ID)).toMatchObject({ status: "ready", version: 1 });
    await database.query("UPDATE projects SET status='closing' WHERE id=$1", [PROJECT_ID]);
    await expect(database.query("UPDATE projects SET status='completed' WHERE id=$1", [PROJECT_ID])).rejects.toThrow("PROJECT_CLOSURE_REVIEW_REQUIRED");
    const completed = await service.approveAndCompleteProject(approver, PROJECT_ID, review.version, 5, new Date("2026-08-08T00:00:00.000Z"));
    expect(completed).toMatchObject({ status: "completed", approvedBy: APPROVER_ID, version: 3 });
    expect(await repository.getProject(TENANT_ID, PROJECT_ID)).toMatchObject({ status: "completed", projectVersion: 6 });

    const audited = await database.query<{ resource_type: string }>("SELECT DISTINCT resource_type FROM audit_events WHERE resource_type IN ('project_change_requests','project_closure_reviews','management_attention_items','compensation_plans') ORDER BY resource_type");
    expect(audited.rows.map((row) => row.resource_type)).toEqual(["compensation_plans", "management_attention_items", "project_change_requests", "project_closure_reviews"]);
  });
});
