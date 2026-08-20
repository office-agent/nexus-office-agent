// Requirements: MR-031, MR-034, MR-036, MR-037, MR-038, MR-039, MR-043, MR-045, AR-002, AR-003, AR-004, AC-011
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModelGateway } from "@/src/modules/agent/domain/model-gateway";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { ManagementIntelligenceService } from "@/src/modules/management-intelligence/application/service";
import { InMemoryManagementWecomGateway } from "@/src/modules/management-intelligence/infrastructure/in-memory-repository";
import { PostgresManagementIntelligenceRepository } from "@/src/modules/management-intelligence/infrastructure/postgres-repository";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_PROJECT_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const METRIC_ID = "92000000-0000-4000-8000-000000000001";
const PORTFOLIO_ID = "93000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "a5000000-0000-4000-8000-000000000001";

describe("Postgres management intelligence repository", () => {
  let database: PGlite;
  let repository: PostgresManagementIntelligenceRepository;
  let service: ManagementIntelligenceService;

  beforeEach(async () => {
    database = new PGlite();
    const migrations = ["0001_foundation.sql","0002_management_loop.sql","0003_agent_platform.sql","0004_connector_platform.sql","0005_workflow_knowledge.sql","0006_strategy_organization_talent.sql","0007_client_platform.sql","0008_security_hardening.sql","0009_atomic_audit.sql","0010_immutable_audit.sql","0011_enterprise_governance.sql","0012_enterprise_acceptance.sql","0013_connector_test_notifications.sql","0014_durable_runtime.sql","0015_agent_job_control.sql","0016_management_intelligence.sql"];
    for (const file of migrations) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    const adapter: TransactionalDatabase = { ...executor, async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]); return work(executor); }, async close() { await database.close(); } };
    repository = new PostgresManagementIntelligenceRepository(adapter);
    service = new ManagementIntelligenceService(repository, new InMemoryEventStore(), new FakeModelGateway("{}"), new InMemoryManagementWecomGateway(), { dataMode: "production", appBaseUrl: "https://office.example", now: () => new Date("2026-08-05T01:00:00.000Z") });
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [DEMO_TENANT_ID]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active')", [DEMO_MANAGER_ID,DEMO_TENANT_ID]);
    await database.query("INSERT INTO projects(id,tenant_id,code,name,owner_id,status,priority,starts_at,target_end_at,health,business_value,acceptance_criteria,resource_plan) VALUES($1,$2,'P-1','Release',$3,'active','high','2026-08-01','2026-09-01','watch','Protect release quality','Signed acceptance and regression evidence',$4)", [DEMO_PROJECT_ID,DEMO_TENANT_ID,DEMO_MANAGER_ID,{ owner: DEMO_MANAGER_ID }]);
    await database.query("INSERT INTO metric_definitions(id,tenant_id,code,name,description,owner_id,unit,direction,baseline,target_value,source_system,source_locator,refresh_cadence,classification) VALUES($1,$2,'DELIVERY','Delivery','Acceptance',$3,'%','increase',80,95,'ledger','acceptance','weekly','internal')", [METRIC_ID,DEMO_TENANT_ID,DEMO_MANAGER_ID]);
    await database.query("INSERT INTO portfolios(id,tenant_id,code,name,owner_id,status,investment_thesis) VALUES($1,$2,'PF-1','Delivery portfolio',$3,'active','Protect critical delivery')", [PORTFOLIO_ID,DEMO_TENANT_ID,DEMO_MANAGER_ID]);
    await database.query("INSERT INTO portfolio_projects(tenant_id,portfolio_id,project_id) VALUES($1,$2,$3)", [DEMO_TENANT_ID,PORTFOLIO_ID,DEMO_PROJECT_ID]);
    await database.query("INSERT INTO connections(id,tenant_id,provider,name,status,secret_ref,capabilities) VALUES($1,$2,'wecom','management','active','secret://wecom/management',$3)", [CONNECTION_ID,DEMO_TENANT_ID,["message.send","card.interactive"]]);
  });

  afterEach(async () => { await database.close(); });

  it("persists CAS management objects and atomically executes the channel action with its case", async () => {
    const context = createDevelopmentRequestContext("postgres-management");
    const cadence = await service.createCadence(context, { name: "Monthly business review", cadenceType: "monthly_business", frequency: "monthly", timezone: "Asia/Shanghai", ownerId: DEMO_MANAGER_ID, participantRoleIds: ["pmo"], agendaTemplate: ["facts", "decisions"], evidenceRequirements: ["minutes"], nextOccurrenceAt: "2026-08-08T01:00:00.000Z" });
    await service.createOccurrence(context, cadence.id, { scheduledStartAt: "2026-08-08T01:00:00.000Z", scheduledEndAt: "2026-08-08T02:00:00.000Z" });
    await service.upsertMetricProfile(context, METRIC_ID, { businessDefinition: "Accepted projects delivered on time", formula: "accepted_on_time / accepted_total", ownerId: DEMO_MANAGER_ID, stewardId: DEMO_MANAGER_ID, authoritativeSource: "Acceptance ledger", sourceLocator: "acceptance.completed_at", refreshCadence: "weekly", freshnessSlaMinutes: 10_080, dimensions: ["region"], allowedUses: ["operating review"], prohibitedUses: ["employment decision"] });
    const item = await service.createCase(context, { caseType: "quality", title: "Missing release evidence", description: "Regression evidence must be attached.", severity: "high", ownerId: DEMO_MANAGER_ID, dueAt: "2026-08-06T01:00:00.000Z", slaMinutes: 1_440, sourceType: "web", sourceRef: "release:0.13.0", relatedObjectRefs: [`project:${DEMO_PROJECT_ID}`], evidenceRefs: [] });
    const dispatched = await service.dispatchWecomAction(context, { actionType: "case_accept", resourceId: item.id, connectionId: CONNECTION_ID, externalUserId: "wx-manager", expiresInMinutes: 10 });
    const executed = await service.confirmChannelAction(context, dispatched.action.id, dispatched.action.proposalHash);
    expect(executed.status).toBe("executed");
    const storedCase = await repository.getCase(DEMO_TENANT_ID, item.id);
    expect(storedCase).toMatchObject({ status: "in_progress", version: 2, ownerId: DEMO_MANAGER_ID });
    expect(await repository.updateCase({ ...storedCase!, status: "awaiting_evidence", version: 3 }, 1)).toBe(false);
    expect(await repository.getChannelAction(DEMO_TENANT_ID, dispatched.action.id)).toMatchObject({ status: "executed", version: 2, expectedVersion: 1 });
    const audited = await database.query<{ resource_type: string }>("SELECT DISTINCT resource_type FROM audit_events WHERE resource_type = ANY($1::text[]) ORDER BY resource_type", [["management_cadences","cadence_occurrences","metric_semantic_profiles","enterprise_cases","management_channel_actions"]]);
    expect(audited.rows.map(({ resource_type }) => resource_type)).toEqual(["cadence_occurrences","enterprise_cases","management_cadences","management_channel_actions","metric_semantic_profiles"]);
  });

  it("supersedes the previous selected scenario inside one portfolio", async () => {
    const context = createDevelopmentRequestContext("postgres-scenario");
    const create = (name: string, riskScore: number) => service.createScenario(context, PORTFOLIO_ID, { name, assumptions: [`assumption:${name}`], projectDecisions: [{ projectId: DEMO_PROJECT_ID, action: "continue", capacityPercent: 50, rationale: "Evidence-bound allocation" }], expectedBenefit: 100, estimatedCost: 30, riskScore, evidenceRefs: [`evidence:${name}`], status: "recommended" });
    const first = await create("Fast", 10); const second = await create("Safe", 5);
    await service.selectScenario(context, first.id, first.version);
    await service.selectScenario(context, second.id, second.version);
    const scenarios = (await repository.getData(DEMO_TENANT_ID)).scenarios;
    expect(scenarios.filter(({ status }) => status === "selected")).toEqual([expect.objectContaining({ id: second.id })]);
    expect(scenarios.find(({ id }) => id === first.id)).toMatchObject({ status: "superseded", version: 3 });
  });
});
