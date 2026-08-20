// Requirements: MR-001, MR-002, MR-003, MR-004, MR-005, MR-006, MR-007, MR-010, MR-026, MR-027, MR-028, MR-029, MR-030, AR-002, AR-003, AR-004
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { EnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/application/service";
import { PostgresEnterpriseIntelligenceRepository } from "@/src/modules/enterprise-intelligence/infrastructure/postgres-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_OBJECTIVE_ID, DEMO_PROJECT_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const subjectId = "10000000-0000-4000-8000-000000000002";
const themeId = "91000000-0000-4000-8000-000000000001";
const metricId = "92000000-0000-4000-8000-000000000001";
const reviewId = "94000000-0000-4000-8000-000000000001";

describe("Postgres enterprise intelligence repository", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;
  let repository: PostgresEnterpriseIntelligenceRepository;
  let service: EnterpriseIntelligenceService;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of ["0001_foundation.sql","0002_management_loop.sql","0003_agent_platform.sql","0004_connector_platform.sql","0005_workflow_knowledge.sql","0006_strategy_organization_talent.sql"]) {
      await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    }
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) { await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]); return work(executor); },
      async close() { await database.close(); },
    };
    repository = new PostgresEnterpriseIntelligenceRepository(adapter);
    service = new EnterpriseIntelligenceService(repository, new InMemoryEventStore());

    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$3,'Manager','manager@example.test','active'),($2,$3,'Subject','subject@example.test','active')", [DEMO_MANAGER_ID,subjectId,DEMO_TENANT_ID]);
    await database.query("INSERT INTO objectives(id,tenant_id,title,description,owner_id,status,starts_at,ends_at,review_cadence,version) VALUES($1,$2,'按期交付','可核验目标',$3,'at_risk','2026-07-01','2026-09-30','weekly',2)", [DEMO_OBJECTIVE_ID,DEMO_TENANT_ID,DEMO_MANAGER_ID]);
    await database.query("INSERT INTO projects(id,tenant_id,code,name,owner_id,status,priority,starts_at,target_end_at,health) VALUES($1,$2,'P-1','华东上线',$3,'active','critical','2026-07-01','2026-09-30','at_risk')", [DEMO_PROJECT_ID,DEMO_TENANT_ID,DEMO_MANAGER_ID]);
    await database.query("INSERT INTO objective_project_links(tenant_id,objective_id,project_id) VALUES($1,$2,$3)", [DEMO_TENANT_ID,DEMO_OBJECTIVE_ID,DEMO_PROJECT_ID]);
    await database.query("INSERT INTO strategy_themes(id,tenant_id,name,description,owner_id,status,starts_at,ends_at) VALUES($1,$2,'高质量交付','规模与质量并重',$3,'active','2026-01-01','2026-12-31')", [themeId,DEMO_TENANT_ID,DEMO_MANAGER_ID]);
    await database.query("INSERT INTO metric_definitions(id,tenant_id,code,name,description,owner_id,unit,direction,baseline,target_value,tolerance_percent,source_system,source_locator,refresh_cadence,classification) VALUES($1,$2,'DELIVERY','按期交付率','验收口径',$3,'%','increase',82,95,3,'project-ledger','acceptance','weekly','internal')", [metricId,DEMO_TENANT_ID,DEMO_MANAGER_ID]);
    await database.query("INSERT INTO objective_governance_profiles(objective_id,tenant_id,theme_id,objective_type,measurement_method,data_source) VALUES($1,$2,$3,'okr','按期数/应验收数','项目验收台账')", [DEMO_OBJECTIVE_ID,DEMO_TENANT_ID,themeId]);
    await database.query("INSERT INTO objective_metric_links(tenant_id,objective_id,metric_id) VALUES($1,$2,$3)", [DEMO_TENANT_ID,DEMO_OBJECTIVE_ID,metricId]);
    await database.query("INSERT INTO metric_observations(id,tenant_id,metric_id,value,period_start,period_end,observed_at,source_type,source_ref,evidence_refs,recorded_by) VALUES($1,$2,$3,88,'2026-07-28','2026-08-03','2026-08-04T00:00:00Z','authoritative','ledger:W31',$4,$5)", ["92100000-0000-4000-8000-000000000001",DEMO_TENANT_ID,metricId,["acceptance:W31"],DEMO_MANAGER_ID]);
    await database.query("INSERT INTO portfolios(id,tenant_id,code,name,owner_id,status,investment_thesis) VALUES($1,$2,'PF-1','交付组合',$3,'active','优先保障核心客户')", ["93000000-0000-4000-8000-000000000001",DEMO_TENANT_ID,DEMO_MANAGER_ID]);
    await database.query("INSERT INTO portfolio_projects(tenant_id,portfolio_id,project_id) VALUES($1,$2,$3)", [DEMO_TENANT_ID,"93000000-0000-4000-8000-000000000001",DEMO_PROJECT_ID]);
    await database.query("INSERT INTO operating_reviews(id,tenant_id,title,cadence,period_start,period_end,owner_id,status,facts,inferences,decisions,excluded_data_scopes) VALUES($1,$2,'7月经营复盘','monthly','2026-07-01','2026-07-31',$3,'pending_confirmation',$4,$5,$6,$7)", [reviewId,DEMO_TENANT_ID,DEMO_MANAGER_ID,[{ statement: "按期率88%", evidenceRefs: ["ledger:W31"] }],[{ statement: "交付承压", confidence: 0.8, evidenceRefs: ["ledger:W31"] }],["缩小灰度"],["one_to_one"]]);
    await database.query("INSERT INTO responsibility_assignments(id,tenant_id,resource_type,resource_id,subject_type,subject_id,role,starts_at) VALUES($1,$3,'objective',$4,'user',$5,'accountable','2026-07-01'),($2,$3,'objective',$4,'user',$6,'responsible','2026-07-01')", ["95000000-0000-4000-8000-000000000001","95000000-0000-4000-8000-000000000002",DEMO_TENANT_ID,DEMO_OBJECTIVE_ID,DEMO_MANAGER_ID,subjectId]);
    await database.query("INSERT INTO capacity_plans(id,tenant_id,user_id,period_start,period_end,available_hours,allocations,included_signals) VALUES($1,$2,$3,'2026-08-03','2026-08-09',40,$4,$5)", ["96000000-0000-4000-8000-000000000001",DEMO_TENANT_ID,subjectId,[{ resourceType: "project", resourceId: DEMO_PROJECT_ID, allocationPercent: 95 }],["planned_allocation"]]);
    await database.query("INSERT INTO performance_facts(id,tenant_id,subject_user_id,source_type,source_id,statement,evidence_refs,fact_type,effective_at,classification,visible_to_ids) VALUES($1,$2,$3,'project',$4,'完成回归并提交证据',$5,'fact','2026-08-02','confidential',$6)", ["98000000-0000-4000-8000-000000000001",DEMO_TENANT_ID,subjectId,DEMO_PROJECT_ID,["report:1"],[DEMO_MANAGER_ID,subjectId]]);
    await database.query("INSERT INTO talent_records(id,tenant_id,subject_user_id,record_type,content,participant_ids,agent_eligible,classification,effective_at) VALUES($1,$2,$3,'one_to_one','私密记录',$4,false,'restricted','2026-08-01')", ["99000000-0000-4000-8000-000000000001",DEMO_TENANT_ID,subjectId,[DEMO_MANAGER_ID,subjectId]]);
  });

  afterEach(async () => { await database.close(); });

  it("loads a traceable workspace and persists metric and review transitions", async () => {
    const manager = createDevelopmentRequestContext();
    const workspace = await service.workspace(manager);
    expect(workspace.objectives[0]).toMatchObject({ objectiveType: "okr", projectIds: [DEMO_PROJECT_ID], metricIds: [metricId] });
    expect(workspace.capacity[0]).toMatchObject({ utilizationPercent: 95, status: "near_limit" });
    expect(workspace.talent).toMatchObject({ factCount: 1, protectedRecordCount: 1 });
    await service.recordMetricObservation(manager, metricId, { value: 92, periodStart: "2026-08-04", periodEnd: "2026-08-10", observedAt: "2026-08-10T00:00:00.000Z", sourceType: "authoritative", sourceRef: "ledger:W32", evidenceRefs: ["acceptance:W32"] });
    expect((await repository.getData(DEMO_TENANT_ID)).observations).toHaveLength(2);
    expect(await service.confirmReview(manager, reviewId, 1)).toMatchObject({ status: "confirmed", version: 2 });
  });

  it("enforces the database-level single accountable owner constraint", async () => {
    await expect(database.query("INSERT INTO responsibility_assignments(id,tenant_id,resource_type,resource_id,subject_type,subject_id,role,starts_at) VALUES($1,$2,'objective',$3,'user',$4,'accountable','2026-07-02')", [crypto.randomUUID(),DEMO_TENANT_ID,DEMO_OBJECTIVE_ID,subjectId])).rejects.toThrow();
  });
});
