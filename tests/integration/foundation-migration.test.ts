// Requirements: MR-011, MR-012, MR-013, MR-014, MR-015, MR-045, AR-001, AR-002, AR-003, AR-004, AR-006, SR-002, AC-003, AC-011
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "10000000-0000-4000-8000-000000000002";

describe("platform migrations", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    const migrations = ["0001_foundation.sql", "0002_management_loop.sql", "0003_agent_platform.sql", "0004_connector_platform.sql", "0005_workflow_knowledge.sql", "0006_strategy_organization_talent.sql", "0007_client_platform.sql", "0008_security_hardening.sql", "0009_atomic_audit.sql", "0010_immutable_audit.sql", "0011_enterprise_governance.sql", "0012_enterprise_acceptance.sql", "0013_connector_test_notifications.sql", "0014_durable_runtime.sql", "0015_agent_job_control.sql", "0016_management_intelligence.sql", "0017_work_command_center.sql", "0018_work_message_pools.sql", "0019_work_task_handoffs.sql", "0020_wecom_access_control_permissions.sql", "0021_wecom_application_message_permission.sql", "0022_agent_memory.sql", "0023_work_artifact_evidence_chain.sql"];
    for (const file of migrations) {
      await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    }
    await database.exec("CREATE ROLE nexus_app NOLOGIN; GRANT USAGE ON SCHEMA public TO nexus_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexus_app;");
  });

  afterEach(async () => {
    await database.close();
  });

  it("creates the required foundation tables and tenant policies", async () => {
    const tables = await database.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = tables.rows.map(({ table_name }) => table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "tenants",
        "users",
        "org_units",
        "roles",
        "audit_events",
        "outbox_events",
        "inbox_events",
        "agent_runs",
        "tool_calls",
        "objectives",
        "key_results",
        "projects",
        "milestones",
        "tasks",
        "risks",
        "decisions",
        "action_items",
        "agent_context_refs",
        "agent_citations",
        "agent_proposals",
        "agent_evaluations",
        "agent_tool_jobs",
        "agent_job_resolutions",
        "domain_event_publications",
        "worker_heartbeats",
        "client_devices",
        "client_push_subscriptions",
        "connection_installation_checks",
        "connector_deliveries",
        "connector_sync_cursors",
        "channel_preferences",
        "webhook_replay_claims",
        "enterprise_acceptance_runs",
        "connector_test_notification_proposals",
        "process_definitions",
        "process_definition_versions",
        "process_instances",
        "approvals",
        "meeting_records",
        "documents",
        "document_versions",
        "knowledge_items",
        "strategy_themes",
        "metric_definitions",
        "objective_governance_profiles",
        "objective_metric_links",
        "metric_observations",
        "portfolios",
        "portfolio_projects",
        "operating_reviews",
        "responsibility_assignments",
        "capacity_plans",
        "performance_facts",
        "talent_records",
        "management_cadences",
        "cadence_occurrences",
        "metric_semantic_profiles",
        "metric_quality_checks",
        "portfolio_scenarios",
        "enterprise_cases",
        "ai_governance_evaluations",
        "management_channel_actions",
        "work_conversations",
        "work_conversation_messages",
        "work_missions",
        "work_packages",
        "work_task_events",
        "work_pool_messages",
        "work_pool_feedback",
        "work_message_events",
        "work_task_handoffs",
        "agent_memory_entries",
      ]),
    );
    const policies = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_policies");
    expect(Number(policies.rows[0].count)).toBeGreaterThanOrEqual(78);
  });

  it("forces tenant isolation and atomic audit on every work-command table", async () => {
    const tableNames = ["work_conversations","work_conversation_messages","work_missions","work_packages","work_task_events","work_pool_messages","work_pool_feedback","work_message_events","work_task_handoffs"];
    const controls = await database.query<{ table_name: string; forced: boolean; policy_count: number; audited: boolean }>(
      `SELECT c.relname AS table_name,c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policy_count,
        EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='nexus_atomic_audit' AND NOT t.tgisinternal) AS audited
       FROM pg_class c WHERE c.relname = ANY($1::text[]) ORDER BY c.relname`, [tableNames],
    );
    expect(controls.rows).toHaveLength(tableNames.length);
    expect(controls.rows.every((row) => row.forced && Number(row.policy_count) >= 2 && row.audited)).toBe(true);
  });

  it("forces tenant isolation and atomic audit on durable Agent memory", async () => {
    const controls = await database.query<{ forced: boolean; policy_count: number; audited: boolean }>(
      `SELECT c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policy_count,
        EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='nexus_atomic_audit' AND NOT t.tgisinternal) AS audited
       FROM pg_class c WHERE c.relname='agent_memory_entries'`,
    );
    expect(controls.rows[0]).toMatchObject({ forced: true, audited: true });
    expect(Number(controls.rows[0].policy_count)).toBeGreaterThanOrEqual(3);
  });

  it("forces tenant isolation and atomic audit on every management-intelligence table", async () => {
    const tableNames = ["management_cadences","cadence_occurrences","metric_semantic_profiles","metric_quality_checks","portfolio_scenarios","enterprise_cases","ai_governance_evaluations","management_channel_actions"];
    const controls = await database.query<{ table_name: string; forced: boolean; policy_count: number; audited: boolean }>(
      `SELECT c.relname AS table_name,c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policy_count,
        EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='nexus_atomic_audit' AND NOT t.tgisinternal) AS audited
       FROM pg_class c WHERE c.relname = ANY($1::text[]) ORDER BY c.relname`, [tableNames],
    );
    expect(controls.rows).toHaveLength(tableNames.length);
    expect(controls.rows.every((row) => row.forced && Number(row.policy_count) >= 3 && row.audited)).toBe(true);

    await database.exec("SET ROLE nexus_app");
    await database.query("INSERT INTO tenants(id, slug, name, status) VALUES ($1, 'a', 'A', 'active'), ($2, 'b', 'B', 'active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_A]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'A User','a@example.test','active')", [USER_A,TENANT_A]);
    await database.query(`INSERT INTO management_cadences(id,tenant_id,name,cadence_type,frequency,timezone,owner_id,participant_role_ids,agenda_template,evidence_requirements,status,next_occurrence_at)
      VALUES($1,$2,'Weekly Ops','weekly_operations','weekly','Asia/Shanghai',$3,'["pmo"]','["facts"]','["minutes"]','active','2026-08-07T01:00:00Z')`, [crypto.randomUUID(),TENANT_A,USER_A]);
    expect((await database.query("SELECT id FROM management_cadences")).rows).toHaveLength(1);
    expect((await database.query("SELECT resource_type FROM audit_events WHERE resource_type='management_cadences'")).rows).toHaveLength(1);
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_B]);
    expect((await database.query("SELECT id FROM management_cadences")).rows).toHaveLength(0);
  });

  it("enforces tenant row isolation at the database layer", async () => {
    await database.exec("SET ROLE nexus_app");
    await database.query("INSERT INTO tenants(id, slug, name, status) VALUES ($1, 'a', 'A', 'active'), ($2, 'b', 'B', 'active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_A]);
    await database.query(
      "INSERT INTO users(id, tenant_id, display_name, email, status) VALUES ($1, $2, 'A User', 'a@example.test', 'active')",
      [USER_A, TENANT_A],
    );
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_B]);
    await database.query(
      "INSERT INTO users(id, tenant_id, display_name, email, status) VALUES ($1, $2, 'B User', 'b@example.test', 'active')",
      [USER_B, TENANT_B],
    );
    const visible = await database.query<{ id: string }>("SELECT id::text FROM users ORDER BY id");
    expect(visible.rows).toEqual([{ id: USER_B }]);
  });

  it("rejects a cross-tenant insert under the active tenant context", async () => {
    await database.exec("SET ROLE nexus_app");
    await database.query("INSERT INTO tenants(id, slug, name, status) VALUES ($1, 'a', 'A', 'active'), ($2, 'b', 'B', 'active')", [TENANT_A, TENANT_B]);
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_A]);
    await expect(
      database.query(
        "INSERT INTO users(id, tenant_id, display_name, email, status) VALUES ($1, $2, 'Wrong', 'wrong@example.test', 'active')",
        [USER_B, TENANT_B],
      ),
    ).rejects.toThrow();
  });

  it("keeps inbound events unique for at-least-once delivery", async () => {
    await database.exec("SET ROLE nexus_app");
    const connection = "20000000-0000-4000-8000-000000000001";
    await database.query("INSERT INTO tenants(id, slug, name, status) VALUES ($1, 'a', 'A', 'active')", [TENANT_A]);
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_A]);
    await database.query(
      "INSERT INTO connections(id, tenant_id, provider, name, status, secret_ref) VALUES ($1, $2, 'feishu', 'test', 'active', 'secret://test')",
      [connection, TENANT_A],
    );
    const insert = () =>
      database.query(
        "INSERT INTO inbox_events(id, tenant_id, provider, connection_id, external_event_id, event_type, raw_digest, payload, status, trace_id) VALUES ($1, $2, 'feishu', $3, 'event-1', 'message.received', $4, '{}', 'received', 'trace-1')",
        [crypto.randomUUID(), TENANT_A, connection, "0".repeat(64)],
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it("isolates projects and risks by tenant and calculates exposure", async () => {
    await database.exec("SET ROLE nexus_app");
    await database.query("INSERT INTO tenants(id, slug, name, status) VALUES ($1, 'a', 'A', 'active'), ($2, 'b', 'B', 'active')", [TENANT_A, TENANT_B]);

    await database.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_A]);
    await database.query(
      "INSERT INTO users(id, tenant_id, display_name, email, status) VALUES ($1, $2, 'A User', 'a@example.test', 'active')",
      [USER_A, TENANT_A],
    );
    const projectA = "30000000-0000-4000-8000-000000000001";
    await database.query(
      "INSERT INTO projects(id, tenant_id, code, name, owner_id, status, priority, starts_at, target_end_at, health, business_value, acceptance_criteria, resource_plan) VALUES ($1, $2, 'A-1', 'Project A', $3, 'active', 'high', '2026-08-01', '2026-09-01', 'watch', 'Deliver customer outcome', 'Signed acceptance', '{}')",
      [projectA, TENANT_A, USER_A],
    );
    await database.query(
      "INSERT INTO risks(id, tenant_id, project_id, title, description, owner_id, probability, impact, status, source_type) VALUES ($1, $2, $3, 'Delay', 'Integration delay', $4, 4, 5, 'assessed', 'human')",
      ["50000000-0000-4000-8000-000000000001", TENANT_A, projectA, USER_A],
    );
    const exposure = await database.query<{ exposure: number }>("SELECT exposure FROM risks");
    expect(exposure.rows).toEqual([{ exposure: 20 }]);

    await database.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_B]);
    const hiddenProjects = await database.query("SELECT id FROM projects");
    const hiddenRisks = await database.query("SELECT id FROM risks");
    expect(hiddenProjects.rows).toHaveLength(0);
    expect(hiddenRisks.rows).toHaveLength(0);
  });

  it("enforces management state and date constraints", async () => {
    await database.exec("SET ROLE nexus_app");
    await database.query("INSERT INTO tenants(id, slug, name, status) VALUES ($1, 'a', 'A', 'active')", [TENANT_A]);
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_A]);
    await database.query(
      "INSERT INTO users(id, tenant_id, display_name, email, status) VALUES ($1, $2, 'A User', 'a@example.test', 'active')",
      [USER_A, TENANT_A],
    );
    await expect(
      database.query(
        "INSERT INTO projects(id, tenant_id, code, name, owner_id, status, priority, starts_at, target_end_at, health, business_value, acceptance_criteria, resource_plan) VALUES ($1, $2, 'BAD', 'Invalid', $3, 'active', 'urgent', '2026-09-01', '2026-08-01', 'healthy', 'Value', 'Acceptance', '{}')",
        ["30000000-0000-4000-8000-000000000009", TENANT_A, USER_A],
      ),
    ).rejects.toThrow();
  });
});
